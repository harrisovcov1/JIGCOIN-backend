# JigCoin integrated release v16

Prepared on 19 November 2026. This document describes the approved release contract and deployment procedure; it is not evidence of a production deployment.

## Scope

The existing working energy-refill integration remains intact. This release connects Shop, VIP, Invite, Vault, Leaderboard and Weekly Race around the same account balance, verified activity and recorded entitlements.

### Shop and VIP

- Present the product as **JigCoin VIP Pass**, with a separate crown badge. The optional Midnight Crown coin cosmetic remains available to entitled players and does not replace their rank identity automatically.
- Retain 500 Stars for 30 days, double tap coins and double energy capacity, one payment and no automatic renewal. Capacity does not imply faster regeneration or an instant free refill.
- Shop and Vault open the same detailed VIP review, including actual before/after benefits, active/expired status, verified payment flow and purchase help.
- Show all five permanent packs in ascending order. Prices and quantities remain server-owned and unchanged:

| Coins | Stars | Coins per Star |
|---:|---:|---:|
| 1,000 | 100 | 10 |
| 3,000 | 250 | 12 |
| 7,000 | 500 | 14 |
| 37,500 | 2,500 | 15 |
| 700,000 | 35,000 | 20 |

- Remove the oversized shop hero and hidden pack accordion. Show truthful balance and rank outcomes, and identify the largest pack as “Most coins per Star.”
- Preserve existing invoice ownership, receipt verification, consent, replay protection, refund behavior and paused-sale controls.

### Invite

- Use connected-person artwork and the message “Bring a friend. Start a rivalry.” Referral rewards use the existing game balance, not a second currency.
- New attributed registrations use `referrals_cumulative_v16`: the inviter is rewarded after the new friend completes 100 committed, server-accepted taps across sessions and UTC dates. Ad completion, purchased coins and client-reported totals do not qualify.
- The general 1,000-coin welcome remains available to every new account. It is not represented as an exclusive referral bonus.
- Preserve the original qualification and amounts for all v9/v10 referrals and historical credits.
- Reward tiers are determined by the serialized successful-invite ordinal: 1–4 = 500; 5–19 = 1,000; 20–49 = 1,250; 50–199 = 1,500; 200 onward = 2,000. The threshold invite earns the new rate, not an additional bonus.
- Show actual joined, playing, qualified, rewarded and held states; share actions never grant a reward. The authenticated incoming invitation identifies the actual inviter and the stored qualification rule without exposing Telegram IDs or private contact details.
- `qualified_at` records the first settlement observing the 100 accepted taps, not necessarily the precise timestamp of the hundredth tap. `awarded_at` and the inviter ledger ID identify settled rewards.

### Vault and leaderboard

- Make Vault a compact view of saved balance, current/next rank finish, VIP status, earned medals, and purchase/reward history routes.
- Display the airdrop status as **Planned · Rules awaiting publication**. Do not promise allocation, token value, withdrawals or a monetary return from purchases.
- Preserve a player’s coin artwork on the podium; place numbers and VIP crowns are separate badges.
- Use compact one- and two-player standings. Do not invent competitors or describe a solo entrant as defending against other players.
- Today ranks confirmed tap coins, including valid tap multipliers. Global and Friends rank saved in-game balances, which include purchases and rewards. Friends are actual referral connections.
- Rival gaps use the exact next ordinal target. Earned medals are distinguished from live standings.

### Weekly Race

- Keep the current three-ranked-runs-per-week rule through 22 November 2026.
- From **23 November 2026 at 00:00 UTC**, offer three free ranked 45-second runs per UTC day, with no carryover. The weekly best score counts. Free and VIP players have the same allowance.
- Charge a run to its UTC start date. A run crossing midnight resumes without consuming the next day’s allowance. Block new ranked starts during the final 45 seconds of the week.
- Keep ranked and practice requests, puzzle seeds and storage separate. Practice is unlimited and unranked; it cannot award coins, medals or ranked attempts.
- Make start, answer and completion retry-safe. A server deadline determines completion; client scores and early-end requests are not trusted.
- Use Global and real referral Friends comparisons. Finalize weekly results once and store dated, immutable awards. Every eligible positive highest-score tie earns gold; existing historical winners remain preserved.
- Freeze result-card rank/VIP/coin appearance at the run, without inferring past entitlements from today’s balance.

