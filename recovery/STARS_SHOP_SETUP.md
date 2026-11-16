# JigCoin Boost Hub — private Stars pilot, 16 November 2026

This package implements a simpler Boost Hub and a private Telegram Stars purchase flow. It has not been deployed to your services or used to make a real payment. It is a testable starting point, not evidence of maximum revenue. Daily check-in, rapid taps and the seven ad rewards keep their existing reward handlers. Leaderboard, VIP and Invite changes are deferred.

## What changes

- Relevant ad boost first, based on energy and available missions.
- One starter offer: a server-stored 48-hour deadline from the first enabled shop visit. Refreshing or reopening cannot restart it. One purchase per account, including after refund.
- Three featured packs. Additional active products, if added, go under View all packs.
- Daily check-in progress uses existing server milestone rewards. No extra unbacked reward is added.
- Owned shields are shown; the empty shield sales section is hidden.
- Saved order history, payment support, server-confirmed coin delivery and refund accounting.
- Distinct daily shop visitors and orders can be reported using STARS_SHOP_METRICS.sql. Owner tests are not valid commercial conversion results.

## Initial test catalogue

These are draft Stars prices, not conversions of the previous GBP catalogue and not proven optimum prices. Existing legacy product rows are untouched. Telegram Stars purchase cost and developer proceeds differ; do not label these amounts as GBP revenue.

| Offer | In-game coins | Stars |
|---|---:|---:|
| Starter, once within its 48-hour window | 1,000 | 50 |
| Small | 1,000 | 100 |
| Medium | 3,000 | 250 |
| Large | 7,000 | 500 |

Do not add “most popular”, false inventory counts, guaranteed rank or token-value claims. The displayed starter deadline is enforced by the backend. Price changes in `jigcoin_internal.stars_products` affect new orders; existing orders keep their original price and quantity. The migration is rerunnable and does not overwrite existing catalogue values.

## 1. Install the preview

1. In Supabase SQL Editor, run `010_stars_shop.sql` from this package. Expected last result: “Stars shop schema ready; purchases remain controlled by STARS_SHOP_ENABLED and the tester account”. No existing user balances are changed.
2. Extract `JIGCOIN_stars_backend.zip`. Upload its contents to the root of `harrisovcov1/JIGCOIN-backend`, preserving the `lib`, `scripts`, `sql`, `test` and `recovery` folders. Do not upload the ZIP itself as app code. This is a focused update to the currently deployed repository; it relies on its existing package.json, ledger, gameplay and other modules.
3. In Render keep `MAINTENANCE_MODE=1`, `RECOVERY_TEST_ENABLED=1`, `RECOVERY_TEST_TELEGRAM_ID=7888995060`, `RUN_MODE=api`, `DISABLE_BOT_POLLING=1`, `AUTO_MIGRATE=0`. Keep all existing ad/public kill-switch values. Add `STARS_SHOP_ENABLED=0`. Deploy the latest backend commit and wait for Live.
4. Extract `JIGCOIN_stars_frontend.zip`. Upload its `index.html` to the root of `harrisovcov1/JIGCOIN-frontend`. Confirm the Cloudflare Pages deployment completes. Fully close and reopen the mini app.
5. Inspect Boost Hub: three packs, starter preview, ad boosts, daily progress and order help. All purchase buttons must be disabled and show the preview notice. Taps, daily claim and all seven ad rewards should still work for your tester account.

## 2. Configure payment delivery

This step needs your public support email or human support Telegram username. Do not use a bot username unless someone actually monitors its support inbox. Never send BOT_TOKEN, database credentials or webhook secrets in chat.

Set these Render environment variables while `STARS_SHOP_ENABLED=0`:

| Variable | Value |
|---|---|
| PAYMENT_SUPPORT_CONTACT | Your real public support email or human support Telegram username |
| STARS_WEBHOOK_URL | https://jigcoin.onrender.com/telegram/stars-webhook |
| TELEGRAM_WEBHOOK_SECRET | A new random secret, 32–256 characters using letters, digits, `_` or `-` |

One way to create a secret on your own Windows computer is to run this in PowerShell, then paste directly from your clipboard into Render (not into chat):

```powershell
$JigSecret = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
Set-Clipboard -Value $JigSecret
```

Save and deploy. Then run the included `CONFIGURE_STARS_WEBHOOK.ps1` on that computer. It prompts for your existing BOT_TOKEN and the same webhook secret using hidden input. It verifies the bot is `@jigcoinofficial`, refuses to replace a different webhook, retains pending updates, and reads back the result. It does not enable sales. Clear the clipboard afterwards. Do not run polling for this bot while its webhook is installed.

Alternatively, on a backend host with its existing private environment and Node dependencies, run:

```text
node scripts/stars-admin.cjs configure-webhook
node scripts/stars-admin.cjs status
```

