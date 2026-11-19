-- Read-only release review. Run the SELECTs separately if the client returns
-- only its last result. Owner/QA and system accounts are excluded throughout.
-- These are observed outcomes, not evidence that a layout caused an uplift.
-- Stars are not cash revenue. The existing reconciled financial view supplies
-- GBP contribution only when its complete 30-day evidence is available.

-- 1. Acquisition, first 100 accepted taps, retention and combined money outcomes.
WITH players AS (
 SELECT a.source,(j.first_open_at AT TIME ZONE 'UTC')::date AS cohort_day,j.*
 FROM jigcoin_internal.acquisition_v13 a
 JOIN jigcoin_internal.journey_v13 j USING(user_id)
 JOIN public.users u ON u.id=a.user_id
 WHERE a.is_new AND NOT a.excluded AND NOT coalesce(u.is_system_user,false)
   AND j.first_open_at IS NOT NULL
), activity AS (
 SELECT source,cohort_day,count(*) FILTER(WHERE accepted_taps>=100) AS reached_100_verified_taps
 FROM players GROUP BY source,cohort_day
), payments AS (
 SELECT p.source,p.cohort_day,
  count(r.charge_id) FILTER(WHERE r.product='coins') AS coin_pack_receipts,
  count(r.charge_id) FILTER(WHERE r.product='vip') AS vip_receipts,
  coalesce(sum(r.stars) FILTER(WHERE r.charge_id IS NOT NULL AND r.product IN('coins','vip')),0) AS pack_and_vip_stars,
  coalesce(sum(r.stars) FILTER(WHERE r.refunded_at IS NOT NULL AND r.product IN('coins','vip')),0) AS pack_and_vip_refunded_stars
 FROM players p LEFT JOIN jigcoin_internal.purchase_receipts_v13 r ON r.user_id=p.user_id
  AND coalesce(r.paid_at,r.refunded_at)>=p.first_open_at
  AND coalesce(r.paid_at,r.refunded_at)<p.first_open_at+interval '720 hours'
 GROUP BY p.source,p.cohort_day
)
SELECT s.*,a.reached_100_verified_taps,p.coin_pack_receipts,p.vip_receipts,
 p.pack_and_vip_stars,p.pack_and_vip_refunded_stars,
 p.pack_and_vip_stars-p.pack_and_vip_refunded_stars AS pack_and_vip_stars_after_refunds,
 round(100.0*s.d1_returned/nullif(s.d1_eligible,0),1) AS d1_return_percent,
 round(100.0*s.d7_returned/nullif(s.d7_eligible,0),1) AS d7_return_percent
FROM jigcoin_internal.release_scorecard_v13 s
JOIN activity a USING(source,cohort_day) JOIN payments p USING(source,cohort_day)
ORDER BY s.cohort_day DESC,s.source;

-- 2. New referral contracts: real qualification, paid rewards and friend return.
-- Pending includes joins that have not completed 100 server-accepted taps.
SELECT (r.registered_at AT TIME ZONE 'UTC')::date AS cohort_day,
 count(*) AS attributed_friends,count(r.qualified_at) AS qualified_friends,
 count(r.awarded_at) AS rewarded_invites,
 count(*) FILTER(WHERE r.awarded_at IS NULL) AS pending_invites,
 coalesce(sum(r.inviter_reward),0) AS coins_credited_to_inviters,
 count(*) FILTER(WHERE j.first_open_at IS NOT NULL AND now()>=j.first_open_at+interval '48 hours') AS d1_eligible,
 count(j.d1_return_at) FILTER(WHERE now()>=j.first_open_at+interval '48 hours') AS d1_returned,
 count(*) FILTER(WHERE j.first_open_at IS NOT NULL AND now()>=j.first_open_at+interval '192 hours') AS d7_eligible,
 count(j.d7_return_at) FILTER(WHERE now()>=j.first_open_at+interval '192 hours') AS d7_returned
FROM jigcoin_internal.referral_credits_v16 r
JOIN public.users friend ON friend.id=r.invitee_user_id
JOIN public.users inviter ON inviter.id=r.inviter_user_id
JOIN jigcoin_internal.acquisition_v13 af ON af.user_id=friend.id
JOIN jigcoin_internal.acquisition_v13 ai ON ai.user_id=inviter.id
LEFT JOIN jigcoin_internal.journey_v13 j ON j.user_id=friend.id
WHERE NOT af.excluded AND NOT ai.excluded
 AND NOT coalesce(friend.is_system_user,false) AND NOT coalesce(inviter.is_system_user,false)
GROUP BY 1 ORDER BY 1 DESC;

-- 3. Actual weekly participation per UTC start day (practice never enters runs).
SELECT r.week,(r.starts_at AT TIME ZONE 'UTC')::date AS play_day,
 count(DISTINCT r.user_id) AS ranked_players,count(*) AS ranked_runs,
 count(*) FILTER(WHERE r.score>0) AS runs_with_scored_pairs,
 round(avg(r.score),2) AS average_pairs
FROM jigcoin_internal.weekly_runs_v14 r
JOIN public.users u ON u.id=r.user_id
JOIN jigcoin_internal.acquisition_v13 a ON a.user_id=r.user_id
WHERE NOT a.excluded AND NOT coalesce(u.is_system_user,false)
GROUP BY 1,2 ORDER BY 1 DESC,2 DESC;

-- 4. Unique eligible shop viewers and confirmed purchases by UTC date.
-- Daily viewer/payer counts are funnel diagnostics, not attributable conversion:
-- a purchase can complete on a different date from its shop visit.
WITH viewers AS (
 SELECT v.visit_day AS day,count(*) AS shop_viewers
 FROM jigcoin_internal.stars_shop_visitors v
 JOIN public.users u ON u.id=v.user_id
 JOIN jigcoin_internal.acquisition_v13 a ON a.user_id=v.user_id
 WHERE NOT a.excluded AND NOT coalesce(u.is_system_user,false)
 GROUP BY v.visit_day
), receipts AS (
 SELECT (coalesce(r.paid_at,r.refunded_at) AT TIME ZONE 'UTC')::date AS day,
  count(DISTINCT r.user_id) AS paying_players,count(*) AS purchase_receipts
 FROM jigcoin_internal.purchase_receipts_v13 r
 JOIN public.users u ON u.id=r.user_id
 JOIN jigcoin_internal.acquisition_v13 a ON a.user_id=r.user_id
 WHERE r.charge_id IS NOT NULL AND r.product IN('coins','vip')
  AND NOT a.excluded AND NOT coalesce(u.is_system_user,false)
 GROUP BY 1
)
SELECT coalesce(v.day,r.day) AS day,coalesce(v.shop_viewers,0) AS shop_viewers,
 coalesce(r.paying_players,0) AS paying_players,coalesce(r.purchase_receipts,0) AS purchase_receipts
FROM viewers v FULL JOIN receipts r USING(day) ORDER BY 1 DESC;

-- Refill confirmation, retries/no-fill, loading observations, cooldown cohorts,
-- provider estimates and reconciled ad income remain in refill_scorecard_v15.sql.
-- Do not add estimates in USD to settled Stars income in GBP.
