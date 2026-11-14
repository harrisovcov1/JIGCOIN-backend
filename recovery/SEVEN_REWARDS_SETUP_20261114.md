# JigCoin: seven rewards and reliable account loading

This package follows frontend commit `1d98e3d` and backend commit `85e3d3b`. Those uploads were verified against the previous repair; the frontend was serving the exact uploaded bytes and backend health reported `db: up`. This NEW package has been tested locally and is not deployed yet.

## Install in this order

1. Open the JIGCOIN Supabase project (`rvglsktxkorvasdxjcpg`), SQL Editor, new query. Paste the **entire** `sql/RUN_FIRST_seven_rewards_20261114.sql` file and Run as postgres. Expect `PASS — seven rewards, starter ledger and reviewed permissions installed`. It is one transaction. If it errors, stop before uploading the new code and provide the error text. Do not reset balances or cooldowns.
2. Extract `JIGCOIN_backend_seven_rewards_20261114.zip`. Upload its **contents** to the root of `harrisovcov1/JIGCOIN-backend`, retaining the `lib`, `sql`, `test` and `recovery` folders. Replace matching files and commit to main. Keep the other repository files, especially `package.json`, `package-lock.json`, and existing modules.
3. On Render, open **My project → jigcoin-api → Environment → Edit**. Set `RECOVERY_TEST_ENABLED` to `1`; retain `RECOVERY_TEST_TELEGRAM_ID=7888995060`. Keep `MAINTENANCE_MODE=1`, `MONETAG_REWARDS_ENABLED=0`, `DISABLE_AD_REWARDS=1`, `DISABLE_SPONSOR_MISSIONS=1`, `DISABLE_WITHDRAWALS=1`, `RUN_MODE=api`, `DISABLE_BOT_POLLING=1`, and `AUTO_MIGRATE=0`. Keep all secrets unchanged. Save, then Manual Deploy → Deploy latest commit if saving did not deploy that commit. Wait for Deploy succeeded / Live.
4. Extract `JIGCOIN_frontend_seven_rewards_20261114.zip` and upload its `index.html` to the root of `harrisovcov1/JIGCOIN-frontend`. Commit. Wait for the matching Cloudflare Pages deployment to show the green successful production status.
5. Fully close the Telegram mini app and reopen it using the owner account `@jigcoinofficial`. This refreshes signed Telegram authentication. The private test session lasts one hour; reopen after expiry. Opening the Pages URL in a normal browser does not grant tester access.

The earlier screenshot showed `RECOVERY_TEST_ENABLED=0`: that is why the owner was blocked by maintenance. The new code keeps public maintenance on but lets the signed owner test saved state, global ranking, taps and all seven ad rewards. It does not grant a username-based bypass. Purchases, withdrawals, referral writes, daily check-in and legacy ad callbacks remain outside this test release.

## Test all seven in one session, one ad at a time

| Placement | Confirmed reward | Existing cooldown |
|---|---|---|
| Daily ad bonus 1 | 200 coins | 24 hours after claim |
| Daily ad bonus 2 | 200 coins | 24 hours after claim |
| Daily ad bonus 3 | 200 coins | 24 hours after claim |
| Daily ad bonus 4 | 200 coins | 24 hours after claim |
| Daily ad bonus 5 | 200 coins | 24 hours after claim |
| Energy refill | Full effective energy cap | 24 hours after claim |
| Double points | x2 tap reward for 10 minutes | 24 hours after claim |

All seven appear in Sponsor quests. The two Boost cards open their corresponding ad reward. The boost cards no longer spend coins or award a boost merely for opening a sponsor link.

- First confirm the header balance/rank are readable, the page scrolls, and the bottom navigation does not cover the content. During connection delays, the page shows a loading/connection message, not a fabricated rank.
- Your earlier **Daily ad bonus 1** claim remains credited and on cooldown until approximately **15 November 2026, 02:24 UTC**. Its earlier successful provider/ledger proof counts; do not reset it for another test.
- For bonuses 2–5: press Start, complete the ad, wait for **Claim**, then claim. Each should add 200 once. Starting or closing an unconfirmed ad must not add coins. With your existing bonus 1, the five verified quests total 1,000 coins across their five claims.
- Use **Test tap** several times before testing energy refill. Confirm energy falls and balance increases. Open Energy refill, complete/claim its ad, and confirm the full effective bar returns. This reward adds no coins.
- Complete/claim Double points. Confirm the ten-minute countdown. Compare a tap before/after: the active x2 multiplies the existing tap reward, including any applicable streak multiplier. Reopening must preserve the remaining duration, not restart it. Once expired, tapping returns to the normal multiplier.
- Reopen the mini app to confirm saved balance, rank, energy, boost expiry and cooldowns. Existing queued taps from before maintenance are deliberately not replayed by private Test tap.
- Run **the entire** `sql/verify_seven_owner_rewards.sql` in a new Supabase query, then export/send its CSV with an updated phone screenshot. It returns all seven placements, provider confirmations, actual coin credits, boost fulfillment and per-cycle claim counts. For each claimed placement: one claim this cycle; at least one valued receipt; coin placements show 200, boost placements show their fulfillment. It does not mutate data.

## What was checked

- 43 frontend tests: balance reconciliation, loading/retry/authentication, countdown recovery, seven reward labels/actions, and safe private tap retry.
- 37 backend tests: verified ad ownership, forged callbacks, duplicate delivery, concurrency, rollback, seven reward fulfillment, x2 taps/expiry, energy limits, private access and global rank consistency.
- Restored the supplied database's public schema, ownership, grants, constraints, triggers and data into isolated PostgreSQL. Applied the complete SQL twice; existing public row fingerprints were unchanged.
- Four simultaneous first-open requests for a synthetic new user all returned 5,000 coins with exactly one matching starter ledger/event award.
- All seven reward flows passed against the restored schema. The shipped verification query returned seven correct rows.
- Parsed both inline frontend scripts; no duplicate element IDs.

The local tests use synthetic callbacks, not real ad views or purchases. New live ads and iPhone layout have not been tested by the assistant. Real purchase delivery is not claimed as passed.

## Remaining launch work

1. Confirm the above on the owner's phone and inspect the live seven-row proof. Keep public maintenance on during this check.
2. Complete Telegram Stars checkout for coin packs, with verified successful-payment handling, exact-once fulfillment, receipts, cancellation and refund tests. Current legacy Stripe/Coinbase flows are not approved by this package. Digital goods sold inside Telegram must use Stars: https://core.telegram.org/bots/payments-stars . No prices or payments were changed here.
3. Verify daily check-in, referral awards and any paid boosts separately before public access. Keep suspended legacy workers stopped.
4. Move **jigcoin-api itself** to a paid compute instance before expecting consistent production startup. Render Free sleeps after 15 idle minutes and can take about one minute to wake: https://render.com/docs/free . A workspace-plan upgrade alone does not change the service's compute tier. No hosting purchase was made.
5. Use real bonus capacity and server expiry times, clear reward value and measured purchase conversion. Do not invent player counts, scarcity or token-return promises. The existing starter campaign remains 5,000 coins once for the first 1,000 awards; it is not an unlimited grant to every future signup.

Revenue and player growth cannot be guaranteed. The immediate objective is trustworthy progress, reliable rewards and checkout before expanding promotion.
