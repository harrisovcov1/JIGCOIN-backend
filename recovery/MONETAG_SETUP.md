# JigCoin Monetag setup — prepared locally, not deployed

13 November 2026. Owner supplied the public tag for main zone **12257359**, SDK
function **show_12257359**, script **https://libtl.com/sdk.js**. The authenticated
Monetag app page identifies **JIGCOINBOT / app 3575887**. Registration and app/tag
creation succeeded. The owner completed the V3 database installation at 00:18 UTC on 14 November,
with all seven verification checks passing. Postback configuration, private
secret, backend/frontend deployment and live provider testing remain pending.

## What was prepared

- `lib/monetagRewards.js`: five fixed 200-coin placements, unique attempt per ad
  display, authenticated GET receiver, bound owner/zone/placement, durable event
  receipts, atomic claim and persistent rolling 24-hour per-user cooldown.
- `sql/migrations/006_monetag_rewards.sql`: additive private schema, restricted
  client-role access, explicit RLS on all three new tables and correction of the recovered mission-wide cap trigger
  for these five verified quests. Existing balances are not rewritten.
- `index.js`: `/postback/monetag` records eligible events even while ordinary app
  maintenance is active; user claims remain blocked by maintenance. New quest
  routes supersede timer-only claims. Legacy unverified ad/boost paths are closed;
  coin-paid boost paths remain. The 24-hour-to-10-minute conversion is removed.
- Frontend `index.html`: loads the owner's SDK on an explicit quest start, sends
  the server-issued ymid and placement, shows confirmation pending, and only
  enables Claim from backend state. No private secret is included. Provider
  promise resolution never grants coins. Cooldowns survive suspended timers.

The five codes are `sp_visit_partner`, `sp_watch_content`, `sp_watch_earn`,
`sp_claim_reward`, `sp_bonus_mission`. The UI calls these Daily ad bonus 1–5;
placeholder partner URLs are not used. These are eligible rewarded interstitial
events, not a guarantee of watching a full video. Auto interstitials and rewarded
popups are not activated. Ad-funded boost and VIP-extra-quest adapters remain
pending, as do the separate payment/referral and database-permission repairs.

Every display receives a fresh random UUID. A failed/no-fill attempt can retry
after 60 seconds without consuming the daily reward cooldown. Delayed receipts
are accepted for 48 hours, covering the documented retry window. Attempts in one
quest cycle can yield only one credit; unused attempts cannot be banked into a
future cycle. Estimated event earnings are retained separately from coin rewards.

## Release order

1. Confirm the correct Render API service, repository, branch and current public
   HTTPS origin. Recovered source uses `https://jigcoin.onrender.com`, but verify
   this before generating the postback URL. Review all current local recovery
   changes together; they have not been pushed to GitHub.
2. Live preflight and owner-run V3 installation have passed. Keep
   `AUTO_MIGRATE=0`; do not rerun SQL as part of this release. Confirm the Render
   database login separately: SQL editor role `postgres` does not prove that login.
3. Upload the reviewed backend with Auto-Deploy still Off. Confirm the saved
   recovery settings, set build command `npm ci`, and manually deploy with
   maintenance and ad/withdrawal restrictions enabled. Verify backend health
   before releasing the matching frontend. Preserve the recovery protections
   until the release checks in `RECOVERY.md` are complete.
4. Set server environment variables privately:

   | Name | Value |
   | --- | --- |
   | `MONETAG_ZONE_ID` | `12257359` |
   | `MONETAG_POSTBACK_SECRET` | Fresh cryptographically random 32-byte secret encoded as 64 hexadecimal characters |
   | `MONETAG_REWARDS_ENABLED` | `0` until the callback is saved and controlled testing is ready |

   The same secret is used in the Monetag URL. It must not be pasted into chat,
   stored in Git, returned by client APIs or recorded by proxy/request logs.
5. Confirm the deployed receiver responds **403** to a request without the secret
   (503 indicates missing configuration; 404 means the route is not deployed).
   Its handler sets `Cache-Control: no-store`. Inspect application and hosting
   logs for query-string redaction before sending the private URL.
6. Compose the following single-line URL **privately** using the verified origin
   and secret. This is a template, not a ready-to-save production URL:

   ```text
   https://VERIFIED_API_HOST/postback/monetag?secret=PRIVATE_SECRET&ymid={ymid}&zone_id={zone_id}&sub_zone_id={sub_zone_id}&event_type={event_type}&reward_event_type={reward_event_type}&estimated_price={estimated_price}&request_var={request_var}&telegram_id={telegram_id}
   ```

   Paste the completed URL into Monetag's **Your backend URL** field, then Save
   settings. Macros must keep their braces. Use the main SDK zone's configuration.
