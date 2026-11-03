// Generates a new mainnet wallet: writes the 24-word seed phrase to the path in argv[1]
// (never printed) and prints only the UFVK.
use bip39::Mnemonic;
use std::{io::Write, os::unix::fs::OpenOptionsExt};
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::consensus::Network;

fn main() {
    let path = std::env::args().nth(1).expect("path");
    let net = if std::env::args().nth(2).as_deref() == Some("test") { Network::TestNetwork } else { Network::MainNetwork };
    let m = Mnemonic::generate(24).unwrap();
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).unwrap();
    writeln!(f, "{m}").unwrap();
    let usk = UnifiedSpendingKey::from_seed(&net, &m.to_seed(""), zip32::AccountId::ZERO).unwrap();
    println!("{}", usk.to_unified_full_viewing_key().encode(&net).unwrap());
}
