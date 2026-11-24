# Maximum welcome offer

An eligible player can buy 700,000 in-game coins once for 17,500 Telegram Stars. An enabled, authenticated Shop visit during the account’s first seven days starts the seven-day offer. Preloading the Shop leaves the clock untouched. Existing offers retain their original SKU and expiry, including expired offers. A paid or refunded coin-pack purchase ends first-purchase eligibility.

## Release order

1. Apply `sql/migrations/032_maximum_starter_offer.sql`. It adds the assigned SKU to the private offer record and stages `JC_STARTER_MAX` inactive. Previously issued orders already carry their own coin and Stars amounts.
2. Deploy the compatible backend and frontend. Confirm the active regular 700,000-coin pack costs 35,000 Stars, and the staged welcome product quotes 700,000 coins for 17,500 Stars.
3. After release approval, set only `JC_STARTER_MAX.active` to true in the private Stars catalogue. Keep `JC_STARTER` available for existing assignments. The service verifies the account, product, expiry and purchase history. A missing active half-price comparison blocks the Maximum offer.
4. To withdraw the promotion, deactivate `JC_STARTER_MAX`. Keep both product rows, offer assignments, orders and ledger history. The compatible service honours previously approved receipts. If reverting to a server without SKU-bound offers, pause starter products before that rollback.

## Commercial readback

Compare distinct eligible Shop visitors, completed first purchases and retained Stars per eligible visitor after a full offer window. Include all coin packs and track refunds, so movement between the welcome offer and regular packs is visible. Report owner and synthetic test traffic separately. The seven-day window is a product choice pending customer evidence.
