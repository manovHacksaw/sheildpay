import QRCode from "qrcode";
import type { Order, Quote } from "../lib/api";

interface Ctx { host: string; amount: number; currency: string }
const app = document.getElementById("app")!;
const SYM: Record<string, string> = { INR: "₹", USD: "$" };
const money = (cur: string, n: number) => `${SYM[cur] ?? cur + " "}${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = <T>(msg: object) =>
  new Promise<T>((ok, bad) => chrome.runtime.sendMessage(msg, (r) => (r?.ok ? ok(r.result) : bad(new Error(r?.error ?? "no response")))));
const el = (html: string) => Object.assign(document.createElement("div"), { innerHTML: html });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const STEPS = ["Waiting for your ZEC", "Confirming payment", "Buying your card", "Applying to checkout"];
const stepOf = (s: Order["status"]) => ({ awaiting_payment: 0, seen: 1, confirmed: 2, issuing: 2, ready: 3, failed: 0 })[s];

async function tabId(): Promise<number> {
  const q = Number(new URLSearchParams(location.search).get("tab"));
  if (q) return q;
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? 0;
}

function fail(msg: string) {
  app.innerHTML = `<h1>ShieldCheckout</h1><p class="err">${esc(msg)}</p>`;
}

async function main() {
  const tab = await tabId();
  const ctx = await send<Ctx | null>({ type: "ctx", tab });
  const existing = await send<Order | null>({ type: "active", tab }).catch(() => null);
  if (existing && existing.status !== "failed" && Date.now() < existing.expiresAt + 60_000) return track(tab, existing);
  if (!ctx) return fail("Open a checkout page and click “Pay with Zcash” there.");

  app.innerHTML = `<h1>Confirm your purchase</h1><p class="sub">${esc(ctx.host)}</p><p>Getting your quote…</p>`;
  let q: Quote;
  try { q = await send<Quote>({ type: "quote", body: ctx }); } catch (e) { return fail((e as Error).message); }

  const cards = q.cards.map((c) => money(q.currency, c)).join(" + ");
  app.innerHTML = `
    <h1>Confirm your purchase</h1><p class="sub">${esc(ctx.host)}</p>
    <div class="row"><span>Cart total</span><span>${money(ctx.currency, ctx.amount)}</span></div>
    <div class="row"><span>Gift card${q.cards.length > 1 ? "s" : ""}</span><span>${cards}</span></div>
    ${q.surplus > 0.005 ? `<div class="row"><span>Stays as card balance</span><span>${money(q.currency, q.surplus)}</span></div>` : ""}
    <div class="row"><span>Service fee</span><span>$${q.feeUsd.toFixed(2)}</span></div>
    <div class="row"><span>You pay</span><span class="big">${q.zecAmount} ZEC</span></div>
    <p class="note">Paid privately from your shielded wallet. Quote valid for ${Math.round(q.validForMs / 60000)} minutes.
    ${q.redeem === "copy" ? "This store redeems gift cards in its app, so you will get a code to copy." : "The card is applied to this checkout automatically."}</p>
    <button class="p" id="go">Proceed</button><div id="e"></div>`;
  const go = document.getElementById("go") as HTMLButtonElement;
  go.onclick = async () => {
    go.disabled = true; go.textContent = "Creating order…";
    try { track(tab, await send<Order>({ type: "create", tab, body: ctx })); }
    catch (e) { go.disabled = false; go.textContent = "Proceed"; document.getElementById("e")!.innerHTML = `<p class="err">${esc((e as Error).message)}</p>`; }
  };
}

async function track(tab: number, first: Order) {
  let o = first;
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, o.paymentUri, { width: 200 });
  const render = () => {
    const cur = stepOf(o.status);
    app.innerHTML = "";
    const head = el(`<h1>${o.status === "ready" ? "Payment complete" : "Send " + o.zecAmount + " ZEC"}</h1>`);
    app.append(head);
    if (o.status === "awaiting_payment") {
      app.append(canvas);
      app.append(el(`<div class="addr">Address <code>${esc(o.address.slice(0, 10))}…${esc(o.address.slice(-6))}</code>
        <button class="s" id="ca">Copy address</button> <button class="s" id="cm">Copy amount</button></div>
        <a class="w" href="${esc(o.paymentUri)}" target="_blank">Open in my Zcash wallet</a>
        <p class="note">Check the address starts with <b>${esc(o.address.slice(0, 8))}</b> and ends with <b>${esc(o.address.slice(-4))}</b> before you send.</p>`));
      app.querySelector<HTMLElement>("#ca")!.onclick = () => navigator.clipboard.writeText(o.address);
      app.querySelector<HTMLElement>("#cm")!.onclick = () => navigator.clipboard.writeText(String(o.zecAmount));
    }
    const ol = document.createElement("ol");
    STEPS.forEach((s, i) => { const li = document.createElement("li"); li.textContent = s; li.className = i < cur ? "done" : i === cur ? "cur" : ""; ol.append(li); });
    app.append(ol);
    if (o.status === "ready") app.append(el(`<p class="note">${o.redeem === "copy" ? "Your code is shown on the checkout page." : "Your card is being applied on the checkout page. You can close this."}</p>`));
    else app.append(el(`<p class="note">You can close this window. The checkout page keeps tracking and applies the card for you.</p>`));
    if (o.error) app.append(el(`<p class="err">${esc(o.error)}</p>`));
  };
  render();
  while (o.status !== "ready" && o.status !== "failed") {
    await sleep(3000);
    try { o = await send<Order>({ type: "get", id: o.id }); render(); } catch { /* retry */ }
  }
}

main().catch((e) => fail(String(e.message ?? e)));
