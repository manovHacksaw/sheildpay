import http from "node:http";
import fs from "node:fs";
import { AGENT_HTML } from "./agent-page.js";
import { randomUUID } from "node:crypto";
import { cfg, missing } from "./config.js";
import { MERCHANTS, getUsdBalanceCents, getProduct, pickCards, createInvoice, getInvoice, getRedemption, isDelivered, findMerchant, Card } from "./bitrefill.js";
import { plans } from "./plan.js";
import { chat, llmEnabled, planSummary } from "./agent.js";
import { watcher, zecUsd } from "./rails.js";
import { zip321 } from "./zip321.js";

interface Voucher { code: string; pin?: string; label?: string }
interface Order {
  id: string; status: string; zecAmount: number; address: string; paymentUri: string; expiresAt: number;
  currency: string; cardValue: number; surplus: number; cards: number[]; costUsd: number; feeUsd: number;
  redeem: "web" | "copy"; vouchers?: Voucher[]; error?: string;
  lines?: { label: string; cards: number[]; redeem: "web" | "copy" }[]; /** set for agent baskets */
}
// Per-card purchase progress, so a restart resumes instead of buying twice.
interface Item { started: boolean; invoiceId?: string; orderId?: string; voucher?: Voucher }
interface Rec { order: Order; productId?: string; cards: (Card & { productId?: string; label?: string })[]; items: Item[]; at: number }
const orders = new Map<string, Rec>();
let spentToday = { day: "", usd: 0 };

// Orders (including vouchers, which are secrets) are kept on disk, mode 600, so a restart can resume them.
const STORE = process.env.ORDERS_FILE ??
  `orders-${process.env.ZCASH_NETWORK === "test" ? "test" : process.env.MAINNET_FREE_TEST === "1" ? "freetest" : "main"}.json`;
const KEEP_MS = 7 * 24 * 3600 * 1000;
const persist = () => {
  try {
    const now = Date.now();
    const recs = [...orders.values()].filter((r) => now - r.at < KEEP_MS);
    fs.writeFileSync(`${STORE}.tmp`, JSON.stringify({ spentToday, recs }), { mode: 0o600 });
    fs.renameSync(`${STORE}.tmp`, STORE);
  } catch (e) { console.error("could not save orders:", (e as Error).message); }
};

const send = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
  res.end(JSON.stringify(body));
};
const readJson = (req: http.IncomingMessage) =>
  new Promise<any>((ok, bad) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(JSON.parse(s)); } catch (e) { bad(e); } }); });

async function quote(b: { host: string; amount: number; currency: string }) {
  if (missing.length) throw new Error(`server not configured: ${missing.join(", ")}`);
  if (!(b.amount > 0)) throw new Error("invalid amount");
  const m = findMerchant(b.host);
  if (!m) throw new Error(`no Bitrefill card for ${b.host}`);
  const product = await getProduct(m.slug);
  if (!product.in_stock) throw new Error("this card is out of stock");
  if (product.currency !== b.currency) throw new Error(`cart is ${b.currency} but ${product.name} cards are ${product.currency}`);
  const cards = pickCards(product.packages, b.amount);
  if (!cards) throw new Error("cart too large for available denominations");
  const cardValue = cards.reduce((x, c) => x + c.value, 0);
  const costUsd = Number(cards.reduce((x, c) => x + c.price, 0).toFixed(2)); // Bitrefill package prices are USD
  const free = product.id.startsWith("test-"); // Bitrefill test products are free
  const mainnetFreeTest = process.env.MAINNET_FREE_TEST === "1";
  if (process.env.ZCASH_NETWORK === "test" ? !free : mainnetFreeTest !== free) throw new Error("product not allowed in this mode");
  if (costUsd > cfg.perOrderCapUsd) throw new Error(`order exceeds the ${cfg.perOrderCapUsd} USD per-order limit`);
  const day = new Date().toISOString().slice(0, 10);
  if (spentToday.day !== day) spentToday = { day, usd: 0 };
  if (!free && spentToday.usd + costUsd > cfg.dailyCapUsd) throw new Error("daily limit reached");
  if (!free && (await getUsdBalanceCents()) < Math.ceil(costUsd * 100)) throw new Error("Bitrefill USD credit too low for this order");
  const feeUsd = Number(Math.max(costUsd * cfg.feePct, cfg.feeMinUsd).toFixed(2));
  const rate = await zecUsd();
  const zecAmount = free && mainnetFreeTest ? 0.0001 : Number((((costUsd + feeUsd) / rate) * (1 + cfg.slippage)).toFixed(8));
  return { m, productId: product.id, cards, cardValue, costUsd, feeUsd, zecAmount, free };
}

