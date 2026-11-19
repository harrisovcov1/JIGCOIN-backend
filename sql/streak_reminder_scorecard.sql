-- Streak reminders. Use the first full UTC cohort after launch so every entrant
-- had access to the feature. Compare players who opted in on their first day
-- with other entrants from the same cohort. This is observational: players who
-- return to claim a streak may already be more likely to pay or play again.
WITH players AS (
  SELECT p.user_id, p.enrolled_at, p.returned_day7_at,
         (p.enrolled_at AT TIME ZONE 'UTC')::date AS cohort_day,
         EXISTS (
           SELECT 1 FROM jigcoin_internal.daily_streak_reminders r
           WHERE r.user_id=p.user_id
             AND r.target_day=(p.enrolled_at AT TIME ZONE 'UTC')::date+1
         ) AS opted_in_first_day
  FROM jigcoin_internal.pilot_players_v14 p
  JOIN jigcoin_internal.acquisition_v13 a USING (user_id)
  JOIN public.users u ON u.id=p.user_id
  WHERE NOT a.excluded AND NOT u.is_system_user
    AND p.enrolled_at >= timestamptz '2026-11-20 00:00:00+00'
), totals AS (
  SELECT p.*, receipts.stars_after_refunds
  FROM players p
  CROSS JOIN LATERAL (
    SELECT COALESCE(sum(r.stars) FILTER (WHERE r.refunded_at IS NULL),0) AS stars_after_refunds
    FROM jigcoin_internal.purchase_receipts_v13 r
    WHERE r.user_id=p.user_id AND r.charge_id IS NOT NULL
      AND r.paid_at>=p.enrolled_at AND r.paid_at<p.enrolled_at+interval '720 hours'
  ) receipts
)
SELECT cohort_day, opted_in_first_day, count(*) AS enrolled_players,
       count(*) FILTER (WHERE now()>=enrolled_at+interval '192 hours') AS d7_eligible,
       round(100.0*count(returned_day7_at) FILTER (WHERE now()>=enrolled_at+interval '192 hours')
             /nullif(count(*) FILTER (WHERE now()>=enrolled_at+interval '192 hours'),0),1) AS d7_return_percent,
       count(*) FILTER (WHERE now()>=enrolled_at+interval '720 hours') AS d30_eligible,
       round(avg(stars_after_refunds) FILTER (WHERE now()>=enrolled_at+interval '720 hours'),2) AS d30_net_stars_per_player
FROM totals GROUP BY cohort_day, opted_in_first_day ORDER BY cohort_day DESC, opted_in_first_day;

-- Operational outcomes by *requested reward day*. Includes cancellations and
-- delivery suppressed after a claim. Telegram acceptance does not prove a read.
SELECT r.target_day, r.state, count(*) AS reminders
FROM jigcoin_internal.daily_streak_reminders r
JOIN jigcoin_internal.acquisition_v13 a USING (user_id)
JOIN public.users u ON u.id=r.user_id
WHERE NOT a.excluded AND NOT u.is_system_user
GROUP BY r.target_day, r.state ORDER BY r.target_day DESC, r.state;
