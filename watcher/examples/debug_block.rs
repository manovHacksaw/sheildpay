// usage: debug_block <height> <order-address>   (env: ZCASH_UFVK, ZCASH_LIGHTWALLETD)
use orchard::{keys::{PreparedIncomingViewingKey, Scope}, note_encryption::{CompactAction, IronwoodDomain, OrchardDomain}};
use tokio_stream::StreamExt;
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::service::{compact_tx_streamer_client::CompactTxStreamerClient, BlockId, BlockRange};
use zcash_keys::{address::Address, keys::UnifiedFullViewingKey};
use zcash_note_encryption::try_compact_note_decryption;
use zcash_protocol::consensus::Network;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::ring::default_provider().install_default().ok();
    let net = if std::env::var("ZCASH_NETWORK").as_deref() == Ok("test") { Network::TestNetwork } else { Network::MainNetwork };
    let h: u64 = std::env::args().nth(1).unwrap().parse()?;
    let want = match Address::decode(&net, &std::env::args().nth(2).unwrap()) {
        Some(Address::Unified(ua)) => ua.orchard().map(|a| a.to_raw_address_bytes()),
        _ => None,
    };
    let ufvk = UnifiedFullViewingKey::decode(&net, &std::env::var("ZCASH_UFVK")?).unwrap();
    let ivk = PreparedIncomingViewingKey::new(&ufvk.orchard().unwrap().to_ivk(Scope::External));
    let ch = Channel::from_shared(std::env::var("ZCASH_LIGHTWALLETD")?)?.tls_config(ClientTlsConfig::new().with_webpki_roots())?.connect().await?;
    let mut c = CompactTxStreamerClient::new(ch);
    let r = BlockRange { start: Some(BlockId { height: h, hash: vec![] }), end: Some(BlockId { height: h, hash: vec![] }), pool_types: vec![] };
    let mut st = c.get_block_range(r).await?.into_inner();
    while let Some(b) = st.next().await {
        let b = b?;
        println!("block {} txs {}", b.height, b.vtx.len());
        for tx in &b.vtx {
            println!("  tx {} orchard_actions {} ironwood_actions {} sapling_outputs {}", hex(&tx.txid), tx.actions.len(), tx.ironwood_actions.len(), tx.outputs.len());
            for (i, a) in tx.ironwood_actions.iter().enumerate() {
                let act = (|| Some(CompactAction::from_parts(a.nf().ok()?, a.cmx().ok()?, a.ephemeral_key().ok()?, a.ciphertext.as_slice().try_into().ok()?)))();
                let Some(act) = act else { println!("  ironwood action {i}: unparsable (len {})", a.ciphertext.len()); continue };
                let d = IronwoodDomain::for_compact_action(&act);
                if let Some((note, addr)) = try_compact_note_decryption(&d, &ivk, &act) {
                    println!("  MINE(ironwood) action {i}: {} zats, matches order address: {}", note.value().inner(), want == Some(addr.to_raw_address_bytes()));
                }
            }
            for (i, a) in tx.actions.iter().enumerate() {
                let len = a.ciphertext.len();
                let act = (|| Some(CompactAction::from_parts(a.nf().ok()?, a.cmx().ok()?, a.ephemeral_key().ok()?, a.ciphertext.as_slice().try_into().ok()?)))();
                let Some(act) = act else { println!("  tx {} action {i}: unparsable (ciphertext len {len})", hex(&tx.txid)); continue };
                let d = OrchardDomain::for_compact_action(&act);
                if let Some((note, addr)) = try_compact_note_decryption(&d, &ivk, &act) {
                    println!("  MINE tx {} action {i}: {} zats, matches order address: {}", hex(&tx.txid), note.value().inner(), want == Some(addr.to_raw_address_bytes()));
                }
            }
        }
    }
    Ok(())
}
fn hex(b: &[u8]) -> String { b.iter().rev().map(|x| format!("{x:02x}")).collect() }