/** Price preview for the popup: same checks as an order, but nothing is created or reserved. */
async function previewQuote(b: { host: string; amount: number; currency: string }) {
  const q = await quote(b);
  return { currency: b.currency, cardValue: q.cardValue, surplus: q.cardValue - b.amount, cards: q.cards.map((c) => c.value),
    costUsd: q.costUsd, feeUsd: q.feeUsd, zecAmount: q.zecAmount, redeem: q.m.redeem, validForMs: cfg.quoteTtlMs };
}

async function createOrder(b: { host: string; amount: number; currency: string }): Promise<Order> {
  const { m, productId, cards, cardValue, costUsd, feeUsd, zecAmount, free } = await quote(b);
  const id = randomUUID();
  const address = await watcher.newAddress();
  if (!free) { spentToday.usd += costUsd; persist(); }
  const o: Order = {
    id, status: "awaiting_payment", zecAmount, address, currency: b.currency, cardValue, costUsd, feeUsd,
    surplus: cardValue - b.amount, cards: cards.map((c) => c.value), redeem: m.redeem,
    paymentUri: zip321(address, zecAmount, `shieldcheckout:${id.slice(0, 8)}`),
    expiresAt: Date.now() + cfg.quoteTtlMs,
  };
  const rec: Rec = { order: o, productId, cards, items: cards.map(() => ({ started: false })), at: Date.now() };
  orders.set(id, rec);
  persist();
  void advance(rec);
  return o;
}

/** The user's approval of an agent plan: only this creates an order. Price is re-checked against the live rate. */
async function createOrderFromPlan(planId: string): Promise<Order> {
  const plan = plans.get(planId);
  if (!plan || plan.expiresAt < Date.now()) throw new Error("this plan has expired; ask the agent again");
  plans.delete(planId); // single use
  const rate = await zecUsd();
  const zecAmount = plan.free && process.env.MAINNET_FREE_TEST === "1" ? 0.0001
    : Number((((plan.costUsd + plan.feeUsd) / rate) * (1 + cfg.slippage)).toFixed(8));
  const day = new Date().toISOString().slice(0, 10);
  if (spentToday.day !== day) spentToday = { day, usd: 0 };
  const id = randomUUID();
  const address = await watcher.newAddress();
  if (!plan.free) { spentToday.usd += plan.costUsd; persist(); }
  const cards = plan.lines.flatMap((l) => l.cards);
  const o: Order = {
    id, status: "awaiting_payment", zecAmount, address, currency: plan.lines[0].currency, cardValue: cards.reduce((x, c) => x + c.value, 0),
    costUsd: plan.costUsd, feeUsd: plan.feeUsd, surplus: plan.lines.reduce((x, l) => x + l.surplus, 0), cards: cards.map((c) => c.value),
    redeem: plan.lines.every((l) => l.redeem === "copy") ? "copy" : "web",
    lines: plan.lines.map((l) => ({ label: l.label, cards: l.cards.map((c) => c.value), redeem: l.redeem })),
    paymentUri: zip321(address, zecAmount, `shieldcheckout:${id.slice(0, 8)}`), expiresAt: Date.now() + cfg.quoteTtlMs,
  };
  const rec: Rec = { order: o, cards, items: cards.map(() => ({ started: false })), at: Date.now() };
  orders.set(id, rec);
  persist();
  void advance(rec);
  return o;
}

// Very small per-IP limiter for the model-backed endpoint.
const hits = new Map<string, number[]>();
const limited = (ip: string, max = 20) => {
  const now = Date.now();
  const h = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  h.push(now); hits.set(ip, h);
  return h.length > max;
};

