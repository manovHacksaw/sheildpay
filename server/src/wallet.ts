import fs from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { watcher, zecUsd } from "./rails.js";
import { zip321 } from "./zip321.js";

// Prepaid shielded balance: top up once, then pay for cards in one click (or let the agent pay within it).
// CUSTODIAL: deposits land in the operator's wallet and the balance is a ledger kept here. The server holds a
// viewing key only, so it cannot move deposited ZEC; withdrawals and refunds to a wallet are manual.
// All amounts are integer zatoshis (1 ZEC = 1e8 zat).

interface Deposit { id: string; address: string; createdAt: number; receivedZat: number; creditedZat: number; confirmations: number | null }
interface Entry { at: number; kind: "deposit" | "purchase" | "refund"; zat: number; ref: string }
export interface Account { id: string; tokenHash: string; balanceZat: number; createdAt: number; deposits: Deposit[]; ledger: Entry[] }

const FILE = process.env.WALLET_FILE ?? `wallet-${process.env.ZCASH_NETWORK === "test" ? "test" : "main"}.json`;
const DEPOSIT_WATCH_MS = 24 * 3600 * 1000; // the watcher keeps an address ~1500 blocks (~31 h)
const MAX_TOPUP_USD = 100;

const accounts = new Map<string, Account>();
const byToken = new Map<string, string>(); // sha256(token) -> account id
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
export const toZat = (zec: number) => Math.round(zec * 1e8);
const zec = (zat: number) => zat / 1e8;

const save = () => {
  try {
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify({ accounts: [...accounts.values()] }), { mode: 0o600 });
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (e) { console.error("could not save wallet:", (e as Error).message); }
};

let rate = { usd: 0, at: 0 };
async function cachedRate(): Promise<number> {
  if (Date.now() - rate.at > 60_000) rate = { usd: await zecUsd(), at: Date.now() };
  return rate.usd;
}

export function createAccount(): { accountId: string; token: string } {
  const id = randomUUID();
  const token = randomBytes(24).toString("base64url");
  accounts.set(id, { id, tokenHash: hash(token), balanceZat: 0, createdAt: Date.now(), deposits: [], ledger: [] });
  byToken.set(hash(token), id);
  save();
  return { accountId: id, token };
}

/** Resolves `Authorization: Bearer <token>` to an account, or throws. */
export function auth(header: string | undefined): Account {
  const t = header?.match(/^Bearer ([\w-]{16,64})$/)?.[1];
  const a = t ? accounts.get(byToken.get(hash(t)) ?? "") : undefined;
  if (!a) throw new Error("wallet not found: sign in again");
  return a;
}

export const getAccount = (id: string) => accounts.get(id);

export async function summary(a: Account) {
  const usd = await cachedRate().catch(() => 0);
  return {
    accountId: a.id, balanceZat: a.balanceZat, balanceZec: zec(a.balanceZat),
    balanceUsdEstimate: usd ? Number((zec(a.balanceZat) * usd).toFixed(2)) : null,
    deposits: a.deposits.slice(-5).map((d) => ({
      id: d.id, address: d.address, receivedZec: zec(d.receivedZat), creditedZec: zec(d.creditedZat), confirmations: d.confirmations,
      pending: d.receivedZat > d.creditedZat || (d.receivedZat === 0 && Date.now() - d.createdAt < DEPOSIT_WATCH_MS),
    })),
    ledger: a.ledger.slice(-10).map((e) => ({ ...e, zec: zec(e.zat) })),
  };
}

/** A fresh shielded address for one top-up. Whatever arrives there is credited once it has 1 confirmation. */
export async function createDeposit(a: Account, usd: number) {
  if (!(usd > 0) || usd > MAX_TOPUP_USD) throw new Error(`top up between 0 and ${MAX_TOPUP_USD} USD`);
  const suggestedZec = Number((usd / (await cachedRate())).toFixed(8));
  const address = await watcher.newAddress();
  const d: Deposit = { id: randomUUID(), address, createdAt: Date.now(), receivedZat: 0, creditedZat: 0, confirmations: null };
  a.deposits.push(d);
  save();
  void track(a, d);
  return { depositId: d.id, address, suggestedZec, paymentUri: zip321(address, suggestedZec, `shieldcheckout-topup:${d.id.slice(0, 8)}`) };
}

// Credits only the confirmed amount not yet credited, so polling, restarts and repeat payments never double-count.
async function track(a: Account, d: Deposit) {
  while (Date.now() - d.createdAt < DEPOSIT_WATCH_MS) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const s = await watcher.status(d.address);
      const received = toZat(s.receivedZec);
      if (received !== d.receivedZat || s.confirmations !== d.confirmations) { d.receivedZat = received; d.confirmations = s.confirmations; save(); }
      if ((s.confirmations ?? 0) < 1 || received <= d.creditedZat) continue;
      const delta = received - d.creditedZat;
      d.creditedZat = received;
      a.balanceZat += delta;
      a.ledger.push({ at: Date.now(), kind: "deposit", zat: delta, ref: d.id });
      save();
      console.log(`wallet ${a.id.slice(0, 8)}: credited ${zec(delta)} ZEC from deposit ${d.id.slice(0, 8)}`);
    } catch { /* watcher not ready or address unknown yet: retry */ }
  }
}

/** Synchronous check-and-debit (no await between the two), so concurrent orders can't overspend. */
export function debit(a: Account, zat: number, ref: string) {
  if (!Number.isInteger(zat) || zat <= 0) throw new Error("invalid amount");
  if (a.balanceZat < zat) throw new Error(`balance too low: this costs ${zec(zat)} ZEC, you have ${zec(a.balanceZat)} ZEC. Top up or pay with the QR code.`);
  a.balanceZat -= zat;
  a.ledger.push({ at: Date.now(), kind: "purchase", zat: -zat, ref });
  save();
}

export function refund(a: Account, zat: number, ref: string) {
  a.balanceZat += zat;
  a.ledger.push({ at: Date.now(), kind: "refund", zat, ref });
  save();
}

// Restore accounts and resume watching recent deposits after a restart.
try {
  for (const a of JSON.parse(fs.readFileSync(FILE, "utf8")).accounts as Account[]) {
    accounts.set(a.id, a);
    byToken.set(a.tokenHash, a.id);
    for (const d of a.deposits) if (Date.now() - d.createdAt < DEPOSIT_WATCH_MS) void track(a, d);
  }
  console.log(`restored ${accounts.size} wallet account(s) from ${FILE}`);
} catch { /* first run */ }
