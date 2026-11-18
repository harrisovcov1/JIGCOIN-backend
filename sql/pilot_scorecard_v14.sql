-- Owner reports. Run both SELECTs using the same database as the mini app.
-- Includes existing and new pilot players. Acquisitions excluded from analytics
-- (e.g. owner/QA) and system accounts are excluded from both reports.
WITH players AS (
  SELECT p.user_id, p.enrolled_at, p.returned_day7_at, p.ad_group,
         (p.enrolled_at AT TIME ZONE 'UTC')::date AS cohort_day
  FROM jigcoin_internal.pilot_players_v14 p
  JOIN jigcoin_internal.acquisition_v13 a USING (user_id)
  JOIN public.users u ON u.id = p.user_id
  WHERE NOT a.excluded AND NOT u.is_system_user
), payments AS (
  SELECT p.user_id,
         count(r.charge_id) AS purchases,
         count(r.charge_id) FILTER (WHERE r.product = 'vip') AS vip_purchases,
         coalesce(sum(r.stars), 0) AS paid_stars,
         coalesce(sum(r.stars) FILTER (WHERE r.refunded_at IS NOT NULL), 0) AS refunded_stars
  FROM players p LEFT JOIN jigcoin_internal.purchase_receipts_v13 r
    ON r.user_id = p.user_id AND r.charge_id IS NOT NULL
   AND coalesce(r.paid_at,r.refunded_at) >= p.enrolled_at
   AND coalesce(r.paid_at,r.refunded_at) < p.enrolled_at + interval '720 hours'
  GROUP BY p.user_id
), cohorts AS (
  SELECT p.cohort_day, p.ad_group, count(*) AS players,
         count(*) FILTER (WHERE now() >= p.enrolled_at + interval '192 hours') AS d7_eligible,
         count(p.returned_day7_at) FILTER (WHERE now() >= p.enrolled_at + interval '192 hours') AS d7_returned,
         count(*) FILTER (WHERE m.purchases > 0) AS payers,
         sum(m.purchases) AS purchases, sum(m.vip_purchases) AS vip_purchases,
         sum(m.paid_stars) AS paid_stars, sum(m.refunded_stars) AS refunded_stars,
         bool_and(now() >= p.enrolled_at + interval '720 hours') AS window_complete
  FROM players p JOIN payments m USING (user_id)
  GROUP BY p.cohort_day, p.ad_group
)
SELECT c.*, round(100.0*c.d7_returned/nullif(c.d7_eligible,0), 1) AS d7_percent,
       CASE WHEN c.window_complete THEN f.ads_net_gbp END AS ads_30d_gbp,
       CASE WHEN c.window_complete THEN f.stars_net_gbp END AS stars_30d_gbp,
       CASE WHEN c.window_complete THEN
         round((f.stars_net_gbp+f.ads_net_gbp-f.delivery_cost_gbp-f.acquisition_cost_gbp)/c.players, 4)
       END AS contribution_after_acquisition_per_player_gbp
FROM cohorts c LEFT JOIN jigcoin_internal.pilot_finance_v14 f USING (cohort_day, ad_group)
ORDER BY c.cohort_day DESC, c.ad_group;

-- A rematch is participation in two consecutive UTC event weeks.
WITH entrants AS (
  SELECT r.week, r.user_id, r.best
  FROM jigcoin_internal.weekly_racers_v14 r
  JOIN jigcoin_internal.acquisition_v13 a USING (user_id)
  JOIN public.users u ON u.id=r.user_id
  WHERE NOT a.excluded AND NOT u.is_system_user
)
SELECT e.week, count(*) AS entrants, count(*) FILTER (WHERE e.best>0) AS scored,
       count(n.user_id) AS returned_next_week,
       CASE WHEN (now() AT TIME ZONE 'UTC')::date >= e.week+14 THEN
         round(100.0*count(n.user_id)/count(*), 1)
       END AS completed_rematch_percent
FROM entrants e LEFT JOIN entrants n ON n.user_id=e.user_id AND n.week=e.week+7
GROUP BY e.week ORDER BY e.week DESC;
