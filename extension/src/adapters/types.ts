export interface Total {
  amount: number;
  currency: string;
}

export interface Adapter {
  id: string;
  matches(url: URL, doc: Document): boolean;
  getTotal(doc: Document): Total | null;
  getCodeInput(doc: Document): HTMLInputElement | null;
  getPinInput(doc: Document, codeInput: HTMLInputElement): HTMLInputElement | null;
  getApplyButton(doc: Document, input: HTMLInputElement): HTMLElement | null;
  /** Where to place the button; null means use the floating widget. */
  mountPoint(doc: Document): Element | null;
  /** True on the page where a gift card can actually be entered (field visible, or a toggle that opens it). */
  canRedeem?(doc: Document): boolean;
  /** Reveal a collapsed gift-card field if the site hides it. */
  reveal?(doc: Document): void;
}

const SYMBOLS: Record<string, string> = { "₹": "INR", "Rs": "INR", "Rs.": "INR", "INR": "INR", "$": "USD", "US$": "USD", "USD": "USD", "€": "EUR", "£": "GBP" };

/** Parses "₹1,349", "Rs. 1,23,456.00", "$24.50", "24,50 €" into a number + currency. */
export function parseMoney(text: string): Total | null {
  const m = text.replace(/\s/g, "").match(/(US\$|USD|INR|Rs\.?|₹|\$|€|£)?(\d[\d.,]*\d|\d)(€|£)?/);
  if (!m) return null;
  let n = m[2];
  // A comma followed by 1-2 digits at the very end, with no dot, is a decimal comma ("24,50").
  if (!n.includes(".") && /,\d{1,2}$/.test(n)) n = n.replace(/,(\d{1,2})$/, ".$1").replace(/,/g, "");
  else n = n.replace(/,/g, "");
  const amount = parseFloat(n);
  if (!isFinite(amount)) return null;
  const sym = m[1] ?? m[3] ?? "";
  return { amount, currency: SYMBOLS[sym] ?? (sym === "" ? "INR" : "USD") };
}