// Release vouchers at 1 confirmation (policy lives here). Every purchase step is saved before and after it
// happens; if a restart lands between "invoice requested" and "invoice id saved" we fail the order for manual
// review rather than risk buying the card twice.
async function advance(r: Rec, resumed = false) {
  const o = r.order;
  const deadline = resumed ? Math.max(o.expiresAt, Date.now() + 30_000) : o.expiresAt;
  const save = () => persist();
  try {
    while (Date.now() < deadline && !["ready", "failed"].includes(o.status)) {
      await new Promise((res) => setTimeout(res, 5000));
      const s = await watcher.status(o.address);
      if (s.receivedZec < o.zecAmount) continue;
      if (o.status === "awaiting_payment") { o.status = "seen"; save(); }
      if ((s.confirmations ?? 0) < 1) continue;
      o.status = "issuing"; save();
      for (let i = 0; i < r.cards.length; i++) {
        const it = r.items[i];
        if (it.voucher) continue;
        if (!it.invoiceId) {
          if (it.started) throw new Error(`restart during purchase of card ${i + 1}; check Bitrefill My Products before retrying. Order ${o.id}`);
          it.started = true; save();
          const inv = await createInvoice(r.cards[i].productId ?? r.productId!, r.cards[i].value);
          it.invoiceId = inv.id; it.orderId = inv.orderIds[0]; save();
        }
        let status = "";
        for (let n = 0; n < 60; n++) {
          const inv = await getInvoice(it.invoiceId);
          status = inv.status; it.orderId = inv.orderIds[0] ?? it.orderId;
          if (isDelivered(status) && it.orderId) break;
          await new Promise((res) => setTimeout(res, 3000));
        }
        if (!isDelivered(status) || !it.orderId) throw new Error(`invoice ${it.invoiceId} not complete (${status}); check Bitrefill. Order ${o.id}`);
        const ri = await getRedemption(it.orderId);
        if (!ri?.code && !ri?.link) throw new Error(`no redemption data for order ${it.orderId}; check Bitrefill. Order ${o.id}`);
        it.voucher = { code: ri.code ?? ri.link!, pin: ri.pin }; save();
      }
      o.vouchers = r.items.map((x, i) => ({ ...x.voucher!, label: r.cards[i].label }));
      o.status = "ready";
    }
    if (!["ready", "failed"].includes(o.status)) { o.status = "failed"; o.error = "Payment not received before quote expired."; }
  } catch (e) { o.status = "failed"; o.error = (e as Error).message; }
  save();
}

// Resume unfinished orders after a restart. The watcher re-tracks its own addresses.
try {
  const d = JSON.parse(fs.readFileSync(STORE, "utf8"));
  if (d.spentToday?.day === new Date().toISOString().slice(0, 10)) spentToday = d.spentToday;
  for (const r of d.recs as Rec[]) {
    orders.set(r.order.id, r);
    if (!["ready", "failed"].includes(r.order.status)) void advance(r, true);
  }
  console.log(`restored ${orders.size} order(s) from ${STORE}`);
} catch { /* first run */ }

http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/agent") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return void res.end(AGENT_HTML); }
    if (req.method === "GET" && url.pathname === "/agent/info") return send(res, 200, { llm: llmEnabled(), merchants: Object.keys(MERCHANTS) });
    if (req.method === "POST" && url.pathname === "/agent/chat") {
      if (limited(req.socket.remoteAddress ?? "?")) return send(res, 429, { error: "slow down" });
      const body = await readJson(req);
      const r = await chat(Array.isArray(body.messages) ? body.messages : [], spentToday);
      return send(res, 200, { reply: r.reply, mode: r.mode, plan: r.plan && { ...planSummary(r.plan), validForMs: r.plan.expiresAt - Date.now() } });
    }
    if (req.method === "POST" && url.pathname === "/agent/approve") {
      if (limited(req.socket.remoteAddress ?? "?", 10)) return send(res, 429, { error: "slow down" });
      return send(res, 200, await createOrderFromPlan(String((await readJson(req)).planId)));
    }
    if (req.method === "POST" && url.pathname === "/quote") return send(res, 200, await previewQuote(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/orders") return send(res, 200, await createOrder(await readJson(req)));
    const m = url.pathname.match(/^\/orders\/([\w-]+)$/);
    if (req.method === "GET" && m) {
      const o = orders.get(m[1])?.order;
      return o ? send(res, 200, o) : send(res, 404, { error: "not found" });
    }
    if (url.pathname === "/merchants") return send(res, 200, Object.keys(MERCHANTS));
    if (url.pathname === "/health") return send(res, 200, { ok: true, configured: missing.length === 0, missing });
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 400, { error: (e as Error).message }); }
}).listen(cfg.port, () => console.log(`shieldcheckout server :${cfg.port}`, missing.length ? `(NOT configured: ${missing.join(", ")})` : ""));
