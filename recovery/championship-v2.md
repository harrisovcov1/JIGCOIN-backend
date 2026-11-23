# Championship v2 review runbook

Keep both PRs draft. An empty championship_config table leaves the season inactive. The feature flag CHAMPIONSHIP_V2=1 is also required. No configuration seed is part of the migration. No token rules or Stars changes are included.

## Rules

The server's UTC date selects the variant from the first complete Monday after activation. Each run has five independently generated puzzles. Each correct round earns 200 points; a complete ordered answer that misses pays partial score points equal to floor(100 × correct prefix length / sequence length). All other misses earn zero. The server gives ten minutes per run, bounded by midnight. Time is a completion deadline only, with no speed bonus for low network latency. Reveal variants have a server minimum observation interval. Best of three ranked runs per day, best six of seven dates per week. Ties compare the six scores in descending order, then the sum of first-ranked-attempt points on those six days. Equal daily bests select the higher first-attempt score. Identical performance records are ordered by ascending SHA-256 of the UTF-8 string jigcoin-champ-v2/YYYY-MM-DD/PLAYER, where the date is the Monday UTC and PLAYER is the canonical decimal player ID. This final residual rule is reproducible and changes weekly. It does not measure skill. Its actual use rate must be measured in human QA before activation. Practice is unranked. A positive validated score qualifies an otherwise eligible account. A ban or a confirmed duplicate identity exclusion removes an account from prize consideration. Separate Telegram accounts cannot be identified as the same person by this score logic alone.

Only occupied global podium places pay. Each settled week and player/place is unique. Run settlement through the backend transaction helper. It writes each ledger credit, balance update and trophy under the same transaction. The weekly cap is 175,000 game coins; 52 full weeks would add 9.1 million, or 0.91 times one Legend threshold distributed across winners. A player winning every week would receive 5.2 million game coins (52% of the threshold). No token allocation or conversion follows from these figures.

## Rehearsal and recovery

Use an empty disposable loopback PostgreSQL cluster with test user champ and the default postgres database. Run CHAMP_QA_PORT=<port> node test/championship-db-rehearsal.cjs from the backend root. It refuses an existing users table. Run JIGCOIN_TEST_POSTGRES_PORT=<port> npm test in the isolated environment, setting USER to its test database owner. The mobile QA runner uses generated scenarios, never live Telegram or actual payments.

Before any accepted activation, take and restore-test a consistent database backup. Verify previous daily and weekly medal IDs, ledger totals and account balances before/after the additive migration. In review, migrations 030 and 031 were applied only to synthetic fixtures. The rollback rehearsal restored an offline copy of the synthetic cluster into a separate directory and rechecked the three awards and sum. Never restore an old whole production database over subsequent gameplay. Stop new v2 starts and settlement, retain all audit tables and reconcile committed awards before any corrective decision. Reverting frontend/backend code after activation must also preserve the legacy-award cutoff and avoid retroactive awards. Have Windows Codex independently verify the post-activation procedure below before release.

Reminder delivery is opt-in, UTC only, with configurable quiet hours. An ambiguous Telegram response remains uncertain and is not automatically resent. A crash after reservation can leave an undelivered reserved item. Inspect reserved/uncertain rows before any manual recovery. No customer messages are part of QA.

## Independent verification

Verify authenticating an existing QA account, daily limits under concurrent requests, resume and round retries, 30 rendered variants, the whole app's Vault and Home entry, legacy honours, all three phone viewports and return focus. Review scoring calibration across human testers and tie frequency, especially at 1,000. No production migration, prize or rollout approval is implied.


### Post-activation rollback

Apply migrations 030 then 031 before recording activation. Migration 031 requires the existing v12 daily and v16 weekly medal tables. The first accepted activation records an independent cutoff in championship_legacy_cutoff. Immediately verify its first_week against the intended Monday and confirm both championship_daily_guard and championship_weekly_guard are enabled on the actual award tables. If these checks fail, keep activation paused.

For application rollback, quiesce the v2 workers and drain in-flight transactions. Take a consistent backup and record the per-week trophies, ledger references, user balances and legacy awards. Roll back the application binary and frontend only. Keep both migrations and the cutoff row. The two BEFORE triggers suppress legacy medal writes dated from the cutoff inclusive even with the old server and feature flag off. Earlier periods may settle normally. Do not disable triggers, roll back schema, remove an award or replay ledger entries. Inspect historical records, settled v2 totals and legacy writes after at least two legacy finalizer passes. Ordinary user activity must be reconciled separately from award credits. The disposable PostgreSQL rehearsal executes the pinned previous Git version of both legacy workers.

### Privacy and fairness checks

Observe returns only the currently visible cue, or the entire briefly visible flash/grid for simultaneous-display variants. Once time elapses, it returns only done. Memory Pairs flips are authorized per player, round and sequential turn; the backend validates the submitted transcript against recorded flips. A person can still record a legitimately displayed cue. Synthetic solving tests exercise correctness, not resistance to automated observation.

For independent calibration, record anonymous, consenting human first attempts and best runs per variant. Report the number of different people whose best-six totals tie at the podium boundary, how many separate on first-attempt skill, and how many still need residual ordering. Review completion and partial-credit distributions by variant and screen size. No default skill percentile or observed human tie frequency is assumed.


### Integrated mobile handoff

Use full Git checkouts including the previous release `bbf3963145b8e066ca3f2e994255a25cf2ec2952`. Install the backend lockfile dependencies in the disposable checkout. On the frontend QA host use Python with Playwright and Chromium. From the frontend root run `python recovery/championship-integrated.py PATH_TO_BACKEND OUTPUT_DIRECTORY`. Set `CHAMP_QA_PORT` to a **second empty disposable loopback PostgreSQL cluster** with database postgres and test owner champ. Set `CHROMIUM_PATH` if using an existing Chromium installation. The server refuses to run when public.users already exists. The separate DB rehearsal creates its own fixtures so it needs a different empty database. The backend QA server never binds a public listener.

This test boots the frontend, uses synthetic signed Telegram identities with the backend test secret, and forwards the actual championship, pilot-profile and historical leaderboard API requests. Ancillary app services are stubbed. All 30 challenges are played at each of 320×568, 390×746 and 430×832. The browser solves one round in each case; the DB rehearsal separately plays all five rounds of every variant. It also checks interactive recovery, navigation and a historical QA player's three medal collections. Compare the 90 full-view screenshots and the saved lobby/Vault screenshots with the observed touch results. Synthetic oracle-assisted play does not establish human difficulty, a native iPhone pass, or production authentication. Return the exact two Git heads, totals, errors and screenshots to the draft PR.