7. In the controlled test environment, enable `MONETAG_REWARDS_ENABLED=1` and
   clear the ad/sponsor kill switches and app maintenance only when ready.
   Validate in Telegram iOS and Android: eligible ad, early close, no-fill,
   background/resume, delayed confirmation, repeated claim and 24-hour persistence.
   Use provider-approved testing; do not repeatedly view/click live ads to create
   revenue. Confirm the real provider payload and moderation status.
8. Reconcile test receipts/ledger and restore recovery switches if anything fails.
   A webhook HTTP 200 alone does not prove an ad displayed or a reward was claimed.

## Validation scope

Validation run: **21 backend tests passed** (including 12 real PostgreSQL tests)
and **10 frontend tests passed**. Both inline frontend scripts parsed and both
repositories passed `git diff --check`. PostgreSQL test service was stopped.

Tests run on local PostgreSQL 17.12 with synthetic users/missions and the real
migration, row locks, transactions, ledger helper and cap trigger. They cover
parallel starts/claims, callback retries, owner/zone/secret errors, unpaid events,
rollback, cutoff/retry/restart behavior, cutover dates and denied client-role
access. Separate tests run actual Express entrypoint middleware and shipped
frontend functions with a controlled clock/DOM/SDK. No customer rows were used.

To repeat the DB suite, provide `JIGCOIN_TEST_POSTGRES_PORT` for a disposable local
PostgreSQL instance with database-creation privileges and run `npm test`. It
creates and drops a new `jigcoin_rewards_test_<pid>` database on **127.0.0.1** and
does not read `DATABASE_URL`. Without the variable the PostgreSQL tests are
explicitly skipped. Frontend: `node --test test/sponsor-countdown.test.cjs`.

An additional restore compatibility check passed on 13 November 2026. All 60
public application tables and their 3,812 rows, original owners, grants,
constraints, functions, indexes and triggers were restored locally. The original
`auth.uid()`/`auth.jwt()` dependencies and an empty local publication container
were provided; managed Supabase services, extensions, authentication accounts and
Storage contents were not restored. This is an application-schema check, not a
complete Supabase disaster-recovery rehearsal.

Migration 006 was applied twice as the restored `postgres` table-owner role.
Before/after fingerprints matched for every existing public row. All five quests
then passed pending-confirmation, duplicate callback/claim, exact 200-coin credit
and cooldown checks with the recovered database triggers active. Both restored
browser roles were denied access to the new private tables. Test changes were
discarded and the local server was stopped. See `MONETAG_RESTORE_CHECK.json`.

On 14 November, the SQL editor warned that the first installer did not explicitly
enable RLS. The owner was instructed to cancel. V2 added explicit RLS on all three
new tables, keeps the schema/table revocations, and intentionally adds no client
policies. The tested `postgres` owner can execute the API reward flow; a different
runtime login needs an explicit access review. RLS was tested separately from
grants by granting client access inside a disposable transaction: reads returned
no rows and inserts were denied by RLS. The exact V2 installer was run twice on
the restored application database, returning seven PASS rows with all original
public rows preserved. The deliverable is
`sql/install_monetag_rewards_checked_v3.sql`; it supersedes V1 and V2.

The owner-run V2 then raised its generic verification exception before COMMIT.
Windows CRLF line endings reproduced that error locally: only the function-source
checksum check failed. The live cause remains unconfirmed. V3 normalizes carriage
returns for that hash and names all failed checks in the exception. The exact V3
installer passed with LF then CRLF on a fresh local backup restore, preserving all
3,812 original rows across 60 tables and passing all five rewarded quest flows.
Deliberately incorrect function verification, anonymous access and missing RLS
were still rejected before COMMIT, with schema/function restoration confirmed
after rollback. The sanitized evidence is in MONETAG_RESTORE_CHECK.json.

Render screenshots confirm service `jigcoin-api`, repository
`harrisovcov1/JIGCOIN-backend`, branch `main`, blank root directory, build
`yarn install`, start `node index.js`, and origin `https://jigcoin.onrender.com`.
The owner changed Auto-Deploy to **Off**; its saved state is visible at 23:40.
The original deployed commit remains `ab02496`. The upload includes an npm lock
file, so the prepared release should use `npm ci` when its deployment is ready.

Remaining validation: Render runtime login, actual Monetag
notifications, Telegram device behavior and production deployment.
Existing public-schema grants, auth/data consistency, payments and referral
activation remain separate relaunch blockers; this patch is not full launch
approval. All existing purchases and balances remain subject to reconciliation.

## Official contract checked

- [Monetag postback configuration](https://docs.monetag.com/docs/postbacks/configuration/)
- [Monetag macro reference](https://docs.monetag.com/docs/postbacks/macroses/)
- [Rewarded interstitial integration](https://docs.monetag.com/docs/ad-integration/rewarded-interstitial/)

Shared-secret authentication is not a provider HMAC signature. Only `valued`
events from the configured rewarded-interstitial zone unlock a claim; optional
Telegram ID, when present, must match. Missing ID does not discard an otherwise
valid receipt because ymid already binds the authenticated attempt owner.