Send `/paysupport` to the bot. It must return your configured support contact. `/terms` gives the same coin/payment explanation. This confirms the delivery route is responding before any money is accepted.

Render Free services sleep after inactivity and can take about a minute to wake. Telegram requires pre-checkout acknowledgement within 10 seconds. For dependable paid sales use an always-on backend; warming a free service for one test does not demonstrate production readiness. No hosting upgrade has been purchased by this package.

## 3. Private payment test

Only after the preview, support command and webhook checks pass, set `STARS_SHOP_ENABLED=1` and deploy. Keep maintenance and the exact owner account gate enabled. This enables actual Stars purchases for that account only. A “TEST TAP” label is not a payment sandbox: paying here spends real Stars. No payment has been made by the assistant.

For a free provider-level test, use Telegram’s separate test environment and a separate test bot/database with matching test credentials and API endpoint. This package defaults to the live Telegram API, so do not treat the production bot as the free test environment.

Test one cancellation first. It must give no coins. Then, when ready for the real owner purchase, test the smallest offer and verify:

- The invoice shows the expected Stars price and coin quantity.
- Coins appear only after a successful server-confirmed payment.
- Closing and reopening the app recovers the saved order.
- Repeated Check order presses do not grant extra coins.
- Rapid taps remain queued safely while the saved purchase balance refreshes.
- The starter offer disappears after purchase and never resets on reopen.
- Other accounts still cannot buy or bypass maintenance.

Test refunds with the exact order reference from Orders & payment help, from a backend host that already has its private environment:

```text
node scripts/stars-admin.cjs refund ORDER_REFERENCE --confirm-refund
```

This sends a real Stars refund and then reverses the corresponding coins once. If the coins have already been spent, the record stores an outstanding reconciliation amount rather than making the balance negative; further purchases are blocked pending support. A retried refund is safe. If the host lacks Shell access, arrange a secure backend execution environment; do not expose a public refund endpoint or paste DATABASE_URL into chat.

## Operational boundaries

- This release intentionally exposes Stars catalogue/invoice/status routes only through the current signed owner gate while maintenance is on. Turning maintenance off does not enable public Stars sales. Public rollout needs a separate authenticated route rollout after the private test.
- Payment webhooks continue to process and refund genuine orders when the sales flag is disabled. Keep this endpoint deployed until outstanding payments/refunds are settled. Reverting to an old backend without this endpoint can strand payment confirmations.
- An approved order awaiting a receipt remains pending. It is not automatically deleted or replaced. If it stays pending, inspect Telegram delivery and payment records before authorising another attempt; this avoids a double charge after a delayed receipt.
- New ordinary bot registration stays blocked during maintenance, except the exact tester. Payment support and valid receipts remain accessible.
- Existing Coinbase/Stripe code remains in the repository for compatibility; this Boost Hub does not call it. Before public launch, audit and migrate any other digital-goods purchase entry points, including VIP.
- Keep `STARS_SHOP_ENABLED=0` to pause new invoices. Do not delete payment records to reset offers or repair balances.

## Validation and next decision

Results: 75 checks passed (42 backend and 33 frontend), zero failures. Seventeen existing tests requiring a separate PostgreSQL server were skipped. The new Stars database tests ran against PGlite 0.5.16, not the production database.

Automated verification uses synthetic identities, mocked Telegram responses and a disposable PGlite PostgreSQL database. It exercises duplicate receipts, rollback after ledger failure, wrong buyer/price, refunds, persistent expiry, route authentication and browser delivery logic. It does not establish live Telegram delivery, your production schema compatibility, device pixel layout, real network latency or commercial performance. Existing real-server Monetag/Postgres tests need their separate isolated Postgres instance and were not rerun here.

After this private test passes, validate checkout recovery under latency and a real refund, then roll out to a small audience with measurement. Compare net receipts after refunds and costs, purchase conversion, ad completion and 1-day/7-day return rates. Change one offer or price at a time. Revenue cannot be established from the appearance of the screen or the owner account test.

Official references checked 16 November 2026:
- https://core.telegram.org/bots/payments-stars
- https://core.telegram.org/bots/api#setwebhook
- https://render.com/docs/free


### Reproduce the automated checks

Use a disposable development environment, not a production host. Install the backend's existing dependencies with `npm ci`. The optional test database dependency is kept outside the application:

```bash
npm install --prefix /tmp/jigcoin-stars-tests --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.16
JIGCOIN_PGLITE_PATH=/tmp/jigcoin-stars-tests/node_modules/@electric-sql/pglite npm test
```

In the frontend repository:

```bash
node --test recovery/check-stars-shop.cjs recovery/check-rapid-taps.cjs recovery/check-daily.cjs
```

Production npm dependencies are unchanged. With no PGlite installed, the Stars database tests explicitly skip rather than touch a live database. Validation output and SHA-256 file hashes are included in the package.
