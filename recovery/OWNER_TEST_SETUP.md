# One-account Monetag test — 14 November 2026

Status: prepared and locally verified; not uploaded or deployed.

Target: existing `harrisovcov1/JIGCOIN-backend` main commit
`12e348ad23c783360e54801da51d66a85bf4d550`, Render service `jigcoin-api`.
The frontend at production commit `caa135e` already supports the test flow.
No frontend change, database migration, new provider secret, or paid service is
required by this patch.

## What changes

With `MAINTENANCE_MODE=1`, `RECOVERY_TEST_ENABLED=1` and one valid
`RECOVERY_TEST_TELEGRAM_ID`, the backend verifies Telegram's signed initData and
permits only that existing account to read its state/configuration and use
Daily ad bonus 1 (`sp_visit_partner`). The Telegram session must be no more than
one hour old. Client-supplied IDs, usernames and flags do not grant access.

The account's state refresh is read-only: it does not regenerate stored energy,
reset daily counters, break a streak or create a user. The response skips the
onboarding coach for this test session without changing the saved onboarding
flag. Mission listing returns only the first verified quest. Other actions,
including taps, check-ins, purchases, withdrawals, other quests, legacy ad
helpers and admin routes, remain blocked even for the tester.

The private receiver and existing reward lifecycle are unchanged: a provider
receipt does not itself award coins; an eligible authenticated claim grants 200
coins once and persists a rolling 24-hour cooldown. A real test claim is a real
ledger entry and must not be erased or reset to create repeated ad views.

The exception is disabled by default and does not run outside maintenance. It
creates an internally enabled reward service behind the account gate; it does
not change or enable the public reward service. Removing the test ID or setting
`RECOVERY_TEST_ENABLED=0` closes the exception after the environment is deployed.

## Upload and deploy

1. Extract `JIGCOIN_backend_owner_test_20261114.zip`.
2. Upload its extracted files and folders to the existing backend repository
   root, preserving their paths. Do not delete existing files or upload the ZIP.
3. Commit to main with `Add account-restricted Monetag recovery test`.
4. Verify the uploaded payload against `OWNER_TEST_MANIFEST.json`. Render
   Auto-Deploy remains Off.
5. Add the following in Render Environment. The numeric ID is supplied privately
   during setup; no real account identifier is embedded in the source package.

   | Variable | Value |
   | --- | --- |
   | `RECOVERY_TEST_TELEGRAM_ID` | The verified tester's numeric Telegram user ID |
   | `RECOVERY_TEST_ENABLED` | `1` |

6. Keep the existing values unchanged: `MAINTENANCE_MODE=1`,
   `MONETAG_REWARDS_ENABLED=0`, `DISABLE_AD_REWARDS=1`,
   `DISABLE_SPONSOR_MISSIONS=1`, `DISABLE_WITHDRAWALS=1`,
   `DISABLE_BOT_POLLING=1`, `AUTO_MIGRATE=0`, `RUN_MODE=api`.
   Keep zone `12257359` and the already-saved private postback secret.
7. Save only, then manually deploy the verified latest main commit. Build remains
   `npm ci`, start remains `node index.js`, and root/pre-deploy fields stay blank.
   Do not launch overlapping deployments. Confirm success before testing.
8. Public `/health` must remain healthy, `/postback/monetag` without a secret
   must reject access, and an unauthenticated POST to `/api/state` must still
   return maintenance. These checks do not simulate a paid ad or grant a reward.

## Controlled device test after deployment

Close and reopen JIGCOIN inside Telegram using the designated account to obtain
fresh signed initData. Open the ad quest panel. Only Daily ad bonus 1 should be
listed. If the account or configuration is wrong, keep maintenance enabled and
inspect the failure; do not broaden access to get past it.

First confirm the state and quest list load. Then perform one bounded provider
integration check: press the quest's ad button, allow the rewarded interstitial
to finish normally, wait for the backend-confirmed Claim state, then claim once.
Do not click an advertiser offer merely to test delivery. Do not manually forge
a valued postback on the live database. If there is no fill or no confirmation,
capture the visible result and inspect the receipt before retrying.

Compare the stored balance and ledger before/after: exactly one 200-coin reward,
one claimed attempt and the matching cooldown. Reopen the panel/app to confirm
the cooldown survives. The existing local tests cover duplicate claims and
failure cases without repeated live ad views. Telegram iOS/Android and actual
provider delivery remain unverified until these steps are observed.

Turn `RECOVERY_TEST_ENABLED` back to `0` and apply the environment deployment
when testing is finished or if a problem occurs. Keep other recovery flags and
all historical data intact. This patch is not a public relaunch or approval to
activate payments, withdrawals, all five live quests or other workers.

## Validation

- 28 backend tests passed, with none skipped: 15 HTTP/safety checks and 13 real
  PostgreSQL checks, including the account-restricted HTTP callback/claim flow.
- Forged and other-account Telegram data, duplicates, old/future auth dates,
  invalid IDs, disabled test mode and unrelated routes were rejected.
- Owner state/list reads were exercised against a disposable restore of the
  supplied database as the `postgres` role. All 60 public tables and 3,812 rows
  were unchanged by these reads, including onboarding and streak fields.
- Existing five-quest reward, concurrency, cooldown and client-role restrictions
  also passed against the restored schema. All local test databases were removed
  and the local PostgreSQL service was stopped.
- No live database, ad provider or payment operation was performed by these tests.

Run `npm test` for the local safety checks. To include PostgreSQL tests, explicitly
set `JIGCOIN_TEST_POSTGRES_PORT` to a disposable loopback PostgreSQL server. These
tests never read `DATABASE_URL` and create/drop their own synthetic test database.
