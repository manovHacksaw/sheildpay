// External rails that need real infrastructure. They fail closed rather than fake success.

export interface PaymentWatcher {
  /** Derive a fresh Orchard-only diversified unified address for this order. */
  newAddress(): Promise<string>;
  /** Resolves current state of funds received at `address`. */
  status(address: string): Promise<{ receivedZec: number; confirmations: number | null }>;
}

const WATCHER = process.env.WATCHER_URL ?? "http://127.0.0.1:8788";

// Talks to the zec-watcher sidecar (Rust, incoming viewing key only).
export const watcher: PaymentWatcher = {
  async newAddress() {
    const r = await fetch(`${WATCHER}/address`, { method: "POST" });
    if (!r.ok) throw new Error(`watcher: ${r.status}`);
    return ((await r.json()) as { address: string }).address;
  },
  async status(address) {
    const r = await fetch(`${WATCHER}/status?address=${encodeURIComponent(address)}`);
    if (!r.ok) throw new Error(`watcher: ${r.status}`);
    return (await r.json()) as { receivedZec: number; confirmations: number | null };
  },
};

export async function zecUsd(): Promise<number> {
  const sources = [
    "https://api.coinbase.com/v2/prices/ZEC-USD/spot",
    "https://api.kraken.com/0/public/Ticker?pair=ZECUSD",
  ];
  const [a, b] = await Promise.all(sources.map((u) => fetch(u).then((r) => r.json())));
  const prices = [Number(a?.data?.amount), Number(Object.values(b?.result ?? {}).map((x: any) => x.c?.[0])[0])].filter((n) => n > 0);
  if (!prices.length) throw new Error("no ZEC price available");
  return prices.reduce((x, y) => x + y) / prices.length;
}
