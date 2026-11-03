//! zec-watcher: sees incoming shielded (Orchard) ZEC payments using an incoming viewing key only.
//! Mainnet by default (ZCASH_NETWORK=test for testnet). Listens on loopback; the Node server is its only client.
//!
//! Issued addresses are saved to WATCHER_STATE (default watcher-state-<net>.json) and re-tracked on
//! startup, rescanning from the oldest saved address, so a restart doesn't forget in-flight orders.
//! Reorg handling is limited to re-deriving confirmations from the current tip.

use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use orchard::{
    keys::{PreparedIncomingViewingKey, Scope},
    note_encryption::{CompactAction, IronwoodDomain, OrchardDomain},
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio_stream::StreamExt;
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::{
    compact_formats::{CompactOrchardAction, CompactTx},
    service::{
        compact_tx_streamer_client::CompactTxStreamerClient, BlockId, BlockRange, ChainSpec,
        GetMempoolTxRequest,
    },
};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey};
use zcash_note_encryption::try_compact_note_decryption;
use zcash_protocol::consensus::Network;

type Raw = [u8; 43];

#[derive(Default)]
struct Tracked {
    /// (txid, action index) -> (zats, mined height)
    notes: HashMap<(Vec<u8>, usize), (u64, Option<u64>)>,
}

/// An issued address, enough to re-derive it after a restart.
#[derive(Serialize, Deserialize, Clone)]
struct Saved {
    idx: String, // 11-byte diversifier index, hex
    address: String,
    since: u64, // chain tip when issued
}

/// Addresses older than this many blocks (~31h, far beyond the 10 min quote) are dropped.
const KEEP_BLOCKS: u64 = 1500;

struct Inner {
    state_path: String,
    saved: Mutex<Vec<Saved>>,
    net: Network,
    ufvk: UnifiedFullViewingKey,
    ivk: PreparedIncomingViewingKey,
    /// raw orchard address -> (encoded UA, received notes)
    tracked: Mutex<HashMap<Raw, (String, Tracked)>>,
    tip: Mutex<u64>,
}
type Shared = Arc<Inner>;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<[u8; 11]> {
    let v: Option<Vec<u8>> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect();
    v?.try_into().ok()
}

fn derive(ufvk: &UnifiedFullViewingKey, net: &Network, idx: [u8; 11]) -> Result<(Raw, String)> {
    let (ua, _) = ufvk
        .find_address(zip32::DiversifierIndex::from(idx), UnifiedAddressRequest::ORCHARD)
        .map_err(|e| anyhow!("{e:?}"))?;
    let raw = ua.orchard().ok_or_else(|| anyhow!("no orchard receiver"))?.to_raw_address_bytes();
    Ok((raw, ua.encode(net)))
}

fn save(path: &str, v: &[Saved]) {
    let tmp = format!("{path}.tmp");
    let ok = serde_json::to_vec(v).ok().is_some_and(|b| std::fs::write(&tmp, b).is_ok() && std::fs::rename(&tmp, path).is_ok());
    if !ok {
        eprintln!("warning: could not save {path}");
    }
}

fn random_index() -> Result<[u8; 11]> {
    use std::io::Read;
    let mut b = [0u8; 11];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut b)?;
    Ok(b)
}

#[derive(Serialize)]
struct NewAddr {
    address: String,
}

async fn new_address(State(s): State<Shared>) -> Result<Json<NewAddr>, (StatusCode, String)> {
    let fail = |e: anyhow::Error| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    let idx = random_index().map_err(fail)?;
    let (raw, enc) = derive(&s.ufvk, &s.net, idx).map_err(fail)?;
    s.tracked.lock().await.insert(raw, (enc.clone(), Tracked::default()));
    let tip = *s.tip.lock().await;
    let mut saved = s.saved.lock().await;
    saved.retain(|a| a.since + KEEP_BLOCKS >= tip);
    saved.push(Saved { idx: hex(&idx), address: enc.clone(), since: tip.saturating_sub(2) });
    save(&s.state_path, &saved);
    Ok(Json(NewAddr { address: enc }))
}

#[derive(Deserialize)]
struct Q {
    address: String,
}

#[derive(Serialize)]
struct Status {
    #[serde(rename = "receivedZec")]
    received_zec: f64,
    confirmations: Option<u64>,
}

async fn status(State(s): State<Shared>, Query(q): Query<Q>) -> Result<Json<Status>, StatusCode> {
    let tip = *s.tip.lock().await;
    let t = s.tracked.lock().await;
    let (_, tr) = t.values().find(|(a, _)| *a == q.address).ok_or(StatusCode::NOT_FOUND)?;
    let zats: u64 = tr.notes.values().map(|(v, _)| *v).sum();
    let conf = tr
        .notes
        .values()
        .map(|(_, h)| h.map_or(0, |h| tip.saturating_sub(h) + 1))
        .min();
    Ok(Json(Status { received_zec: zats as f64 / 1e8, confirmations: conf }))
}

fn to_action(a: &CompactOrchardAction) -> Option<CompactAction> {
    Some(CompactAction::from_parts(
        a.nf().ok()?,
        a.cmx().ok()?,
        a.ephemeral_key().ok()?,
        a.ciphertext.as_slice().try_into().ok()?,
    ))
}

