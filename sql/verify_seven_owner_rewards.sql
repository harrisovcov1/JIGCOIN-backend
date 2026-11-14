-- Read-only: all seven placements for the existing owner's account.
-- No rewards, balances, cooldowns, users or settings are changed.
BEGIN READ ONLY;
SET LOCAL statement_timeout='20s';
WITH target AS (SELECT * FROM public.users WHERE telegram_id=7888995060),
placements(code,expected_reward,sort) AS (VALUES
 ('sp_visit_partner','200 coins',1),('sp_watch_content','200 coins',2),
 ('sp_watch_earn','200 coins',3),('sp_claim_reward','200 coins',4),
 ('sp_bonus_mission','200 coins',5),('sp_emergency_energy','Full energy refill',6),
 ('sp_double_points','Double points for 10 minutes',7))
SELECT q.code,q.expected_reward,u.balance AS saved_balance,u.energy,
 u.double_boost_until,p.claimed_at,p.next_available_at,
 COALESCE(p.next_available_at>now(),false) AS cooldown_active,
 COALESCE((SELECT count(*) FROM jigcoin_internal.monetag_events e WHERE e.attempt_id=a.id AND e.reward_event_type='valued'),0) AS valued_receipts,
 (SELECT delta FROM public.user_balance_ledger WHERE id=a.ledger_id) AS credited_coins,
 a.fulfillment AS boost_applied,
 (SELECT count(*) FROM jigcoin_internal.ad_attempts x WHERE x.user_id=u.id AND x.code=q.code AND x.cycle_id=p.cycle_id AND x.claimed_at IS NOT NULL) AS claims_this_cycle
FROM placements q CROSS JOIN target u
LEFT JOIN jigcoin_internal.reward_placements p ON p.user_id=u.id AND p.code=q.code
LEFT JOIN LATERAL (SELECT * FROM jigcoin_internal.ad_attempts x WHERE x.user_id=u.id AND x.code=q.code AND x.cycle_id=p.cycle_id
 ORDER BY x.claimed_at DESC NULLS LAST,x.created_at DESC LIMIT 1) a ON true
ORDER BY q.sort;
COMMIT;
