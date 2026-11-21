-- JigCoin Shop v24: read-only daily purchase funnel summary (UTC).
-- Counts are distinct player interactions, not payments. No personal data returned.
WITH viewer AS (
 SELECT visit_day AS day,COUNT(DISTINCT user_id) AS shop_viewers
 FROM jigcoin_internal.stars_shop_visitors GROUP BY visit_day
), events AS (
 SELECT created_at::date AS day,
   COUNT(DISTINCT user_id) FILTER (WHERE event_name='pack_selected') AS pack_selectors,
   COUNT(DISTINCT user_id) FILTER (WHERE event_name='checkout_review') AS checkout_reviewers,
   COUNT(DISTINCT user_id) FILTER (WHERE event_name='vip_opened') AS vip_viewers,
   COUNT(DISTINCT user_id) FILTER (WHERE event_name='finish_preview') AS finish_previewers
 FROM jigcoin_internal.shop_funnel_events_v24 GROUP BY created_at::date
), packs AS (
 SELECT created_at::date AS day,
   COUNT(*) FILTER (WHERE status IN ('invoiced','approved','paid','refunded')) AS pack_invoices,
   COUNT(*) FILTER (WHERE status='paid') AS pack_paid,
   COUNT(*) FILTER (WHERE status='refunded') AS pack_refunded,
   COALESCE(SUM(stars) FILTER (WHERE status='paid'),0) AS pack_paid_stars
 FROM jigcoin_internal.stars_orders GROUP BY created_at::date
), vip AS (
 SELECT created_at::date AS day,
   COUNT(*) FILTER (WHERE status='paid') AS vip_paid,
   COUNT(*) FILTER (WHERE status='refunded') AS vip_refunded,
   COALESCE(SUM(stars) FILTER (WHERE status='paid'),0) AS vip_paid_stars
 FROM jigcoin_internal.vip_orders_v11 GROUP BY created_at::date
)
SELECT d.day,COALESCE(viewer.shop_viewers,0) AS shop_viewers,
 COALESCE(events.pack_selectors,0) AS pack_selectors,
 COALESCE(events.checkout_reviewers,0) AS checkout_reviewers,
 COALESCE(events.vip_viewers,0) AS vip_viewers,
 COALESCE(events.finish_previewers,0) AS finish_previewers,
 COALESCE(packs.pack_invoices,0) AS pack_invoices,
 COALESCE(packs.pack_paid,0) AS pack_paid,
 COALESCE(packs.pack_refunded,0) AS pack_refunded,
 COALESCE(vip.vip_paid,0) AS vip_paid,
 COALESCE(vip.vip_refunded,0) AS vip_refunded,
 COALESCE(packs.pack_paid_stars,0)+COALESCE(vip.vip_paid_stars,0) AS paid_stars_before_refunds
FROM (
 SELECT day FROM viewer UNION SELECT day FROM events
 UNION SELECT day FROM packs UNION SELECT day FROM vip
) d
LEFT JOIN viewer USING(day) LEFT JOIN events USING(day)
LEFT JOIN packs USING(day) LEFT JOIN vip USING(day)
ORDER BY day DESC;
-- SKU-level revenue for future controlled pricing decisions:
SELECT sku,COUNT(*) FILTER(WHERE status='paid') AS paid_orders,
 SUM(stars) FILTER(WHERE status='paid') AS stars_from_paid_orders,
 COUNT(*) FILTER(WHERE status='refunded') AS refunds
FROM jigcoin_internal.stars_orders GROUP BY sku ORDER BY paid_orders DESC,sku;
-- Bridge pack is intentionally inactive, never counted as an active product.
SELECT sku,coins,stars,active FROM jigcoin_internal.stars_products ORDER BY sort_order,stars;
