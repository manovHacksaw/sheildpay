// usage: balance <from-height>   (env: ZCASH_UFVK, ZCASH_LIGHTWALLETD). Sums notes received (External scope), both pools.
use orchard::{keys::{PreparedIncomingViewingKey, Scope}, note_encryption::{CompactAction, IronwoodDomain, OrchardDomain}};
use tokio_stream::StreamExt;
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::service::{compact_tx_streamer_client::CompactTxStreamerClient, BlockId, BlockRange, ChainSpec};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_note_encryption::try_compact_note_decryption;
use zcash_protocol::consensus::Network;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::ring::default_provider().install_default().ok();
    let net = if std::env::var("ZCASH_NETWORK").as_deref() == Ok("test") { Network::TestNetwork } else { Network::MainNetwork };
    let from: u64 = std::env::args().nth(1).unwrap().parse()?;
    let ufvk = UnifiedFullViewingKey::decode(&net, &std::env::var("ZCASH_UFVK")?).unwrap();
    let ivk = PreparedIncomingViewingKey::new(&ufvk.orchard().unwrap().to_ivk(Scope::External));
    let ch = Channel::from_shared(std::env::var("ZCASH_LIGHTWALLETD")?)?.tls_config(ClientTlsConfig::new().with_webpki_roots())?.connect().await?;
    let mut c = CompactTxStreamerClient::new(ch);
    let tip = c.get_latest_block(ChainSpec {}).await?.into_inner().height;
    let r = BlockRange { start: Some(BlockId { height: from, hash: vec![] }), end: Some(BlockId { height: tip, hash: vec![] }), pool_types: vec![] };
    let mut st = c.get_block_range(r).await?.into_inner();
    let (mut total, mut n) = (0u64, 0);
    while let Some(b) = st.next().await {
        let b = b?;
        for tx in &b.vtx {
            for (pool, acts) in [("orchard", &tx.actions), ("ironwood", &tx.ironwood_actions)] {
                for a in acts.iter() {
                    let Some(act) = (|| Some(CompactAction::from_parts(a.nf().ok()?, a.cmx().ok()?, a.ephemeral_key().ok()?, a.ciphertext.as_slice().try_into().ok()?)))() else { continue };
                    let f = if pool == "orchard" { try_compact_note_decryption(&OrchardDomain::for_compact_action(&act), &ivk, &act) }
                            else { try_compact_note_decryption(&IronwoodDomain::for_compact_action(&act), &ivk, &act) };
                    if let Some((note, _)) = f {
                        let v = note.value().inner();
                        total += v; n += 1;
                        println!("block {} {pool}: +{:.8} ZEC (tx {})", b.height, v as f64 / 1e8, tx.txid.iter().rev().map(|x| format!("{x:02x}")).collect::<String>());
                    }
                }
            }
        }
    }
    println!("scanned {from}..={tip}: {n} notes, total received {:.8} ZEC (spends not tracked; wallet has never spent)", total as f64 / 1e8);
    Ok(())
}
