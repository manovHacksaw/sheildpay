import { describe, it, expect } from "vitest";
import { parseMoney } from "./types";
import { generic } from "./generic";
import { zip321 } from "../lib/zip321";

describe("parseMoney", () => {
  it("parses INR, US and EU formats", () => {
    expect(parseMoney("₹1,349")).toEqual({ amount: 1349, currency: "INR" });
    expect(parseMoney("Rs. 1,23,456.50")).toEqual({ amount: 123456.5, currency: "INR" });
    expect(parseMoney("$1,234.50")).toEqual({ amount: 1234.5, currency: "USD" });
    expect(parseMoney("24,50 €")).toEqual({ amount: 24.5, currency: "EUR" });
  });
});

describe("generic adapter", () => {
  it("finds total, gift card + pin fields and the apply button", () => {
    document.body.innerHTML = `
      <div class="row"><span>Total Payable</span><span>₹1,349</span></div>
      <div id="gc"><input placeholder="Enter Gift Card Number"><input placeholder="PIN"><button>Apply</button></div>
      <input placeholder="Coupon code">`;
    expect(generic.getTotal(document)).toEqual({ amount: 1349, currency: "INR" });
    const code = generic.getCodeInput(document)!;
    expect(code.placeholder).toBe("Enter Gift Card Number");
    expect(generic.getPinInput(document, code)?.placeholder).toBe("PIN");
    expect(generic.getApplyButton(document, code)?.textContent).toBe("Apply");
  });
});

describe("reveal", () => {
  it("never follows links or clicks site chrome", () => {
    document.body.innerHTML = `
      <footer><a id="f" href="/the-gift-card-store">Gift Cards</a><button id="fb">Gift Cards</button></footer>
      <a id="l" href="/giftcards">Gift Cards</a>
      <button id="t">Have a gift card?</button>`;
    const hit: string[] = [];
    document.querySelectorAll<HTMLElement>("#f,#fb,#l,#t").forEach((e) => e.addEventListener("click", (ev) => { ev.preventDefault(); hit.push(e.id); }));
    generic.reveal!(document);
    expect(hit).toEqual(["t"]);
  });
});

describe("flipkart-like payment page", () => {
  it("finds the toggle, then voucher fields and Add Gift Card", () => {
    document.body.innerHTML = `
      <footer><a href="/the-gift-card-store">Gift Cards</a></footer>
      <div class="opt"><span>Have a Flipkart Gift Card?</span></div>
      <div id="panel" hidden><label>Voucher Number</label><input placeholder="Enter voucher number">
        <label>Voucher PIN</label><input placeholder="Enter voucher PIN"><button>Add Gift Card</button></div>
      <div><span>Total Amount</span><span>₹188</span></div>`;
    document.querySelector(".opt")!.addEventListener("click", () => ((document.getElementById("panel") as HTMLElement).hidden = false));
    expect(generic.canRedeem!(document)).toBe(true);
    generic.reveal!(document);
    const code = generic.getCodeInput(document)!;
    expect(code.placeholder).toBe("Enter voucher number");
    expect(generic.getPinInput(document, code)?.placeholder).toBe("Enter voucher PIN");
    expect(generic.getApplyButton(document, code)?.textContent).toBe("Add Gift Card");
    expect(generic.getTotal(document)).toEqual({ amount: 188, currency: "INR" });
  });
  it("finds a toggle wrapped in extra markup, on a bare domain", () => {
    document.body.innerHTML = `<div class="opt"><svg></svg><div><span>Have a Flipkart Gift Card?</span></div></div><div><span>Total Amount</span><span>₹71</span></div>`;
    expect(generic.matches(new URL("https://flipkart.com/payments?token=abc"), document)).toBe(true);
    expect(generic.canRedeem!(document)).toBe(true);
    expect(generic.getTotal(document)).toEqual({ amount: 71, currency: "INR" });
  });
  it("never targets the credit-card field; only the voucher field once the toggle is opened", () => {
    document.body.innerHTML = `
      <div><label for="cc">Card Number</label><input id="cc" placeholder="XXXX XXXX XXXX XXXX">
        <input placeholder="MM / YY"><input placeholder="CVV"></div>
      <div class="opt"><span>Have a Flipkart Gift Card?</span></div>
      <div id="panel" style="display:none"><label>Voucher Number</label><input placeholder="Enter voucher number">
        <label>Voucher PIN</label><input placeholder="Enter voucher PIN"><button>Add Gift Card</button></div>
      <div><span>Total Amount</span><span>₹100</span></div>`;
    document.querySelector(".opt")!.addEventListener("click", () => ((document.getElementById("panel") as HTMLElement).style.display = "block"));
    expect(generic.getCodeInput(document)).toBeNull();
    expect(generic.canRedeem!(document)).toBe(true);
    generic.reveal!(document);
    expect(generic.getCodeInput(document)?.placeholder).toBe("Enter voucher number");
  });
  it("reads a total whose label and amount are in separate blocks", () => {
    document.body.innerHTML = `<div class="r"><div><span>Total Amount</span></div><div><span>₹100</span></div></div><p>${"x".repeat(200)} ₹999</p>`;
    expect(generic.getTotal(document)).toEqual({ amount: 100, currency: "INR" });
  });
  it("is not redeemable on an order-summary page", () => {
    document.body.innerHTML = `<footer><a href="/gift">Gift Cards</a></footer><div><span>Total Amount</span><span>₹181</span></div>`;
    expect(generic.canRedeem!(document)).toBe(false);
  });
});

describe("zip321", () => {
  it("builds a URI with trimmed amount and base64url memo", () => {
    expect(zip321("u1abc", 0.5, "hi")).toBe("zcash:u1abc?amount=0.5&memo=aGk");
  });
  it("rejects non-mainnet/garbage addresses", () => {
    expect(() => zip321("utest1abc", 1)).toThrow();
  });
});
