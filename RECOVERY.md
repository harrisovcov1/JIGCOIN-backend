# JigCoin recovery — updated 14 November 2026

Status: source recovery, three local safeguards and the Monetag quest integration
are prepared. Twenty-one backend and ten frontend tests passed. A subsequent local
restore of the 60 public application tables passed the Monetag migration/claim
compatibility checks with all 3,812 original rows preserved by the migration.
The owner-run V3 database installer returned all seven PASS checks at 00:18 UTC
on 14 November. Backend and frontend changes are not yet deployed; the application
is not yet ready to accept customer payments.

No production SQL, deployment, bot messages, purchases or financial transfers
were performed by the assistant. Database analysis used the uploaded file only.
The owner reports paying both providers and has upgraded Supabase to Pro.

## Verified assets

| Asset | Evidence |
| --- | --- |
| Backend | Original main `ab024961bc7637bbeb80a3d9a9fac03bb18530da`; uploaded ZIP matches all 17 original files. Local branch: `recovery/safe-restore-20261113`. |
| Frontend | Original main `4b1d2c60f76bdcfd08e984a76d3750d0cd517d9c`; uploaded ZIP matches both files. |
| Promotion bot | Recovered main `6e5c17ab10d02de826cc4d48a970b87a80fecf4d`. The owner's Render screenshot shows the worker resumed and Live; subsequent suspension has not been confirmed. |
| Frontend hosting | Earlier HTTP 200 response at `https://jigcoin-frontend.pages.dev` matched the original `index.html` exactly. That page calls `https://jigcoin.onrender.com`. |
| API hosting | Earlier HTTP 503 followed by timed-out health requests. Current service health remains unverified. The older `airdrop-empire-backend` service is distinct from `jigcoin-api`. |
| Supabase | Owner successfully connected pgAdmin to project `rvglsktxkorvasdxjcpg` after resuming it. The Pro dashboard also showed a physical backup. |
| Uploaded database | `jigcoin-database-2026-11-13.backup`, 783,025 bytes. Archive created 20:48:13 UTC on 13 November 2026. |

Archive SHA-256:
`63095ab96b8be04714e5d43a2c8687c948db6a247f686d73cd7b92e8dd4cc94c`

## Archive verification and limits

The archive is PostgreSQL Custom format 1.16, compressed with gzip. Its header
reports database version 17.6 and export client version 18.7. PostgreSQL
`pg_restore` 17.12 successfully listed its 1,412 entries, emitted the complete
SQL stream to `/dev/null`, and extracted schema definitions. All three commands
returned exit code 0 with empty stderr. At that initial inspection no SQL from
the archive was executed. The later isolated public-schema restore described in
the Monetag section has now passed; no archive SQL was executed on a live service.

There are 102 base tables: public 60, auth 27, private 2, realtime 3 and storage
10. The public schema also contains 46 functions, 12 views and 15 triggers.
The matching database definitions therefore extend well beyond the five SQL
migration files in GitHub.

Those initial checks verify archive readability and decompression. The later
public-schema restore adds application database compatibility evidence, but does
not establish a complete managed Supabase recovery or application correctness.
Supabase Storage file contents, provider settings, credentials,
project configuration and cluster-wide roles need separate recovery handling.
Keep the full archive private; do not commit it to GitHub.

The sanitized machine-readable review is
[backup-review-20261113.json](recovery/backup-review-20261113.json).
It contains aggregate counts and metadata, with no customer identities, secret
values, raw rows or stored function bodies.

The subsequent [feature inventory](FEATURE_MAP.md) maps the recovered game,
paid catalogue and growth systems. The [commercial roadmap](ROADMAP.md) sets out
the proposed repair order, customer tests and revenue scenarios. Proposed prices
or product changes are not live changes or revisions to existing customer rights.

## Findings from this snapshot

1. **Historical balances need reconciliation.** There are 143 user rows,
   including one marked as a system user, and 921 balance-ledger entries.
   Stored balances differ from the sum of ledger deltas for 13 users. Three users
   have no ledger entries. These observations do not establish which balance is
   correct or why it differs. Keep existing values until historical credits,
   referral triggers, opening balances and purchase handling have been reviewed.
2. **Withdrawal code and schema disagree.** The database has `address`,
   `admin_note`, `processed_at` and `tx_reference`. Current code references absent
   columns `wallet`, `note`, `paid_at`, `payout_provider`, `payout_tx_id` and
   `payout_error`. The archive contains zero withdrawal rows. Adding only
   migration 004 would not resolve the entire mismatch.
3. **A referenced sponsor table is absent.** `public.sponsor_payout_events`
   appears in backend code and migration 002 but is absent from the archive.
   All four mission-integrity constraint names from migration 001 are present.
   Its `ADD CONSTRAINT IF NOT EXISTS` statements also need syntax repair before
   it can be treated as a reusable PostgreSQL migration. Do not replay all
   migrations blindly.
4. **Database access needs tightening.** Fourteen public tables have RLS disabled
   and grant ALL to both `anon` and `authenticated`, including jobs, idempotency,
   points-ledger, fraud-event and webhook-event tables. If exposed through the
   Data API, these grants can permit unauthorized application operations. Live
   API exposure, function execution rights and effective policies have not been
   tested; the archive is not evidence of an actual intrusion. Review privileges,
   security-definer functions and owner-executed views together.
