// Prints a freshly generated mainnet UFVK from a random seed (for testing the watcher only).
use zcash_keys::keys::UnifiedSpendingKey;
use zcash_protocol::consensus::MainNetwork;
use std::io::Read;
fn main() {
    let mut seed = [0u8; 32];
    std::fs::File::open("/dev/urandom").unwrap().read_exact(&mut seed).unwrap();
    let usk = UnifiedSpendingKey::from_seed(&MainNetwork, &seed, zip32::AccountId::ZERO).unwrap();
    println!("{}", usk.to_unified_full_viewing_key().encode(&MainNetwork).unwrap());
}
