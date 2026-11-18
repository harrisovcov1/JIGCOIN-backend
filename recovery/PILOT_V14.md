# JigCoin revenue pilot

The 500-Star VIP pass lasts 30 days from purchase and keeps the existing tap and energy benefits. An active VIP can equip Midnight Crown in Vault. Free play includes the daily streak, the 100-tap challenge and a weekly puzzle race. Rank thresholds and the existing purchase catalogue carry forward.

## Release

1. Release the backend first. On the current Supabase database with the v13 tracking schema installed, apply `sql/migrations/024_revenue_pilot.sql` followed by `sql/migrations/025_mint_race_cards.sql`. Both are additive and safe to rerun. Alternatively, set `JIGCOIN_INSTALL_PILOT_SCHEMA=1` on the new Render API release to install both migrations before the API accepts traffic. A successful startup logs `JIGCOIN weekly races and Mint result cards ready (024/025)`. Existing v13 clients remain usable during this sequence. Keep the existing provider, Stars and support settings.
2. Check that the Render service reports the new backend revision and passes its health check. Publish the matching frontend revision through the existing Cloudflare Pages project. Open the mini app on an ordinary Telegram account as well as the owner account.
3. Verify that Rewards offers free play at full energy and an optional refill at 20% capacity or less. If an ad has no fill, return to the game. Verify that a real completed ad produces a provider receipt and one refill. A confirmed receipt from a retired placement stays claimable. The SDK returning successfully alone grants no reward.
4. Verify the two shop examples. A saved balance of 17,800 highlights the 3,000-coin pack at 250 Stars, showing 20,800 after purchase. At 49,000, the 1,000-coin pack at 100 Stars reaches Operator at 50,000. Larger packs stay under “All other coin packs.” Verify the 500-Star VIP price, terms, receipt and entitlement using Telegram's test environment or an independently authorized purchase.
5. Play a weekly race, resume after leaving, and share the resulting challenge link with a second consenting player. A scored pair saves immediately. Finish a run on each account, open the friend’s challenge and share the result. Check the recorded finishes, score margin, saved PNG and Rematch. Reopen the original result after the rematch. Each new run uses one of the same three weekly attempts. Check both accounts’ standings, remaining runs and Vault medal after the UTC week closes. Runs completed before migration 025 show “Finish unrecorded”.

## Two events before expansion

Run two consecutive full UTC weeks with the same invited group. Each player gets three free 45-second runs per week. Every slot uses the same puzzle values for everyone. A player's best run counts. The weekly winner receives a dated gold medal and positive-score ties share it. Spending and ads cannot change race scores. The first pilot can launch with the low-energy refill and the current VIP price.

After both events, run `sql/pilot_scorecard_v14.sql`. Inspect the number who entered the first week and came back for the second, the number of players eligible for a day-seven return, successful VIP purchases and refunds. The first report includes every enrolled, non-excluded player with an acquisition record, including people who buy nothing. The second reports event participation. Owner and QA accounts should be excluded in the existing acquisition configuration.

To compare ads with free play alone, set `JIGCOIN_REFILL_TEST=1` before enrolling a fresh pilot group. New players are assigned to refill or holdout. Existing assignments stay stable. Compare those two groups from the same enrolment dates. The earlier baseline is descriptive. Change one offer at a time.

Use actual provider settlements and acquisition expenses in `jigcoin_internal.pilot_finance_v14`. Each row covers the first 30 days for one UTC enrolment date and ad group. Record net Stars proceeds after fees and refunds, net ad proceeds, additional delivery costs and acquisition costs. Attach a reconciliation reference. Deduct each cost once. Leave unverified groups without a finance row. Currency metrics appear only after the whole cohort completes 30 days.

Expand when the tested cohort shows repeat play, payment fulfilment works and reconciled contribution per player after acquisition is positive. Compare retention alongside that contribution. Small cohorts or unclear results call for another pilot before spending on acquisition.