## Database and server changes

Apply these additive migrations in order, before starting the new server:

1. `sql/migrations/20261119172826_referral_cumulative_activation.sql`
2. `sql/migrations/20261119172851_weekly_daily_runs_and_awards.sql`

They require the existing v9/v10 referral, v14 weekly race and Mint result-card migrations. New tables remain in `jigcoin_internal`, with row-level security enabled and browser-role access revoked. No existing balances, paid entitlements or referral credits are rewritten.

The weekly migration derives the allowance date and quota policy in an insert trigger. The old server’s INSERT remains valid during migration-first rollout. Persisted `puzzle_version` is separate from quota policy, so the upgraded server can evaluate a run created by an older instance correctly.

The backend checks schema readiness before accepting traffic. It exposes the new ranked completion and practice routes through the existing authenticated route dispatcher, runs the weekly finalizer on startup and once per minute, and identifies itself as `v16-integrated-1` in the health response.

## Verification completed locally

The integrated backend suite passed **134/134 tests with zero failures and zero skipped tests**, using an isolated PostgreSQL 17 database. It covers payment/reward atomicity, receipt replay, energy/refill behavior, referral contracts and privacy, real daily leaderboard functions, daily race boundaries, concurrent starts and answers, immutable awards, practice isolation and old-server migration compatibility.

The focused new suites include 16 referral tests and 23 combined existing/new weekly tests. The daily leaderboard tests use the actual production SQL function definitions in an isolated fixture; they verify the distinction between one player scoring today and 142 eligible global accounts.

Frontend regression results and mobile preview review are recorded with the frontend release. A passing synthetic check does not establish that a real Telegram payment or advert completed, or that this release increases revenue.

## Measurement

`sql/integrated_scorecard_v16.sql` provides read-only reports for first 100 accepted taps, qualified referrals, D1/D7 return, actual coin-pack and VIP receipts, refunds, unique shop viewers, and ranked participation. The existing `refill_scorecard_v15.sql` retains advert confirmation, no-fill, loading and cooldown-trial evidence.

Owner/QA and system accounts are excluded from the reported cohorts. Stars are not treated as cash revenue. Only the existing reconciled financial view supplies evidenced currency contribution. Viewer and payer counts are diagnostics, not proof of causal conversion uplift.

## Deployment order and acceptance

1. Review both final diffs and publish the frontend-only synthetic preview to the existing isolated preview branch. Verify at 320, 390 and 430 CSS-pixel widths, including scrolling, active/expired VIP, solo standings, exhausted ranked runs, and referral progress.
2. Apply the two database migrations to the existing JigCoin Supabase project. Recheck required tables, constraints, grants and advisors against the recorded baseline.
3. Publish/merge the reviewed backend commit to the existing `harrisovcov1/JIGCOIN-backend` main branch. Trigger its existing Render service explicitly; automatic deployment is disabled.
4. Wait for the correct Render revision to be live, then verify HTTP health reports `release: v16-integrated-1`, the database is up, unsigned protected requests are rejected, and startup logs show schema readiness.
5. Publish/merge the reviewed frontend commit to the existing `harrisovcov1/JIGCOIN-frontend` main branch. Verify the matching **Cloudflare Pages** deployment and the live build marker `v16-integrated-1`. The unrelated legacy Workers check is not the Pages deployment.
6. Check the live app’s available account states without spending Stars or sending invitation messages. A real Telegram payment or advert requires separate observed evidence before it can be reported as verified.

Do not include `recovery/integrated-review.html` or the mobile preview wrapper from the preview branch in the production merge. Those files use simulated accounts and responses.

## Recovery

Before 23 November, the additive schema remains compatible with the old server’s weekly starts. Do not roll back migrations by deleting award or referral data.

After the daily policy activates, retain the upgraded weekly handlers or use a forward fix. Reverting completely to v14 would restore three runs per week and remove practice/end routes. Waiting 45 seconds drains a live puzzle but does not preserve those new entitlements. Existing immutable awards and new pending referral contracts must remain intact.

## Open acceptance items

- Publication and deployment of this release are not yet complete.
- Corrected synthetic mobile preview publication and visual verification are outstanding.
- No new real-money Telegram transaction or real-provider advert was initiated during these local checks.
- Revenue uplift must be measured from eligible live cohorts after release; it cannot be guaranteed from UI changes alone.
