import { randomUUID } from "node:crypto";
import { cfg } from "./config.js";
import { findMerchant, getProduct, getUsdBalanceCents, merchantNames, pickCards, pickCardsFewest } from "./bitrefill.js";
import { zecUsd } from "./rails.js";

// A plan is the server's priced proposal for a basket of cards. The agent can ask for one but can never set a
// price, and a plan is not an order: only the user's explicit approval (POST /agent/approve) creates one.

export interface PlanCard { value: number; price: number; productId: string; label: string }
export interface PlanLine {
  merchant: string; host: string; label: string; currency: string; amount: number;
  cards: PlanCard[]; cardValue: number; surplus: number; costUsd: number; redeem: "web" | "copy"; prefer: string;
  alternatives: { prefer: string; cards: number[]; surplus: number; costUsd: number }[];
}
export interface Plan {
  id: string; lines: PlanLine[]; costUsd: number; feeUsd: number; zecAmount: number; rateUsd: number;
  free: boolean; expiresAt: number;
}

export const plans = new Map<string, Plan>();
const FREE_MAINNET = () => process.env.MAINNET_FREE_TEST === "1";

export interface SpendState { day: string; usd: number }

export async function buildPlan(
  items: { merchant: string; amount: number; prefer?: string }[],
  spent: SpendState,
): Promise<Plan> {
  if (!Array.isArray(items) || !items.length || items.length > 4) throw new Error("ask for 1 to 4 items");
  const names = merchantNames();
  const lines: PlanLine[] = [];
  for (const it of items) {
    const host = names[String(it.merchant).toLowerCase()];
    const m = host && findMerchant(host);
    if (!host || !m) throw new Error(`"${it.merchant}" is not supported. Supported: ${Object.keys(names).join(", ")}`);
    const amount = Number(it.amount);
    if (!(amount > 0) || amount > 100000) throw new Error("amount must be a positive number");
    const product = await getProduct(m.slug);
    if (!product.in_stock) throw new Error(`${product.name} is out of stock`);
    const prefer = it.prefer === "fewest_cards" ? "fewest_cards" : "least_waste";
    const main = (prefer === "fewest_cards" ? pickCardsFewest : pickCards)(product.packages, amount);
    if (!main) throw new Error(`${amount} is too large for ${product.name}'s available denominations`);
    const summarize = (cards: { value: number; price: number }[]) => ({
      cards: cards.map((c) => c.value), surplus: cards.reduce((x, c) => x + c.value, 0) - amount,
      costUsd: Number(cards.reduce((x, c) => x + c.price, 0).toFixed(2)),
    });
    const other = (prefer === "fewest_cards" ? pickCards : pickCardsFewest)(product.packages, amount);
    const alt = other && JSON.stringify(other.map((c) => c.value)) !== JSON.stringify(main.map((c) => c.value))
      ? [{ prefer: prefer === "fewest_cards" ? "least_waste" : "fewest_cards", ...summarize(other) }] : [];
    const s = summarize(main);
    lines.push({
      merchant: String(it.merchant).toLowerCase(), host, label: product.name, currency: product.currency, amount,
      cards: main.map((c) => ({ ...c, productId: product.id, label: product.name })),
      cardValue: main.reduce((x, c) => x + c.value, 0), surplus: s.surplus, costUsd: s.costUsd, redeem: m.redeem, prefer, alternatives: alt,
    });
  }
  const free = lines.every((l) => l.cards.every((c) => c.productId.startsWith("test-")));
  const costUsd = Number(lines.reduce((x, l) => x + l.costUsd, 0).toFixed(2));
  if (costUsd > cfg.perOrderCapUsd) throw new Error(`total ${costUsd} USD exceeds the ${cfg.perOrderCapUsd} USD per-order limit`);
  const day = new Date().toISOString().slice(0, 10);
  if (spent.day !== day) { spent.day = day; spent.usd = 0; }
  if (!free && spent.usd + costUsd > cfg.dailyCapUsd) throw new Error("daily limit reached");
  if (!free && (await getUsdBalanceCents()) < Math.ceil(costUsd * 100)) throw new Error("Bitrefill USD credit too low for this basket");
  const feeUsd = Number(Math.max(costUsd * cfg.feePct, cfg.feeMinUsd).toFixed(2));
  const rateUsd = await zecUsd();
  const zecAmount = free && FREE_MAINNET() ? 0.0001 : Number((((costUsd + feeUsd) / rateUsd) * (1 + cfg.slippage)).toFixed(8));
  const plan: Plan = { id: randomUUID(), lines, costUsd, feeUsd, zecAmount, rateUsd, free, expiresAt: Date.now() + cfg.quoteTtlMs };
  for (const [k, p] of plans) if (p.expiresAt < Date.now()) plans.delete(k);
  plans.set(plan.id, plan);
  return plan;
}
