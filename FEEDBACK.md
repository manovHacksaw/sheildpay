# Feedback for Bitrefill

What broke, confused us or slowed us down while building ShieldCheckout on the REST API v2, in the order we hit it.

## 1. The balance endpoint silently reports only the *primary* store-credit currency (cost us ~30 min)

Our account had **$36 USD** store credit, but with **Bitcoin** set as primary:

```
GET /v2/accounts/balance              -> {"balance":0,"currency":"BTC"}
GET /v2/accounts/balance?currency=USD -> {"balance":0,"currency":"BTC"}   (param ignored)
GET /v2/products/flipkart-india       -> packages[].price = 715 for ₹50   (satoshis, no currency field)
```

We first thought the API key belonged to another account and generated a second key. That didn't help. The fix was
a click on the website (Store Credits → ⋯ → make USD primary), after which the same calls returned `3600 USD` and
`price: 0.57`.

**Asks:**
- Return every store-credit balance, e.g. `balances: [{currency, balance, primary}]`, or honour `?currency=`.
- Put the `currency` of `packages[].price` on the product response. A bare `715` is easy to read as dollars: our
  caps caught it, but a looser integration would have quoted a ₹50 card at $715.
- Say in the balance reference that only the primary currency is reported, and that it also sets the price currency.

## 2. Test products: "free" but priced, and listed despite "hidden by default"

`GET /v2/products/test-gift-card-code` returned `in_stock: true` with packages priced **$10.51, $21.01, …**. The
[Test products](https://docs.bitrefill.com/docs/test-products.md) page says they're free with no balance deducted,
and hidden unless `include_test_products=true` is passed. We fetched by ID, so that may be expected, but:
- A displayed price on a free product breaks any client-side budget check. Ours refused the order for exceeding a
  $10 cap, for a card that costs nothing.
- The hackathon guide warns that paying test products from balance *on the MCP* debits the real balance, while
  the REST docs say they're free. One sentence on which surfaces charge would remove the doubt. We almost didn't
  use them.

## 3. Invoice status naming

Our invoice finished as `all_delivered` (earlier runs also saw `not_delivered` before that), but the docs example
shows `complete`. We accept both.
A documented list of final states (`all_delivered`, `partially_delivered`, `failed`, …) would make polling code
safer. The guide's "paid is not the same as delivered" was the most useful single line we read.

## 4. `package_id` format

The invoice body needs `package_id: "<product_id><&><value>"`. We found this from the `packages[].id` values, not
from the invoice reference. An example in `POST /invoices` that copies `packages[].id` verbatim would help.

## 5. Docs we could and couldn't read as builders using a coding agent

- `docs.bitrefill.com/llms.txt` and the per-page `.md` files were excellent. Our agent read the balance and
  test-product specs directly from them.
- The Notion pages for the track (brief, Developer Resources, Lanes) render client-side, so a coding agent fetching
  them gets an empty page. We had to paste them in by hand. A static export or a `.md` mirror would help agent-first
  builders.

## 6. No sitewide Amazon.in gift card, and Amazon Fresh arrives as a link

We wanted Amazon India: its checkout has a single "Enter Code" box, the easiest of any site to auto-fill. The
catalog has no `amazon-india` product (404). The only INR Amazon gift card is `amazon-fresh-india`. We bought one
(invoice `27adcc6e-9eb0-4ac8-a94b-f6e6ca6f313f`), and:
- `redemption_info` was a **link** (link.xoxoday.com) rather than a code, so an agent can't apply it. A human has to
  open it, click "Collect Voucher" and copy a code and PIN.
- On amazon.in it was accepted, but into a separate **"Fresh Voucher"** balance, not "Added Gift Cards". By its
  name that pays for Amazon Fresh orders only, so it can't settle a normal cart (we didn't test a Fresh order).

**Asks:** a sitewide Amazon.in (Amazon Pay) gift card would be the single most useful India product for agentic
checkout. Until then, saying "delivered as a redemption link" and "Amazon Fresh orders only" on the product would
have saved us the test purchase.

## 7. The same product comes back in different formats

For one 4-card Flipkart order (invoices `5027f8ed…`, `03c32e2b…`, `1f8d2589…`, `7b1f5233…`), the ₹100 card came back as
a number and PIN in `redemption_info`, but the ₹50 and ₹500 came back as `plum.gift` links (redirecting to xoxoday) and the
₹1000 as a `wogi.gifts` link. Our first ₹50 card, earlier the same day, was a number and PIN. So the delivery format
depends on the denomination or supplier, and nothing in the product response says which one you'll get. For agentic
checkout that's the difference between fully automatic and a human opening three links.

**Asks:** always include the code and PIN in `redemption_info` when the supplier provides one (even alongside a link), or
expose the expected format per package, so agents can choose denominations they can actually apply.

## 8. Things that worked well

- `auto_pay: true` with `payment_method: "balance"`: one call to a paid invoice, delivered within seconds.
- For Flipkart, `redemption_info` on `GET /orders/{id}` came back as a code and PIN that we could fill in directly.
- Our first live purchase (`8c65f5be-ae9d-4383-b342-5dcd41a7ec98`, Flipkart India ₹50) delivered in under a
  minute and redeemed on flipkart.com with no issue.

---

## From the team

<!-- TODO (humans): add your own notes here. What surprised you, what you'd want next from Bitrefill, anything
     about the MCP / CLI / x402 surfaces you looked at but didn't use, and why. The brief says responses from the
     human behind the AI make the difference. -->
