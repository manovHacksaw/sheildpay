import { Adapter, parseMoney, Total } from "./types";
import { HOSTS } from "./hosts";

// No per-site selectors: Indian checkouts change often and I can't verify each one, so these
// heuristics read labels/placeholders instead. Failures fall back to the floating widget and
// the copy-code list, so a missed field never blocks the user.

const CHECKOUT_PATH = /(checkout|payment|pay|cart|bag|basket|order|review)/i;
const TOTAL_LABEL = /^(grand total|order total|total payable|total amount|amount payable|amount to pay|to pay|you pay|net payable|total)\s*:?$/i;
const GIFT = /gift\s*(card|voucher)|e-?gift|egv|voucher/i;
// Never type a voucher into a payment-card field.
const PAYMENT_CARD = /credit|debit|cvv|cvc|expir|valid\s*thru|cc-(number|exp|csc)/i;
const PIN = /\bpin\b/i;

/** True for the host itself and any subdomain of its registrable root (www.flipkart.com ~ payments.flipkart.com). */
function sameSite(hostname: string, host: string): boolean {
  const root = host.replace(/^www\./, "");
  return hostname === host || hostname === root || hostname.endsWith(`.${root}`);
}

function descriptor(el: HTMLInputElement, doc: Document): string {
  const parts: (string | null | undefined)[] = [el.placeholder, el.getAttribute("aria-label"), el.name, el.id, el.getAttribute("autocomplete")];
  if (el.id) parts.push([...doc.querySelectorAll("label")].find((l) => l.htmlFor === el.id)?.textContent);
  parts.push(el.closest("label")?.textContent);
  return parts.filter(Boolean).join(" ");
}

/** Hidden if the element or any ancestor is display:none / visibility:hidden / [hidden] (children don't inherit display:none). */
function isShown(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (n.hidden || cs.display === "none" || cs.visibility === "hidden") return false;
  }
  return true;
}

function visibleInputs(doc: Document): HTMLInputElement[] {
  return [...doc.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')].filter(
    (i) => !i.disabled && isShown(i),
  );
}

export const generic: Adapter = {
  id: "generic-india",
  matches: (url) => HOSTS.some((h) => sameSite(url.hostname, h)) && CHECKOUT_PATH.test(url.pathname + url.hash),

  getTotal(doc) {
    let found: Total | null = null;
    for (const el of doc.querySelectorAll("span,div,td,th,p,li,dt,dd,label,strong,b,h3,h4")) {
      if (el.children.length > 0) continue;
      const label = el.textContent?.trim() ?? "";
      if (!TOTAL_LABEL.test(label)) continue;
      // The amount may sit a few wrappers up from the label (label and value in separate blocks).
      let t: Total | null = null;
      for (let c = el.parentElement, d = 0; c && d < 4 && !t; c = c.parentElement, d++) {
        const text = c.textContent?.replace(label, "") ?? "";
        if (text.length > 80) break; // climbed into a big container: stop before grabbing unrelated amounts
        if (/(₹|Rs\.?|INR|\$)\s*[\d,]+(\.\d+)?/i.test(text)) t = parseMoney(text);
      }
      if (t) found = t; // keep the last match: totals sit at the bottom
    }
    return found;
  },

  getCodeInput(doc) {
    const ins = visibleInputs(doc);
    // Only fields that say gift card / voucher. No fallback to "coupon" or "card number": those are other fields.
    return ins.find((i) => {
      const d = descriptor(i, doc);
      return GIFT.test(d) && !PIN.test(d) && !PAYMENT_CARD.test(d);
    }) ?? null;
  },

  getPinInput(doc, codeInput) {
    const scope = codeInput.closest("form") ?? codeInput.parentElement?.parentElement?.parentElement ?? doc.body;
    return [...scope.querySelectorAll<HTMLInputElement>("input")].find((i) => i !== codeInput && PIN.test(descriptor(i, doc))) ?? null;
  },

  getApplyButton(_doc, input) {
    let scope: Element | null = input;
    for (let i = 0; i < 5 && scope; i++) {
      scope = scope.parentElement;
      const btn = [...(scope?.querySelectorAll<HTMLElement>('button,[role="button"],input[type="submit"]') ?? [])].find((b) =>
        /^(apply|add|redeem|submit|verify|check)\b/i.test((b.textContent || (b as HTMLInputElement).value || "").trim()),
      );
      if (btn) return btn;
    }
    return null;
  },

  mountPoint: (doc) => {
    const i = generic.getCodeInput(doc);
    return i?.closest("form") ?? i?.parentElement?.parentElement ?? null;
  },

  canRedeem(doc) {
    return generic.getCodeInput(doc) !== null || findToggle(doc) !== null;
  },

  // Expands a collapsed gift-card box. It must never navigate: only click in-page toggles, never real
  // links (Flipkart's footer has a "Gift Cards" link) and never anything in the site chrome.
  reveal(doc) {
    if (generic.getCodeInput(doc)) return;
    findToggle(doc)?.click();
  },
};

// "Have a Flipkart Gift Card?", "Add gift card", "Redeem voucher"... (a verb is required so plain "Gift Cards" links never match).
const TOGGLE = /^(add|have an?|redeem|use|apply)\s+(an?\s+)?([a-z]+\s+)?(e-?)?gift\s*(card|voucher)s?\??$/i;
function findToggle(doc: Document): HTMLElement | null {
  for (const el of doc.querySelectorAll<HTMLElement>("button,[role='button'],a,div,span,li,label,p,h3,h4")) {
    if (!TOGGLE.test(el.textContent?.trim() ?? "")) continue;
    // Use the innermost element carrying the text (icons or wrappers may add children around it).
    if ([...el.children].some((c) => TOGGLE.test(c.textContent?.trim() ?? ""))) continue;
    if (el.closest("header,footer,nav,[role='navigation'],[role='contentinfo']")) continue;
    const link = el.closest("a");
    const href = link?.getAttribute("href");
    if (href && href !== "#" && !href.startsWith("javascript:")) continue;
    if (el.closest("form") && (el as HTMLButtonElement).type === "submit") continue;
    return el;
  }
  return null;
}
