# ShieldCheckout

**Pay at Indian checkouts with shielded Zcash. An agent prices your basket, buys the gift card on Bitrefill, and
the extension types it into the merchant's payment page. The merchant never sees crypto; the chain never sees you.**

Built for the Free Society Hack, Mumbai (4–5 Nov 2026): **Agentic Commerce (Bitrefill)** track, also entering
the **Zcash / Privacy** track.

| | |
|---|---|
| Real purchases (invoice IDs) | `8c65f5be-ae9d-4383-b342-5dcd41a7ec98`: Flipkart India ₹50, redeemed on flipkart.com.<br>Demo order: `5027f8ed-acfa-4539-8a11-81ecde94d7fb`, `03c32e2b-524e-4a11-86d0-d3d9ebba678f`, `1f8d2589-b1f0-4b77-ac96-db0817adfdc6`, `7b1f5233-719d-4101-b35b-8c7602b52bf2` (₹50 + ₹100 + ₹500 + ₹1000 Flipkart cards) paid Flipkart order `OD4390655807616781` down to ₹0 |
| Lanes | **5 Private by default** · **2 Close the loop** (card is filled into the checkout, no copy-paste) · **Shop from chat** |
| Most an agent can spend | $10 per order, $25 per day (env-configurable), and never without a user click. See [Guardrails](#guardrails) |

## What it does

```
 "₹300 on flipkart"          plan (server-priced)        one click            Bitrefill REST v2          extension
  user ──► agent (/agent) ──► cards + fee + ZEC ──► Pay from balance ──► invoice (auto_pay, balance) ──► fills the
                                                    or scan a QR          ──► delivered code            gift-card field
```

1. **Prepaid shielded balance.** Top up once: the server issues a fresh shielded (Orchard) address, and whatever
   arrives is credited after 1 confirmation. Exactly once per deposit, so retries and restarts never double-count.
2. **Shop from chat.** Tell the agent what you want to spend and where. It lists supported merchants, searches the
   catalog and asks the server to *price* a basket. It picks card denominations that cover the amount with the
   least waste and offers the "fewest cards" alternative. The agent can never set a price or create an order.
3. **One-click pay.** "Pay from balance" debits the quoted ZEC and buys right away. Or pay a single order by QR
   from your own wallet (ZIP-321 URI, fresh address per order).
4. **Fulfilment.** The server creates a Bitrefill invoice (`payment_method: balance`, `auto_pay: true`) per card,
   polls until **delivered** (not just paid), and fetches the redemption code.
5. **Close the loop.** On the merchant's payment page, the Chrome extension reads the total, offers "Pay with Zcash"
   and, once the card is ready, types the code and PIN into the gift-card field with real input events, so
   React-controlled forms accept it.

## Run it in under 15 minutes (testnet ZEC, real Bitrefill cards)

Needs: Node 22+, Rust stable (tested 1.98), Chrome, a Bitrefill account with USD store credit, and a few testnet
ZEC (TAZ) from a faucet ([fauzec.com](https://fauzec.com) or [zcashfaucet.jinolabs.xyz](https://zcashfaucet.jinolabs.xyz)).

```bash
git clone https://github.com/manovHacksaw/sheildpay && cd sheildpay

# 1. Receiving wallet (the server only ever gets its viewing key). Seed goes to a gitignored file, never printed.
cd watcher && cargo +stable run -q --example gen_wallet -- wallet-seed-testnet.txt test   # prints a uviewtest1… key

# 2. Config
cd ../server && npm ci && cp .env.testnet.example .env.testnet
#    edit .env.testnet: BITREFILL_API_KEY=…, ZCASH_UFVK=<the key from step 1>

# 3. Payment watcher (terminal 1)
cd ../watcher && set -a && . ../server/.env.testnet && set +a && cargo +stable run

# 4. Server (terminal 2)
cd server && npx tsx --env-file=.env.testnet src/index.ts
#    -> shieldcheckout server :8787 (TESTNET ZEC -> REAL cards; loopback only)

# 5. Extension (optional, for auto-fill on flipkart.com)
cd extension && npm ci && npm run build      # chrome://extensions -> Developer mode -> Load unpacked -> extension/dist
```

Open **http://localhost:8787/agent**, click **Add funds**, send TAZ to the address shown, wait for 1 confirmation
(~75 s), then ask "₹50 on flipkart" and click **Pay from balance**.

**Bitrefill gotcha:** set **USD as your primary store-credit currency** (bitrefill.com → Store Credits → ⋯ on USD).
The API reports only the primary balance and quotes prices in it. With BTC as primary you get `balance: 0` and
prices in satoshis, and the server's caps will (correctly) refuse every order.

Mainnet: use `server/.env` with `ZCASH_NETWORK=main`, a mainnet UFVK and `https://zec.rocks:443`. Real ZEC pays for real cards.

## Bitrefill touchpoints: built vs reused

We use **Bitrefill REST API v2** with a Bearer key: `GET /products/{id}` and `/products/search` (catalog and
denominations), `GET /accounts/balance` (refuse orders the float can't cover),
`POST /invoices` with `payment_method: "balance"` and `auto_pay: true` (one invoice per card),
`GET /invoices/{id}` (poll until `all_delivered`) and `GET /orders/{id}` (`redemption_info`: code, PIN or link).
**Reused:** Bitrefill's catalog, payment and delivery; librustzcash crates for note decryption; a public lightwalletd
(zec.rocks); Coinbase and Kraken spot prices. **Built:** the agent and its server-side pricing and planner, the
prepaid shielded balance and its ledger, the viewing-key-only payment watcher (Orchard and Ironwood),
crash-safe purchase sequencing, and the Chrome extension that detects checkouts and auto-fills the card.

## Guardrails

| Guardrail | Where |
|---|---|
| **The agent can't buy.** It can only ask the server to *price* a basket. Every purchase needs the user to click Pay (balance) or pay a QR. Plans are single-use and expire in 10 min. | `agent.ts`, `plan.ts` |
| **Spend caps:** `PER_ORDER_CAP_USD` (10) and `DAILY_CAP_USD` (25). Above the cap nobody approves: the server refuses, and the operator must raise the env value and restart. | `config.ts`, `index.ts` |
| Bitrefill balance is checked before quoting; orders the float can't cover are refused. | `index.ts` |
| Prices come only from Bitrefill; the ZEC amount uses the average of the Coinbase and Kraken spot prices that answer, plus 1% slippage. The model never sees or sets amounts or addresses. | `rails.ts`, `agent.ts` |
| Balance debit is check-and-debit with no `await` in between, so two clicks can't overspend. A failed purchase is refunded to the balance only if no card was started. | `wallet.ts`, `index.ts` |
| Each purchase step is saved before and after. A restart mid-purchase stops the order for manual review instead of risking buying twice. | `index.ts` `advance()` |
| Only merchants verified end to end are sold (`ENABLED_MERCHANTS`, Flipkart today). | `bitrefill.ts` |
| Testnet-ZEC-for-real-cards mode is opt-in (`TESTNET_REAL_PURCHASES=1`) and binds to 127.0.0.1, since free coins must not reach a public server. | `config.ts`, `index.ts` |
| Codes are masked on screen by default (Reveal or Copy); order files are written mode 600 and gitignored. | `agent-page.ts`, `index.ts` |

## Privacy and trust note (Zcash track)

**What's for which track:** Bitrefill track = the agent, server-side pricing and guardrails, Bitrefill
fulfilment and the extension auto-fill. Zcash track = shielded payments, the viewing-key-only watcher, fresh
addresses per order and deposit, and the prepaid shielded balance.

| Party | Learns | Doesn't learn |
|---|---|---|
| Merchant (Flipkart) | A gift card was redeemed on this account | Any crypto, wallet or payment history |
| Bitrefill | Our operator account bought card X | Which customer, or their wallet |
| Chain observers | A shielded transaction happened | Sender, receiver, amount or memo (Orchard or Ironwood) |
| LLM provider (optional) | Chat text ("₹300 on flipkart") | Addresses, codes or amounts it didn't type. Payment data never enters model context. |
| **ShieldCheckout operator** | Order contents, card codes (kept 7 days, mode 600) and, **with the prepaid balance, which purchases belong to which account** | Customer identity (no signup), wallet balance or other activity |

**Trust assumptions:**
- **The prepaid balance is custodial.** Deposits sit in the operator's wallet; the balance is a server-side
  ledger. The server holds only a viewing key, so a server compromise can't move funds, but the operator could
  refuse withdrawals and could link a customer's purchases to their account. Customers who want
  unlinkability pay each order by QR instead (a fresh address per order, no account).
- The operator could fail to deliver after payment. Bitrefill invoice IDs are recorded for every card.
- Codes are bearer value. They're stored on the server until delivery and shown masked.
- Server logs and IPs aren't hidden (no Tor). The browser wallet token lives in localStorage.

## Honest limitations

- **The demo payment ran on testnet ZEC.** The Bitrefill purchase and the Flipkart card are real. Mainnet mode is
  the same code with `ZCASH_NETWORK=main`.
- Withdrawals from the prepaid balance are manual (the server has no spending key, by design).
- Cards are released at 1 confirmation. ZEC/USD price risk sits with the operator for the life of a quote.
- QR orders reserve daily-cap headroom when created, so unpaid orders can exhaust the cap until midnight.
- Bitrefill sometimes delivers Flipkart cards as a **redemption link** (xoxoday or wogi) instead of a number and PIN.
  In the demo order, 3 of 4 cards came as links. Their codes were collected from the link page, then filled in by
  the extension. Resolving links automatically is the next item on the roadmap.
- Only Flipkart is enabled; the other ~24 Indian merchants in `bitrefill.ts` are mapped but not verified end to end.
- See [FEEDBACK.md](FEEDBACK.md) for what slowed us down.