5. **Revenue is unverified.** The purchase ledger has three rows marked completed;
   the separate purchases table has zero rows. Those are application records,
   not evidence of settled provider receipts, independent customers or profit.
   Four stored jobs are present: three completed and one failed. User-row counts
   are not active-player or customer counts.

## Local repairs and verification

Remote repositories and live services are unchanged.

- Maintenance middleware now registers once before protected routes. Previously
  it was appended inside another request handler after routes could execute.
- The unimplemented payout provider throws `PAYOUT_PROVIDER_NOT_CONFIGURED`
  instead of returning a fake manual payment identifier.
- `sync_user` now compares balances without changing them. Discrepancies raise
  permanent `BALANCE_RECONCILIATION_REQUIRED` for review. Exact BigInt comparison
  avoids losing differences above JavaScript's safe integer limit. This protects
  retained balances without asserting that either source is authoritative.

Seven targeted tests pass using synthetic records, stubbed external services and
local HTTP only. The new balance-protection test failed before its repair and
passes after it, including missing-ledger, upward-difference and large-integer
cases. The earlier middleware/provider fixes had four failing tests before their
repair. `git diff --check` passes. These are focused safeguards, not a full
security audit, payment test or production database compatibility test.

To rerun locally: `npm ci --ignore-scripts`, then `npm test`.

## Monetag integration prepared — 13 November, 23:15 onward

The owner created a Monetag account/app and supplied SDK zone **12257359**. The
five 200-coin quest flows now have a local implementation with authenticated
provider receipts, atomic credits, persistent per-user cooldowns and frontend
pending/claim states. The former 24-hour-to-10-minute conversion is removed.
The recovered mission-wide claim-cap trigger is corrected for verified quests.
Unverified legacy ad/boost paths are blocked; coin-paid boosts remain available.

See [MONETAG_SETUP.md](recovery/MONETAG_SETUP.md) for migration, configuration,
validation and release order. The new receiver records receipts during app
maintenance but does not credit balances; authenticated claims remain blocked.
This supersedes the earlier generic statement that every callback is blocked.
All code is local. No production SQL, GitHub push, deployment, real ad or account
secret was used. The isolated backup compatibility check has now passed: all 60
public application tables, their original 3,812 rows and database triggers were
restored, migration 006 was applied twice without changing existing public rows,
and all five reward flows passed duplicate-claim and cooldown checks. The local
test database was discarded. Current live schema/login checks and actual
Telegram/Monetag validation remain required before enabling it.

## Next recovery work

1. **Rotate the exposed database password.** A previous screenshot showed a
   database connection URL containing a password. Do not reproduce it in chat.
   Inventory every Render service using that database login, pause relevant
   workers, reset the password privately in Supabase, update the connection URLs
   in those services and pgAdmin, then verify controlled reconnection. URL-encode
   any reserved characters when putting a password into a connection URL; enter
   the original password in pgAdmin's separate password field.
2. Confirm the promotion worker and other background workers are stopped during
   recovery. Their last observed status does not establish that they are stopped.
   The original deployed maintenance guard is defective, so setting its flag
   alone is not sufficient containment.
3. Review grants, policies, views and database functions; prepare and test a
   compatible schema repair in isolation. Do not run `AUTO_MIGRATE` on retained
   data. Investigate the 13 balance differences without overwriting them.
4. Fix job claiming and withdrawal state transitions. The current worker releases
   its selection lock before processing; the admin withdrawal route still needs
   protection against duplicate refunds and unverified paid status. The local
   provider repair does not resolve those separate paths.
5. Review and deploy the patched API only when a concrete deployment is approved.
   Initial controlled settings should be `MAINTENANCE_MODE=1`, `RUN_MODE=api`,
   `DISABLE_BOT_POLLING=1`, `DISABLE_WITHDRAWALS=1`, `DISABLE_AD_REWARDS=1`,
   `DISABLE_SPONSOR_MISSIONS=1`, and `AUTO_MIGRATE=0`. These settings do not stop
   separate workers or the promotion service.
6. Test Telegram identity, points persistence, referrals, reward idempotency,
   purchased benefits and refunds using isolated test accounts. Review all
   historical promises before changing monetization or customer entitlements.

## Costs and commercial position

The owner reports paying Render and Supabase arrears. Screenshots identified
US$14.13 for Render February and US$12.90 for Supabase; the Render January amount,
actual GBP total and complete ongoing service costs remain unrecorded. Supabase
is now Pro. The earlier proposed £50 recovery cap was a suggestion, not evidence
of actual spend or approval for further subscriptions. A remaining JigCoin budget
has not been verified; reconcile spending and agree that budget before adding
services or marketing expense.

No million-pound profit claim is supported. A testable first offer would deliver
an immediate game benefit with transparent terms and platform-compatible payment.
The proposed cosmetic/supporter offer is a recommendation, not an approved change
to purchased coin or token entitlements. Current Stripe/Coinbase flows and Stripe
test links are not a launch-ready payment system for Telegram digital goods.

## Official references

- [PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
- [Supabase database backups](https://supabase.com/docs/guides/platform/backups)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase securing the Data API](https://supabase.com/docs/guides/api/securing-your-api)
- [Telegram digital-goods payments](https://core.telegram.org/bots/payments-stars)
