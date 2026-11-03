import { detect } from "../adapters/registry";
import { applyVoucher } from "../lib/filler";
import type { Order } from "../lib/api";

const send = <T>(msg: unknown) =>
  new Promise<T>((resolve, reject) =>
    chrome.runtime.sendMessage(msg, (r) => (r?.ok ? resolve(r.result) : reject(new Error(r?.error ?? "no response")))),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SYM: Record<string, string> = { INR: "₹", USD: "$" };
const money = (cur: string, n: number) => `${SYM[cur] ?? cur + " "}${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const LABEL: Record<Order["status"], string> = {
  awaiting_payment: "Waiting for your ZEC payment… open the ShieldCheckout popup to pay",
  seen: "Payment seen, waiting for confirmation…",
  confirmed: "Buying your gift card…",
  issuing: "Buying your gift card…",
  ready: "Done",
  failed: "Order failed",
};

const STYLE = `
  button{font:600 14px system-ui;padding:10px 14px;border:0;border-radius:8px;background:#f4b728;color:#111;cursor:pointer;width:100%}
  .box{font:14px system-ui;margin-top:8px;padding:12px;border:1px solid #ddd;border-radius:8px;background:#fff;color:#111}
  .float{position:fixed;right:16px;bottom:16px;width:300px;z-index:2147483647;box-shadow:0 4px 20px #0004;border-radius:10px;background:#fff;padding:8px}
  .err{color:#c00} .row{display:flex;gap:6px;align-items:center;margin:4px 0}
  .link{background:none;border:0;color:#555;font:12px system-ui;text-decoration:underline;padding:6px 0 0;width:auto;cursor:pointer}
  code{font-size:12px;word-break:break-all;flex:1} .row button{width:auto;padding:4px 8px;font-size:12px}`;

let lastLogged = "";

// On a page that looks like a checkout but where we can't offer payment, say so (and why) instead of staying silent.
function diagnose(adapter: ReturnType<typeof detect>) {
  if (!adapter || document.getElementById("shieldcheckout-diag")) return;
  const total = adapter.getTotal(document);
  const redeem = adapter.canRedeem?.(document) ?? true;
  const host = document.createElement("div");
  host.id = "shieldcheckout-diag";
  const root = host.attachShadow({ mode: "open" });
  const why = [!total && "can't read the total", !redeem && "no gift-card option on this step"].filter(Boolean).join(" · ");
  root.innerHTML = `<style>div{position:fixed;left:12px;bottom:12px;z-index:2147483647;font:12px system-ui;background:#222;color:#fff;
    padding:8px 10px;border-radius:8px;opacity:.92;max-width:300px} button{margin-left:8px;font:600 11px system-ui;cursor:pointer}</style>
    <div>ShieldCheckout: ${why}.<button id="r">Copy report</button></div>`;
  root.getElementById("r")!.addEventListener("click", () => {
    const bits = [...document.querySelectorAll("body *")].filter((e) => !e.children.length && /total|gift|voucher/i.test(e.textContent ?? "") && (e.textContent ?? "").length < 60)
      .slice(0, 25).map((e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : ""} > ${e.parentElement?.tagName.toLowerCase()}: "${e.textContent!.trim()}"`);
    void navigator.clipboard.writeText(JSON.stringify({ url: location.hostname + location.pathname, total, redeem, inputs: document.querySelectorAll("input").length, bits }, null, 1));
  });
  document.body.append(host);
}
function mount() {
  const adapter = detect(new URL(location.href), document);
  const existing = document.getElementById("shieldcheckout-root");
  // Only offer payment where a gift card can actually be entered (not on cart / order summary steps).
  if (location.href !== lastLogged) {
    lastLogged = location.href;
    console.debug("[ShieldCheckout]", location.hostname + location.pathname, {
      matched: !!adapter, total: adapter?.getTotal(document) ?? null, canRedeem: adapter?.canRedeem?.(document) ?? null,
    });
  }
  const usable = !!adapter && (adapter.canRedeem?.(document) ?? true) && !!adapter.getTotal(document);
  if (existing) { if (!usable) existing.remove(); return; }
  if (!usable) return void diagnose(adapter);
  document.getElementById("shieldcheckout-diag")?.remove();
  if (!adapter) return;
  const total = adapter.getTotal(document)!;
  const anchor = adapter.mountPoint(document);

  const host = document.createElement("div");
  host.id = "shieldcheckout-root";
  if (anchor?.parentElement) anchor.parentElement.insertBefore(host, anchor.nextSibling);
  else document.body.append(host);
  const root = host.attachShadow({ mode: __E2E__ ? "open" : "closed" });
  root.innerHTML = `<style>${STYLE}</style><div id="wrap" class="${anchor ? "" : "float"}">
    <button id="pay">Pay ${money(total.currency, total.amount)} with Zcash</button>
    <div class="box" id="box" hidden></div>
    <button id="own" class="link">Test autofill with a code I already have</button></div>`;
  const $ = <T extends HTMLElement>(id: string) => root.getElementById(id) as T;
  const box = $("box");
  const say = (text: string, cls = "") => { box.hidden = false; box.className = `box ${cls}`; box.textContent = text; };

  const showVouchers = (o: Order, note: string) => {
    box.hidden = false;
    box.innerHTML = "";
    box.append(Object.assign(document.createElement("p"), { textContent: note }));
    o.vouchers?.forEach((v, i) => {
      const row = document.createElement("div");
      row.className = "row";
      const b = Object.assign(document.createElement("button"), { textContent: "Copy" });
      b.onclick = () => navigator.clipboard.writeText(v.pin ? `${v.code} ${v.pin}` : v.code);
      row.append(Object.assign(document.createElement("span"), { textContent: `${money(o.currency, o.cards[i] ?? 0)}: ` }),
        Object.assign(document.createElement("code"), { textContent: `${v.code}${v.pin ? ` / PIN ${v.pin}` : ""}` }), b);
      box.append(row);
    });
  };

  // The gift-card field often appears a moment after its toggle is clicked.
  const waitForInput = async () => {
    for (let i = 0; i < 20; i++) {
      const input = adapter.getCodeInput(document);
      if (input) return input;
      if (i % 6 === 0) adapter.reveal?.(document); // click the toggle now and then, but give the form time to open
      await sleep(500);
    }
    return null;
  };

  // Applies the issued card(s). Marked done only after every card was entered, so a failed attempt can be retried.
  const finish = async (o: Order) => {
    const flag = `shieldcheckout-done-${o.id}`;
    let done = false;
    try { done = !!sessionStorage.getItem(flag); } catch { /* storage blocked */ }
    if (!o.vouchers?.length) return say("Order finished without a card. Check ShieldCheckout.", "err");
    if (o.redeem === "copy") return showVouchers(o, "Paid. This store redeems vouchers in its app. Copy the code(s):");
    const apply = async () => {
      say("Applying your gift card…");
      let applied = 0;
      for (const v of o.vouchers!) {
        const input = await waitForInput();
        if (!input) break;
        await applyVoucher(input, adapter.getPinInput(document, input), adapter.getApplyButton(document, input), v);
        applied++;
        await sleep(3000); // let the site process before the next card
      }
      if (applied === o.vouchers!.length) { try { sessionStorage.setItem(flag, "1"); } catch { /* ignore */ } }
      showVouchers(o, applied === o.vouchers!.length ? "Applied. If the total didn't change, use the codes here:" : "Couldn't find the gift card field on this page. Paste these codes manually, or retry on the payment page:");
      const retry = Object.assign(document.createElement("button"), { textContent: "Apply to this page" });
      retry.onclick = () => void apply();
      box.append(retry);
    };
    if (done) {
      showVouchers(o, "Codes for this order:");
      const again = Object.assign(document.createElement("button"), { textContent: "Apply to this page" });
      again.onclick = () => void apply();
      return box.append(again);
    }
    await apply();
  };

  // Follows this tab's order until it finishes. Safe to run on reload: it picks up where the order is.
  let following = false;
  const follow = async () => {
    if (following) return;
    following = true;
    try {
      for (;;) {
        const o = await send<Order | null>({ type: "active" }).catch(() => null);
        if (!o) return;
        if (o.status === "failed") return say(o.error ?? LABEL.failed, "err");
        if (o.status === "ready") return finish(o);
        say(LABEL[o.status]);
        await sleep(4000);
      }
    } finally { following = false; }
  };

  // No server, no payment: fills a code the user already owns, to check this checkout page's fields work.
  $("own").addEventListener("click", async () => {
    const code = prompt("Gift card / voucher number you already own (nothing is sent anywhere):")?.trim();
    if (!code) return;
    const pin = prompt("PIN (leave empty if none):")?.trim() || undefined;
    say("Looking for the gift card field…");
    const input = await waitForInput();
    if (!input) return say("Couldn't find the gift card field on this page.", "err");
    await applyVoucher(input, adapter.getPinInput(document, input), adapter.getApplyButton(document, input), { code, pin });
    say(`Filled the ${adapter.getPinInput(document, input) && pin ? "number and PIN" : "number"} and pressed ${adapter.getApplyButton(document, input) ? "the apply button" : "Enter"}. Check the page.`);
  });

  $("pay").addEventListener("click", async () => {
    try {
      const now = adapter.getTotal(document) ?? total; // totals change between steps (fees), use the current one
      await send({ type: "checkout", ctx: { host: location.hostname, amount: now.amount, currency: now.currency } });
      say("Confirm the details in the ShieldCheckout popup…");
      // Wait for the user to press Proceed in the popup, then follow the order.
      for (let i = 0; i < 150; i++) {
        await sleep(2000);
        if (await send<Order | null>({ type: "active" }).catch(() => null)) return follow();
      }
    } catch (e) { say((e as Error).message, "err"); }
  });

  void follow(); // resume an order started earlier in this tab
}

mount();
new MutationObserver(() => mount()).observe(document.body, { childList: true, subtree: true });
