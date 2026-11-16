-- Read-only. This pilot is owner-only: its results are functional test data, NOT market conversion evidence.
-- UTC report. Viewers are distinct accounts requesting the enabled catalogue that day.
-- Completed orders are grouped by creation day (an order cohort); late payment/refund updates that cohort.
-- Stars retained are XTR amounts, not GBP revenue, payout value or profit.
WITH visitors AS (
 SELECT visit_day AS day,count(*) AS shop_viewers
 FROM jigcoin_internal.stars_shop_visitors GROUP BY visit_day
), orders AS (
 SELECT (created_at AT TIME ZONE 'UTC')::date AS day,count(*) AS orders_started,
 count(*) FILTER(WHERE paid_at IS NOT NULL) AS paid_orders,
 count(DISTINCT user_id) FILTER(WHERE paid_at IS NOT NULL) AS paying_users,
 count(*) FILTER(WHERE status='refunded') AS refunded_orders,
 coalesce(sum(stars) FILTER(WHERE status='paid'),0) AS stars_retained,
 coalesce(sum(unrecovered_coins),0) AS refund_coins_to_reconcile
 FROM jigcoin_internal.stars_orders GROUP BY 1
)
SELECT coalesce(v.day,o.day) AS utc_day,coalesce(v.shop_viewers,0) AS shop_viewers,
 coalesce(o.orders_started,0) AS orders_started,coalesce(o.paid_orders,0) AS paid_orders,
 coalesce(o.paying_users,0) AS paying_users,coalesce(o.refunded_orders,0) AS refunded_orders,
 coalesce(o.stars_retained,0) AS stars_retained,coalesce(o.refund_coins_to_reconcile,0) AS refund_coins_to_reconcile
FROM visitors v FULL JOIN orders o ON o.day=v.day ORDER BY utc_day DESC;
-- Private product comparison. No 'most popular' labels should be derived from owner test purchases.
SELECT sku, count(*) AS orders_started,
 count(*) FILTER(WHERE paid_at IS NOT NULL) AS paid_orders,
 count(*) FILTER(WHERE status='refunded') AS refunded_orders,
 coalesce(sum(stars) FILTER(WHERE status='paid'),0) AS stars_retained
FROM jigcoin_internal.stars_orders GROUP BY sku ORDER BY sku;
-- Orders requiring attention; approved orders are not blindly expired or replaced.
SELECT payload AS order_reference,sku,status,created_at,paid_at,unrecovered_coins
FROM jigcoin_internal.stars_orders
WHERE (status='approved' AND created_at<NOW()-interval '15 minutes') OR unrecovered_coins>0
ORDER BY created_at;
