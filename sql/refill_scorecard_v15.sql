-- Read-only owner report. One row per UTC assignment day and cooldown cohort.
-- The 30-day window starts at this experiment's assignment, not v14 enrolment.
-- Client observations are not impressions. Estimated USD is never settled GBP.
WITH players AS (
  SELECT p.*, (p.assigned_at AT TIME ZONE 'UTC')::date AS cohort_day
  FROM jigcoin_internal.refill_cohorts_v15 p
  JOIN public.users u ON u.id=p.user_id
  LEFT JOIN jigcoin_internal.acquisition_v13 a USING(user_id)
  LEFT JOIN jigcoin_internal.pilot_players_v14 old USING(user_id)
  WHERE p.cohort IN ('control_300','treatment_120') AND NOT p.excluded
    AND NOT coalesce(a.excluded,FALSE) AND NOT coalesce(u.is_system_user,FALSE)
    AND coalesce(old.ad_group,'baseline')<>'holdout'
), attempts AS (
  SELECT p.user_id,count(a.id) AS attempts,
    count(a.id) FILTER(WHERE a.eligible_at<p.assigned_at+interval '720 hours') AS confirmed,
    count(a.id) FILTER(WHERE a.claimed_at<p.assigned_at+interval '720 hours') AS claimed,
    coalesce(sum(receipts.estimated_usd),0) AS estimated_ad_usd
  FROM players p LEFT JOIN jigcoin_internal.ad_attempts a ON a.user_id=p.user_id
    AND a.refill_policy_version=p.policy_version AND a.refill_group=p.cohort
    AND a.created_at>=p.assigned_at AND a.created_at<p.assigned_at+interval '720 hours'
  LEFT JOIN LATERAL (
    SELECT sum(e.estimated_price) AS estimated_usd FROM jigcoin_internal.monetag_events e
    WHERE e.attempt_id=a.id AND e.event_type='impression' AND e.reward_event_type='valued'
      AND e.received_at<p.assigned_at+interval '720 hours'
  ) receipts ON TRUE GROUP BY p.user_id
), observations AS (
  SELECT p.user_id,
    count(e.id) FILTER(WHERE e.event='PROMPT_SHOWN') AS prompt_observations,
    count(e.id) FILTER(WHERE e.event='PREPARED') AS prepared_attempts,
    count(e.id) FILTER(WHERE e.event='PREPARED_EXPIRED') AS expired_preparations
  FROM players p LEFT JOIN jigcoin_internal.refill_events_v15 e ON e.user_id=p.user_id
    AND e.policy_version=p.policy_version AND e.cohort=p.cohort
    AND e.created_at>=p.assigned_at AND e.created_at<p.assigned_at+interval '720 hours'
  GROUP BY p.user_id
), payments AS (
  SELECT p.user_id,count(r.charge_id) AS purchases,
    count(r.charge_id) FILTER(WHERE r.product='vip') AS vip_purchases,
    coalesce(sum(r.stars) FILTER(WHERE r.charge_id IS NOT NULL),0) AS paid_stars,
    coalesce(sum(r.stars) FILTER(WHERE r.refunded_at IS NOT NULL),0) AS refunded_stars
  FROM players p LEFT JOIN jigcoin_internal.purchase_receipts_v13 r ON r.user_id=p.user_id
    AND coalesce(r.paid_at,r.refunded_at)>=p.assigned_at
    AND coalesce(r.paid_at,r.refunded_at)<p.assigned_at+interval '720 hours'
  GROUP BY p.user_id
), cohorts AS (
  SELECT p.policy_version,p.cohort_day,p.cohort,p.cooldown_seconds,count(*) AS players,
    count(*) FILTER(WHERE now()>=p.assigned_at+interval '192 hours') AS d7_eligible,
    count(p.returned_day7_at) FILTER(WHERE now()>=p.assigned_at+interval '192 hours') AS d7_returned,
    count(*) FILTER(WHERE m.purchases>0) AS payers,sum(m.purchases) AS purchases,
    sum(m.vip_purchases) AS vip_purchases,sum(m.paid_stars) AS paid_stars,sum(m.refunded_stars) AS refunded_stars,
    sum(a.attempts) AS attempts,sum(a.confirmed) AS confirmed,sum(a.claimed) AS claimed,
    sum(a.estimated_ad_usd) AS estimated_ad_usd,
    sum(o.prompt_observations) AS prompt_observations,sum(o.prepared_attempts) AS prepared_attempts,
    sum(o.expired_preparations) AS expired_preparations,
    bool_and(now()>=p.assigned_at+interval '720 hours') AS window_complete
  FROM players p JOIN attempts a USING(user_id) JOIN observations o USING(user_id)
    JOIN payments m USING(user_id)
  GROUP BY p.policy_version,p.cohort_day,p.cohort,p.cooldown_seconds
)
SELECT c.*,round(100.0*c.d7_returned/nullif(c.d7_eligible,0),1) AS d7_percent,
  round(100.0*c.confirmed/nullif(c.attempts,0),1) AS attempt_confirmation_percent,
  CASE WHEN c.window_complete AND f.coverage_complete THEN f.ads_net_gbp END AS ads_net_30d_gbp,
  CASE WHEN c.window_complete AND f.coverage_complete THEN f.stars_net_gbp END AS stars_net_30d_gbp,
  CASE WHEN c.window_complete AND f.coverage_complete THEN
    round((f.ads_net_gbp+f.stars_net_gbp-f.delivery_cost_gbp-f.acquisition_cost_gbp)/c.players,4)
  END AS contribution_after_acquisition_per_player_gbp
FROM cohorts c LEFT JOIN jigcoin_internal.refill_finance_v15 f USING(policy_version,cohort_day,cohort)
ORDER BY c.cohort_day DESC,c.cohort;

-- Bounded diagnostic categories, restricted to server-versioned refill attempts.
SELECT p.policy_version,p.cohort,e.meta->>'stage' AS stage,e.meta->>'error_code' AS outcome,
  count(*) AS reports,count(DISTINCT a.ymid) AS attempts
FROM public.event_log e
JOIN jigcoin_internal.ad_attempts a ON a.ymid::text=e.meta->>'attempt_id' AND a.user_id=e.user_id
JOIN jigcoin_internal.refill_cohorts_v15 p ON p.user_id=a.user_id AND p.policy_version=a.refill_policy_version
JOIN public.users u ON u.id=p.user_id
LEFT JOIN jigcoin_internal.acquisition_v13 ac ON ac.user_id=p.user_id
LEFT JOIN jigcoin_internal.pilot_players_v14 old ON old.user_id=p.user_id
WHERE e.event='reward_client_outcome_v1' AND a.code='sp_emergency_energy'
  AND p.cohort IN ('control_300','treatment_120') AND NOT p.excluded
  AND NOT coalesce(ac.excluded,FALSE) AND NOT coalesce(u.is_system_user,FALSE)
  AND coalesce(old.ad_group,'baseline')<>'holdout'
  AND e.created_at>=p.assigned_at AND e.created_at<p.assigned_at+interval '720 hours'
GROUP BY p.policy_version,p.cohort,e.meta->>'stage',e.meta->>'error_code'
ORDER BY p.cohort,reports DESC;
