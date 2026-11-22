-- Read-only. One row per UTC first-open date and acquisition source.
-- acquisition_gbp includes paid acquisition and affiliate commissions that have
-- not already been deducted from settlement. Record the breakdown and source
-- documents in allocation_method/evidence_ref. Reconcile later refunds to the
-- original cohort. An unknown amount must never be entered as zero.
WITH orders AS (
  SELECT a.source, (j.first_open_at AT TIME ZONE 'UTC')::date AS cohort_day,
         r.product, count(*) AS receipts, sum(r.stars) AS charged_stars,
         sum(CASE WHEN r.refunded_at IS NOT NULL THEN r.stars ELSE 0 END) AS refunded_stars
  FROM jigcoin_internal.acquisition_v13 a
  JOIN jigcoin_internal.journey_v13 j USING (user_id)
  JOIN public.users u ON u.id = a.user_id
  JOIN jigcoin_internal.purchase_receipts_v13 r USING (user_id)
  WHERE a.is_new AND NOT a.excluded AND NOT u.is_system_user
    AND r.charge_id IS NOT NULL
    AND coalesce(r.paid_at,r.refunded_at) >= j.first_open_at
    AND coalesce(r.paid_at,r.refunded_at) < j.first_open_at + interval '720 hours'
  GROUP BY 1,2,3
), products AS (
  SELECT source, cohort_day, jsonb_object_agg(product, jsonb_build_object(
     'receipts',receipts,'charged_stars',charged_stars,'refunded_stars',refunded_stars)) AS breakdown
  FROM orders GROUP BY 1,2
)
SELECT c.cohort_day,c.source,c.players,c.intro_completed,c.first_session_activated,
       c.d1_eligible,c.d1_returned,c.d7_eligible,c.d7_returned,c.d30_retention_eligible,c.d30_returned,
       coalesce(p.breakdown,'{}'::jsonb) AS orders_by_product,
       c.purchase_gbp,c.refund_gbp,c.ads_gbp AS settled_ads_gbp,c.direct_cost_gbp,
       c.acquisition_gbp AS acquisition_including_commission_gbp,c.cash_received_gbp,
       c.evidence_complete,c.contribution_window_elapsed,
       CASE WHEN c.evidence_complete AND c.contribution_window_elapsed
            THEN c.purchase_gbp-c.refund_gbp+c.ads_gbp-c.direct_cost_gbp-c.acquisition_gbp
       END AS net_contribution_30d_gbp,
       c.observed_30d_contribution_per_player_gbp-c.acquisition_cost_per_player_gbp
         AS net_contribution_per_player_gbp
FROM jigcoin_internal.release_scorecard_v13 c
LEFT JOIN products p USING (source,cohort_day)
ORDER BY c.cohort_day DESC,c.source;
