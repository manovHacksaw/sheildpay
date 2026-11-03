import { cfg } from "./config.js";

// Bitrefill REST v2. Verified live: auth, /products/search, /products/{id}.
// NOT verified (spends money): POST /invoices body and invoice status/redemption fields.
const BASE = "https://api.bitrefill.com/v2";
const auth = () => `Bearer ${cfg.bitrefillKey}`; // verified: bearer key works on /ping and /products

async function br<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { ...init, headers: { authorization: auth(), "content-type": "application/json", ...init?.headers } });
  if (!res.ok) throw new Error(`bitrefill ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface Product { id: string; name: string; currency: string; in_stock?: boolean; packages: { id: string; value: string; price: number }[] }

// Merchant hostname -> Bitrefill product id (USD catalog). Only merchants whose cards redeem on their own site.
export const MERCHANTS: Record<string, { slug: string; redeem: "web" | "copy" }> = {
  // India (INR). redeem "web": code field on the merchant's site; "copy": voucher is redeemed in the merchant's app.
  "www.flipkart.com": { slug: "flipkart-india", redeem: "web" },
  "www.myntra.com": { slug: "myntra-india", redeem: "web" },
  "www.nykaa.com": { slug: "nykaa-india", redeem: "web" },
  "www.ajio.com": { slug: "ajio-india", redeem: "web" },
  "www.bigbasket.com": { slug: "bigbasket-india", redeem: "web" },
  "blinkit.com": { slug: "blink-it-india", redeem: "web" },
  "www.zomato.com": { slug: "zomato-india", redeem: "web" },
  "www.swiggy.com": { slug: "swiggy-money-india", redeem: "copy" },
  "www.makemytrip.com": { slug: "makemytrip-voucher-india", redeem: "web" },
  "www.cleartrip.com": { slug: "cleartrip-voucher-india", redeem: "web" },
  "www.easemytrip.com": { slug: "ease-my-trip-india", redeem: "web" },
  "www.yatra.com": { slug: "yatra-india", redeem: "web" },
  "www.croma.com": { slug: "croma-voucher-india", redeem: "web" },
  "www.decathlon.in": { slug: "decathlon-india", redeem: "web" },
  "www.tatacliq.com": { slug: "tata-cliq-fashion-india", redeem: "web" },
  "www.shoppersstop.com": { slug: "shoppers-stop-voucher-india", redeem: "web" },
  "www.pantaloons.com": { slug: "pantaloons-voucher-india", redeem: "web" },
  "www.lifestylestores.com": { slug: "lifestyle-online-india", redeem: "web" },
  "in.bookmyshow.com": { slug: "bookmyshow-voucher-india", redeem: "web" },
  "www.dominos.co.in": { slug: "dominos-india", redeem: "web" },
  "www.pizzahut.co.in": { slug: "pizza-hut-india", redeem: "web" },
  "www.jiomart.com": { slug: "jiomart-india", redeem: "web" },
  "www.wakefit.co": { slug: "wakefit-india", redeem: "web" },
  "www.uber.com": { slug: "uber-india", redeem: "copy" },
  "www.target.com": { slug: "target-usa", redeem: "web" }, // US, used for the first live test
};

// Only merchants verified end to end are sold. ENABLED_MERCHANTS="all" (or a comma list of hosts) overrides this.
// Verified so far: Flipkart (web redemption: card bought with ZEC, then filled in on the real payment page).
const enabled = (process.env.ENABLED_MERCHANTS ?? "www.flipkart.com").split(",").map((x) => x.trim());
if (!enabled.includes("all")) for (const k of Object.keys(MERCHANTS)) if (!enabled.includes(k)) delete MERCHANTS[k];

// Bitrefill test products cost nothing; only reachable in testnet mode so a real checkout can never hit them.
// In testnet mode the real merchants are removed entirely: testnet coins are free, so selling real cards
// against them would let anyone drain the Bitrefill credit.
// MAINNET_FREE_TEST=1 does the same on mainnet for a one-off live check of the free test card (no float spent).
if (process.env.ZCASH_NETWORK === "test" || process.env.MAINNET_FREE_TEST === "1") {
  for (const k of Object.keys(MERCHANTS)) delete MERCHANTS[k];
  MERCHANTS["test.shieldcheckout.local"] = { slug: "test-gift-card-code", redeem: "web" };
}

/** Exact host first, then any subdomain of a listed merchant's root domain. */
export function findMerchant(host: string) {
  if (MERCHANTS[host]) return MERCHANTS[host];
  const key = Object.keys(MERCHANTS).find((k) => {
    const root = k.replace(/^www\./, "");
    return host === root || host.endsWith(`.${root}`);
  });
  return key ? MERCHANTS[key] : undefined;
}

/** Short names the agent can use, e.g. "flipkart" -> "www.flipkart.com". */
export const merchantNames = (): Record<string, string> =>
  Object.fromEntries(Object.keys(MERCHANTS).map((h) => [h.replace(/^www\./, "").split(".")[0], h]));

export interface CatalogHit { slug: string; name: string; currency: string; inStock: boolean }
/** Read-only catalog search for the agent. Names come from Bitrefill: untrusted text, so it is trimmed to plain characters. */
export async function searchCatalog(query: string, country = "IN"): Promise<CatalogHit[]> {
  const r = await br<{ data: { id: string; name: string; currency: string; in_stock?: boolean }[] }>(
    `/products/search?q=${encodeURIComponent(query.slice(0, 60))}&country=${encodeURIComponent(country)}&limit=8`,
  );
  return (r.data ?? []).slice(0, 8).map((p) => ({
    slug: String(p.id).slice(0, 80), name: String(p.name).replace(/[^\w .&'-]/g, "").slice(0, 60), currency: String(p.currency).slice(0, 5), inStock: !!p.in_stock,
  }));
}

export const getProduct = async (slug: string) => {
  const r = await br<{ data?: Product } & Partial<Product>>(`/products/${encodeURIComponent(slug)}`);
  return (r.data ?? r) as Product;
};

export interface Card { value: number; price: number }

/** Alternative strategy: fewest cards first (accepting some surplus), then the least surplus. */
export function pickCardsFewest(packages: { value: string; price: number }[], amount: number, maxCards = 4): Card[] | null {
  const pk = packages.map((p) => ({ value: Number(p.value), price: p.price })).sort((a, b) => a.value - b.value);
  let best: { cards: Card[]; surplus: number } | null = null;
  const rec = (start: number, cards: Card[], sum: number) => {
    if (sum >= amount - 1e-9) {
      const surplus = sum - amount;
      if (!best || cards.length < best.cards.length || (cards.length === best.cards.length && surplus < best.surplus - 1e-9)) best = { cards: [...cards], surplus };
      return;
    }
    if (cards.length === maxCards) return;
    for (let i = start; i < pk.length; i++) rec(i, [...cards, pk[i]], sum + pk[i].value);
  };
  rec(0, [], 0);
  return (best as { cards: Card[] } | null)?.cards ?? null;
}

/**
 * Picks up to `maxCards` cards (repeats allowed) whose face values cover `amount`, minimizing the
 * surplus first, then the number of cards. Returns null if impossible.
 */
export function pickCards(packages: { value: string; price: number }[], amount: number, maxCards = 4): Card[] | null {
  const pk = packages.map((p) => ({ value: Number(p.value), price: p.price })).sort((a, b) => a.value - b.value);
  let best: { cards: Card[]; surplus: number } | null = null;
  const rec = (start: number, cards: Card[], sum: number) => {
    if (sum >= amount - 1e-9) {
      const surplus = sum - amount;
      if (!best || surplus < best.surplus - 1e-9 || (Math.abs(surplus - best.surplus) < 1e-9 && cards.length < best.cards.length))
        best = { cards: [...cards], surplus };
      return;
    }
    if (cards.length === maxCards) return;
    for (let i = start; i < pk.length; i++) rec(i, [...cards, pk[i]], sum + pk[i].value);
  };
  rec(0, [], 0);
  return (best as { cards: Card[] } | null)?.cards ?? null;
}

// Invoice states seen live: "not_delivered" -> "all_delivered" (the docs example says "complete").
export const isDelivered = (status: string) => status === "all_delivered" || status === "complete";

// Verified against docs.bitrefill.com (integration-flow, quickstart-2): responses are wrapped in `data`;
// redemption info lives on the order, not the invoice.
export interface Redemption { code?: string; pin?: string; link?: string; instructions?: string }

export async function createInvoice(productId: string, value: number | string): Promise<{ id: string; status: string; orderIds: string[] }> {
  const r = await br<{ data: { id: string; status: string; orders?: { id: string }[] } }>("/invoices", {
    method: "POST",
    body: JSON.stringify({
      products: [{ product_id: productId, package_id: `${productId}<&>${value}`, quantity: 1 }],
      payment_method: "balance",
      auto_pay: true,
    }),
  });
  return { id: r.data.id, status: r.data.status, orderIds: (r.data.orders ?? []).map((o) => o.id) };
}

export async function getInvoice(id: string): Promise<{ status: string; orderIds: string[] }> {
  const r = await br<{ data: { status: string; orders?: { id: string }[] } }>(`/invoices/${id}`);
  return { status: r.data.status, orderIds: (r.data.orders ?? []).map((o) => o.id) };
}

export async function getRedemption(orderId: string): Promise<Redemption | null> {
  const r = await br<{ data: { redemption_info?: Redemption } }>(`/orders/${orderId}`);
  return r.data.redemption_info ?? null;
}

/** USD store credit in cents (verified: 1000 == $10.00). */
export const getUsdBalanceCents = async () =>
  (await br<{ data: { balance: number } }>("/accounts/balance?currency=USD")).data.balance;
