const TEST = process.env.ZCASH_NETWORK === "test";
// Mainnet and testnet addresses are kept strictly apart so a mixed-up config can't send real funds to a test address.
const PATTERN = TEST ? /^(utest1|ztestsapling1|tm|t2)[a-z0-9]+$/i : /^(u1|zs1|t1|t3)[a-z0-9]+$/i;

export function zip321(address: string, zec: number, memo?: string): string {
  if (!PATTERN.test(address)) throw new Error(`not a Zcash ${TEST ? "testnet" : "mainnet"} address`);
  const amount = zec.toFixed(8).replace(/\.?0+$/, "");
  return `zcash:${address}?amount=${amount}` + (memo ? `&memo=${Buffer.from(memo).toString("base64url")}` : "");
}
