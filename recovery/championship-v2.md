# Championship v2 review runbook

Keep both PRs draft. An empty championship_config table leaves the season inactive. The feature flag CHAMPIONSHIP_V2=1 is also required. No configuration seed is part of the migration. No token rules or Stars changes are included.

## Rules

The server's UTC date selects the variant from the first complete Monday after activation. Each run has five independently generated puzzles. Each correct round earns 200 points; a wrong answer earns zero. The server gives ten minutes per run, bounded by midnight. Time is a completion deadline only, with no speed bonus for low network latency. Reveal variants have a server minimum observation interval. Best of three ranked runs per day, best six of seven dates per week. Ties compare the six scores in descending order, then immutable numeric ID ascending. Practice is unranked. A positive validated score qualifies an otherwise eligible account. A ban or a confirmed duplicate identity exclusion removes an account from prize consideration. Separate Telegram accounts cannot be identified as the same person by this score logic alone.

Only occupied global podium places pay. Each settled week and player/place is unique. Run settlement through the backend transaction helper. It writes each ledger credit, balance update and trophy under the same transaction. The weekly cap is 175,000 game coins; 52 full weeks would add 9.1 million, or 0.91 times one Legend threshold distributed across winners. A player winning every week would receive 5.2 million game coins (52% of the threshold). No token allocation or conversion follows from these figures.

## Rehearsal and recovery

Use an empty disposable loopback PostgreSQL cluster with test user champ and the default postgres database. Run CHAMP_QA_PORT=<port> node test/championship-db-rehearsal.cjs from the backend root. It refuses an existing users table. Run JIGCOIN_TEST_POSTGRES_PORT=<port> npm test in the isolated environment, setting USER to its test database owner. The mobile QA runner uses generated scenarios, never live Telegram or actual payments.

Before any accepted activation, take and restore-test a consistent database backup. Verify previous daily and weekly medal IDs, ledger totals and account balances before/after the additive migration. In review, migration 030 was applied only to synthetic fixtures. The rollback rehearsal restored an offline copy of the synthetic cluster into a separate directory and rechecked the three awards and sum. Never restore an old whole production database over subsequent gameplay. Stop new v2 starts and settlement, retain all audit tables and reconcile committed awards before any corrective decision. Reverting frontend/backend code after activation must also preserve the legacy-award cutoff and avoid retroactive awards. Production rollback after activation requires a separately verified procedure.

Reminder delivery is opt-in, UTC only, with configurable quiet hours. An ambiguous Telegram response remains uncertain and is not automatically resent. A crash after reservation can leave an undelivered reserved item. Inspect reserved/uncertain rows before any manual recovery. No customer messages are part of QA.

## Independent verification

Verify authenticating an existing QA account, daily limits under concurrent requests, resume and round retries, 30 rendered variants, the whole app's Vault and Home entry, legacy honours, all three phone viewports and return focus. Review scoring calibration across human testers and tie frequency, especially at 1,000. No production migration, prize or rollout approval is implied.