async fn absorb(s: &Shared, tx: &CompactTx, height: Option<u64>) {
    let mut t = s.tracked.lock().await;
    // Orchard and Ironwood share keys and addresses but use different note-encryption domains.
    // Current wallets may pay an Orchard receiver through either pool, so scan both.
    for (pool, actions) in [(0usize, &tx.actions), (1usize, &tx.ironwood_actions)] {
        for (i, a) in actions.iter().enumerate() {
            let Some(action) = to_action(a) else { continue };
            let found = if pool == 0 {
                try_compact_note_decryption(&OrchardDomain::for_compact_action(&action), &s.ivk, &action)
            } else {
                try_compact_note_decryption(&IronwoodDomain::for_compact_action(&action), &s.ivk, &action)
            };
            if let Some((note, addr)) = found {
                if let Some((_, tr)) = t.get_mut(&addr.to_raw_address_bytes()) {
                    tr.notes.insert((tx.txid.clone(), pool * 1_000_000 + i), (note.value().inner(), height));
                }
            }
        }
    }
}

/// `last` lives outside so a reconnect resumes from the last scanned block instead of skipping ahead.
async fn scan_loop(s: Shared, mut c: CompactTxStreamerClient<Channel>, last: &mut u64) -> Result<()> {
    let t = c.get_latest_block(ChainSpec {}).await?.into_inner().height;
    *s.tip.lock().await = t;
    if *last == 0 {
        *last = t;
    }
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let tip = c.get_latest_block(ChainSpec {}).await?.into_inner().height;
        if tip > *last {
            let range = BlockRange {
                start: Some(BlockId { height: *last + 1, hash: vec![] }),
                end: Some(BlockId { height: tip, hash: vec![] }),
                pool_types: vec![],
            };
            let mut st = c.get_block_range(range).await?.into_inner();
            while let Some(b) = st.next().await {
                let b = b?;
                for tx in &b.vtx {
                    absorb(&s, tx, Some(b.height)).await;
                }
                *last = b.height; // keep progress even if the stream dies mid-range
            }
            *last = tip;
        }
        *s.tip.lock().await = tip;
        let mut mp = c
            .get_mempool_tx(GetMempoolTxRequest { exclude_txid_suffixes: vec![], pool_types: vec![] })
            .await?
            .into_inner();
        while let Some(tx) = mp.next().await {
            absorb(&s, &tx?, None).await;
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| anyhow!("crypto provider already installed"))?;
    // ZCASH_NETWORK=main (default) | test. The key prefix must match, so a testnet key can't run on mainnet.
    let (net, prefix) = match std::env::var("ZCASH_NETWORK").unwrap_or_else(|_| "main".into()).as_str() {
        "main" => (Network::MainNetwork, "uview1"),
        "test" => (Network::TestNetwork, "uviewtest1"),
        other => return Err(anyhow!("ZCASH_NETWORK must be main or test, got {other}")),
    };
    let ufvk_s = std::env::var("ZCASH_UFVK").context("ZCASH_UFVK required")?;
    if !ufvk_s.starts_with(prefix) {
        return Err(anyhow!("ZCASH_UFVK must start with {prefix} for network {net:?}"));
    }
    let ufvk = UnifiedFullViewingKey::decode(&net, &ufvk_s).map_err(|e| anyhow!("bad UFVK: {e}"))?;
    let ivk = PreparedIncomingViewingKey::new(
        &ufvk.orchard().ok_or_else(|| anyhow!("UFVK has no Orchard component"))?.to_ivk(Scope::External),
    );

    let url = std::env::var("ZCASH_LIGHTWALLETD").context("ZCASH_LIGHTWALLETD required")?;
    let connect = move || {
        let url = url.clone();
        async move {
            let ch = Channel::from_shared(url)?
                .tls_config(ClientTlsConfig::new().with_webpki_roots())?
                .connect_timeout(Duration::from_secs(15))
                .timeout(Duration::from_secs(60))
                .tcp_keepalive(Some(Duration::from_secs(20)))
                .http2_keep_alive_interval(Duration::from_secs(15))
                .keep_alive_timeout(Duration::from_secs(10))
                .keep_alive_while_idle(true)
                .connect()
                .await?;
            Ok::<_, anyhow::Error>(CompactTxStreamerClient::new(ch))
        }
    };

    let state_path = std::env::var("WATCHER_STATE").unwrap_or_else(|_| {
        format!("watcher-state-{}.json", if matches!(net, Network::MainNetwork) { "main" } else { "test" })
    });
    let mut tracked = HashMap::new();
    let mut saved: Vec<Saved> = std::fs::read(&state_path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let tip_now = connect().await?.get_latest_block(ChainSpec {}).await?.into_inner().height;
    saved.retain(|a| a.since + KEEP_BLOCKS >= tip_now);
    let mut resume = 0u64;
    for a in &saved {
        let Some(idx) = unhex(&a.idx) else { continue };
        if let Ok((raw, enc)) = derive(&ufvk, &net, idx) {
            tracked.insert(raw, (enc, Tracked::default()));
            resume = if resume == 0 { a.since } else { resume.min(a.since) };
        }
    }
    if resume > 0 {
        println!("restored {} tracked address(es); rescanning from block {resume}", tracked.len());
    }
    let state: Shared = Arc::new(Inner {
        state_path, saved: Mutex::new(saved), net, ufvk, ivk, tracked: Mutex::new(tracked), tip: Mutex::default(),
    });
    let s2 = state.clone();
    tokio::spawn(async move {
        let mut last = resume;
        loop {
            match connect().await {
                Ok(c) => {
                    if let Err(e) = scan_loop(s2.clone(), c, &mut last).await {
                        eprintln!("scan error: {e:#}; reconnecting from block {last}");
                    }
                }
                Err(e) => eprintln!("connect error: {e:#}; retrying"),
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    let app = Router::new()
        .route("/address", post(new_address))
        .route("/status", get(status))
        .with_state(state);
    let addr: SocketAddr =
        std::env::var("WATCHER_ADDR").unwrap_or_else(|_| "127.0.0.1:8788".into()).parse()?;
    println!("zec-watcher on {addr}");
    axum::serve(tokio::net::TcpListener::bind(addr).await?, app).await?;
    Ok(())
}
