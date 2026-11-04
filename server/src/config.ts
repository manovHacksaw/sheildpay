const need = ["BITREFILL_API_KEY", "ZCASH_UFVK", "ZCASH_LIGHTWALLETD"] as const;

export const missing = need.filter((k) => !process.env[k]);
export const cfg = {
  bitrefillKey: process.env.BITREFILL_API_KEY ?? "",
  perOrderCapUsd: Number(process.env.PER_ORDER_CAP_USD ?? 100),
  dailyCapUsd: Number(process.env.DAILY_CAP_USD ?? 500),
  port: Number(process.env.PORT ?? 8787),
  quoteTtlMs: 10 * 60_000,
  slippage: 0.01,
  feePct: Number(process.env.FEE_PCT ?? 0.025),
  feeMinUsd: Number(process.env.FEE_MIN_USD ?? 0.1),
  // Demo only: sell REAL cards (paid from the Bitrefill balance) against free testnet ZEC. Anyone who can reach
  // the server could drain the balance, so this mode also binds the server to loopback (see index.ts).
  testnetRealPurchases: process.env.ZCASH_NETWORK === "test" && process.env.TESTNET_REAL_PURCHASES === "1",
};
