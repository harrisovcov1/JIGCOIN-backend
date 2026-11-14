# Deployment progress — 14 November 2026

## Observed owner actions

- Render `jigcoin-api`: saved Auto-Deploy setting is Off.
- Render environment editor: nine recovery values were entered correctly. The
  owner was instructed to use Save only. A saved-state readback has not yet been
  observed; these values are not evidence that the running service is in
  maintenance. No new code has been deployed.
- Supabase project `rvglsktxkorvasdxjcpg`: the owner ran the provided SELECT-only
  preflight. Results show SQL editor role `postgres`, Monetag schema NOT INSTALLED,
  four matching table/constraint/index/trigger fingerprints, and five active ad
  quests. This matches the recovered application schema checked locally.

## Database installation completed; backend release pending

`sql/install_monetag_rewards_checked_v3.sql` contains migration 006 followed by
transactional verification and a seven-row result table. It adds three private
tables and updates `public.enforce_daily_sponsor_cap()`. It does not update
existing user balances or customer rows. The updated trigger requires verified
Monetag claims for the five managed quests; completion depends on the matching
backend being deployed and configured.

The exact V3 checked installer was executed with LF and CRLF as `postgres` on a fresh local
restore of the supplied public application schema. All seven checks passed, all
3,812 original public rows across 60 tables remained identical, and each of the
five actual quest definitions passed pending, duplicate-claim, exact-credit and
cooldown checks. The disposable database was removed and local PostgreSQL stopped.

The initial Run action stopped at Supabase's missing-RLS warning. The owner was
instructed to cancel. V2 explicitly enables RLS on all three new tables, retains
the permission restrictions and adds a seventh verification row. All 21 backend
tests passed, including denied client access after deliberately granting schema
and table access inside a rolled-back local transaction. The exact V2 installer
also passed the restored-database flow twice. The first backend ZIP should be
replaced with an updated package at the upload step so its SQL/tests/docs include
the current migration and V3 installer.

The owner ran V2 and received P0001: "Monetag installation verification failed;
transaction rolled back", from inline_code_block line 37 at RAISE. No successful
COMMIT was observed. That generic error does not identify the failing check.

A local restore reproduced the exact error using CRLF. A noncommitting diagnostic
showed only check 04 (function body checksum) failing; the other six passed. This
is a plausible cause of the live error, not proof of the live cause. V3 normalizes
carriage returns in function source before hashing and lists failed check names
in its exception. LF and CRLF installation both passed. Deliberately incorrect
function hashes, anonymous schema grants and disabled RLS each raised the named
failure before COMMIT; after rollback there was no private schema and the original
function remained intact. All five recovered quest flows also passed again.

At 00:18 UTC on 14 November, the owner's Supabase screenshot showed all seven
V3 verification rows as PASS in project rvglsktxkorvasdxjcpg, query
c1729a39-220c-47e0-a35f-3b203a8f456b. This confirms the installed private tables,
expected trigger function, client privilege restrictions and enabled RLS. The
provided complete V3 script commits before displaying that final result. There
is no reason to rerun the installer for this deployment.

Next: upload the current backend patch to the existing repository, confirm saved
Render recovery settings and the build command, then manually deploy in maintenance. The private callback secret, Monetag postback, frontend release and
device/provider testing remain pending. SQL editor role does not prove the
Render database login; that still needs confirmation before enabling rewards.
