-- JigCoin Invite v28: aggregate, read-only growth scorecard.
-- "Referred buyer" means attributed account; not evidence of causal uplift.
WITH days AS (
 SELECT created_at::date AS day FROM jigcoin_internal.invite_interactions_v28
 UNION SELECT created_at::date FROM public.referrals
 UNION SELECT COALESCE(qualified_at,registered_at)::date FROM jigcoin_internal.referral_credits_v16
 UNION SELECT awarded_at::date FROM jigcoin_internal.referral_credits_v16 WHERE awarded_at IS NOT NULL
), engagement AS (
 SELECT created_at::date AS day,
  COUNT(DISTINCT user_id) FILTER(WHERE event_name='share_open') AS share_openers,
  COUNT(DISTINCT user_id) FILTER(WHERE event_name='copy_link') AS link_copiers,
  COUNT(DISTINCT user_id) FILTER(WHERE event_name='card_open') AS card_viewers,
  COUNT(DISTINCT user_id) FILTER(WHERE event_name='friends_open') AS friends_viewers
 FROM jigcoin_internal.invite_interactions_v28 GROUP BY created_at::date
), joined AS (
 SELECT created_at::date AS day,COUNT(*) AS attributed_joins FROM public.referrals GROUP BY created_at::date
), activated AS (
 SELECT qualified_at::date AS day,COUNT(*) AS verified_activations
 FROM jigcoin_internal.referral_credits_v16
 WHERE qualified_at IS NOT NULL GROUP BY qualified_at::date
), rewarded AS (
 SELECT awarded_at::date AS day,COUNT(*) AS rewards_granted,
 COALESCE(SUM(inviter_reward),0) AS coins_granted
 FROM jigcoin_internal.referral_credits_v16
 WHERE awarded_at IS NOT NULL GROUP BY awarded_at::date
)
SELECT d.day,COALESCE(e.share_openers,0) AS share_openers,
 COALESCE(e.link_copiers,0) AS link_copiers,
 COALESCE(e.card_viewers,0) AS card_viewers,
 COALESCE(e.friends_viewers,0) AS friends_viewers,
 COALESCE(j.attributed_joins,0) AS attributed_joins,
 COALESCE(a.verified_activations,0) AS verified_activations,
 COALESCE(r.rewards_granted,0) AS rewards_granted,
 COALESCE(r.coins_granted,0) AS coins_granted
FROM (SELECT DISTINCT day FROM days WHERE day IS NOT NULL) d
LEFT JOIN engagement e USING(day) LEFT JOIN joined j USING(day)
LEFT JOIN activated a USING(day) LEFT JOIN rewarded r USING(day)
ORDER BY d.day DESC LIMIT 90;

-- Referred buyers are a separate descriptive aggregate (not attributable
-- acquisition revenue without controls, time windows and deduplication).
SELECT 'coins' AS product,COUNT(*) FILTER(WHERE o.status='paid') AS paid_orders
FROM jigcoin_internal.stars_orders o
WHERE EXISTS(SELECT 1 FROM public.referrals r JOIN public.users u ON u.telegram_id=r.invited_id
             WHERE u.id=o.user_id)
UNION ALL
SELECT 'vip',COUNT(*) FILTER(WHERE o.status='paid')
FROM jigcoin_internal.vip_orders_v11 o
WHERE EXISTS(SELECT 1 FROM public.referrals r JOIN public.users u ON u.telegram_id=r.invited_id
             WHERE u.id=o.user_id);
