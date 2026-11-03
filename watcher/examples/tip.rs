use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::service::{compact_tx_streamer_client::CompactTxStreamerClient, ChainSpec, Empty};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rustls::crypto::ring::default_provider().install_default().ok();
    let ch = Channel::from_shared(std::env::args().nth(1).unwrap())?.tls_config(ClientTlsConfig::new().with_webpki_roots())?.connect().await?;
    let mut c = CompactTxStreamerClient::new(ch);
    let i = c.get_lightd_info(Empty {}).await?.into_inner();
    println!("chain={} height={} version={}", i.chain_name, i.block_height, i.version);
    println!("tip={}", c.get_latest_block(ChainSpec {}).await?.into_inner().height);
    Ok(())
}
