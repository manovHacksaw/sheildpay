/** ZIP-321 payment request URI (mainnet unified or sapling/transparent address). */
export function zip321(address: string, zec: number, memo?: string): string {
  if (!/^(u1|zs1|t1|t3)[a-z0-9]+$/i.test(address)) throw new Error("not a Zcash mainnet address");
  if (!(zec > 0)) throw new Error("amount must be positive");
  const amount = zec.toFixed(8).replace(/\.?0+$/, "");
  let uri = `zcash:${address}?amount=${amount}`;
  if (memo) {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(memo)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    uri += `&memo=${b64}`;
  }
  return uri;
}
