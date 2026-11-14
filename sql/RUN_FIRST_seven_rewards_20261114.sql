-- JigCoin private-test expansion. Run this entire file once as postgres.
-- All changes are one transaction; any failure rolls everything back.
BEGIN;
-- 007_seven_verified_rewards.sql
-- Seven verified rewards and transactional taps. Run BEFORE the backend upload.
-- Existing balances, claims and cooldowns are preserved. No reward reset.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
  IF to_regclass('jigcoin_internal.ad_attempts') IS NULL THEN RAISE EXCEPTION 'Install the verified reward base first'; END IF;
  IF (SELECT count(*) FROM public.missions WHERE kind='sponsor' AND is_active AND code IN
    ('sp_visit_partner','sp_watch_content','sp_watch_earn','sp_claim_reward','sp_bonus_mission','sp_emergency_energy','sp_double_points'))<>7
    THEN RAISE EXCEPTION 'Expected all seven existing active sponsor placements'; END IF;
END $$;
-- Known base constraints only. Never remove foreign keys, ownership or uniqueness.
ALTER TABLE jigcoin_internal.ad_attempts ADD COLUMN IF NOT EXISTS reward_kind text NOT NULL DEFAULT 'coins';
ALTER TABLE jigcoin_internal.ad_attempts ADD COLUMN IF NOT EXISTS fulfillment jsonb;
ALTER TABLE jigcoin_internal.ad_attempts DROP CONSTRAINT IF EXISTS ad_attempts_reward_amount_check;
ALTER TABLE jigcoin_internal.ad_attempts DROP CONSTRAINT IF EXISTS ad_attempts_check;
ALTER TABLE jigcoin_internal.ad_attempts DROP CONSTRAINT IF EXISTS ad_attempts_reward_shape;
ALTER TABLE jigcoin_internal.ad_attempts ADD CONSTRAINT ad_attempts_reward_shape CHECK (
 (reward_kind='coins' AND reward_amount=200 AND code IN ('sp_visit_partner','sp_watch_content','sp_watch_earn','sp_claim_reward','sp_bonus_mission')
   AND fulfillment IS NULL AND ((claimed_at IS NULL)=(ledger_id IS NULL)))
 OR
 (reward_kind IN ('energy_refill','double_10m') AND reward_amount=0 AND ledger_id IS NULL
   AND ((reward_kind='energy_refill' AND code='sp_emergency_energy') OR (reward_kind='double_10m' AND code='sp_double_points'))
   AND ((claimed_at IS NULL AND fulfillment IS NULL) OR (claimed_at IS NOT NULL AND fulfillment IS NOT NULL)))
);
CREATE TABLE IF NOT EXISTS jigcoin_internal.tap_claims (
 user_id bigint NOT NULL REFERENCES public.users(id), packet_id text NOT NULL,
 requested_count integer NOT NULL CHECK(requested_count BETWEEN 1 AND 100),
 applied integer NOT NULL CHECK(applied>=0 AND applied<=requested_count),
 gained integer NOT NULL CHECK(gained>=0), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,packet_id)
);
ALTER TABLE jigcoin_internal.tap_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.tap_claims FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.enforce_daily_sponsor_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE mission_code text;
BEGIN
  SELECT code INTO mission_code FROM public.missions WHERE id=NEW.mission_id;
  IF mission_code IN ('sp_visit_partner','sp_watch_content','sp_watch_earn','sp_claim_reward','sp_bonus_mission','sp_emergency_energy','sp_double_points') THEN
    IF NOT EXISTS (
      SELECT 1 FROM jigcoin_internal.ad_attempts a
      JOIN jigcoin_internal.reward_placements p ON p.user_id=a.user_id AND p.code=a.code AND p.cycle_id=a.cycle_id
      WHERE a.user_id=NEW.user_id AND a.code=mission_code AND (a.ledger_id IS NOT NULL OR a.fulfillment IS NOT NULL)
        AND a.claimed_at=NEW.claimed_at AND p.claimed_at=NEW.claimed_at
    ) THEN RAISE EXCEPTION 'Verified ad claim required'; END IF;
    RETURN NEW;
  END IF;
  IF (SELECT sponsor_claims_today FROM public.missions WHERE id=NEW.mission_id) >=
     (SELECT max_claims_per_day FROM public.missions WHERE id=NEW.mission_id) THEN
    RAISE EXCEPTION 'Daily sponsor cap reached';
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
 IF has_table_privilege('anon','jigcoin_internal.tap_claims','SELECT,INSERT,UPDATE,DELETE') OR
    has_table_privilege('authenticated','jigcoin_internal.tap_claims','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Private tap permissions verification failed'; END IF;
END $$;
SELECT 'Seven reward schema installed; existing rewards preserved' AS result;

-- 008_starter_bonus_ledger.sql
-- Correct NEW starter awards only. No historical balance or ledger backfill.
-- Preserve the established 5,000-coin bonus for the first 1,000 awards.
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.award_early_access_starter_bonus(bigint)')
   AND md5(replace(prosrc,chr(13),'')) IN ('c57e444b526a41f235af8bc374e3a9b3','42879110c28ee2fee5ac8e61aadf6f25')) THEN
   RAISE EXCEPTION 'Starter function differs from reviewed version; no changes applied'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='users_award_early_access' AND tgenabled='O') THEN
   RAISE EXCEPTION 'Expected starter trigger is not enabled'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.award_early_access_starter_bonus(p_user_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $starter$
DECLARE credited_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('early_access_starter_bonus_lock'));
  IF EXISTS(SELECT 1 FROM public.event_log WHERE user_id=p_user_id AND event='early_access_starter_bonus') THEN RETURN; END IF;
  SELECT count(*) INTO credited_count FROM public.event_log WHERE event='early_access_starter_bonus';
  IF credited_count>=1000 THEN RETURN; END IF;
  PERFORM 1 FROM public.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Starter account not found'; END IF;
  INSERT INTO public.user_balance_ledger(user_id,delta,reason,ref_type,ref_id,event_type)
    VALUES(p_user_id,5000,'early_access_starter_bonus','early_access',credited_count+1,'bonus');
  UPDATE public.users SET balance=balance+5000 WHERE id=p_user_id;
  INSERT INTO public.event_log(user_id,event,meta,created_at) VALUES
    (p_user_id,'early_access_starter_bonus',jsonb_build_object('amount',5000,'reason','db_trigger','rank',credited_count+1),now());
END;
$starter$;
REVOKE ALL ON FUNCTION public.award_early_access_starter_bonus(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.award_early_access_starter_bonus(bigint) TO service_role;
SELECT 'Starter bonus remains 5000 once, with a matching ledger entry for new awards' AS result;

-- 009_client_access_repair.sql
-- Server-owned API permissions from the live 2026-11-14 03:08 UTC audit.
-- The frontend uses the Render API, not direct Supabase client queries.
-- Keeps postgres ownership and existing service_role effective rights.
-- Does not change rows, passwords, RLS policies, or managed auth/storage schemas.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
REVOKE ALL ON TABLE public.ad_performance FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.ad_performance TO service_role;
REVOKE ALL ON TABLE public.ad_sessions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.ad_sessions TO service_role;
REVOKE ALL ON TABLE public.app_settings FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.app_settings TO service_role;
REVOKE ALL ON TABLE public.coin_packs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.coin_packs TO service_role;
REVOKE ALL ON TABLE public.coinbase_webhook_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.coinbase_webhook_events TO service_role;
REVOKE ALL ON TABLE public.economy_settings FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.economy_settings TO service_role;
REVOKE ALL ON TABLE public.event_log FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.event_log TO service_role;
REVOKE ALL ON TABLE public.events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.events TO service_role;
REVOKE ALL ON TABLE public.fraud_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.fraud_events TO service_role;
REVOKE ALL ON TABLE public.global_idempotency_keys FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.global_idempotency_keys TO service_role;
REVOKE ALL ON TABLE public.idempotency_canonical_keys FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.idempotency_canonical_keys TO service_role;
REVOKE ALL ON TABLE public.idempotency_keys FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.idempotency_keys TO service_role;
REVOKE ALL ON TABLE public.idempotency_recent_keys FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.idempotency_recent_keys TO service_role;
REVOKE ALL ON TABLE public.ip_controls FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.ip_controls TO service_role;
REVOKE ALL ON TABLE public.jobs FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.jobs TO service_role;
REVOKE ALL ON TABLE public.live_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.live_events TO service_role;
REVOKE ALL ON TABLE public.mission_ad_routes FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.mission_ad_routes TO service_role;
REVOKE ALL ON TABLE public.mission_reward_variants FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.mission_reward_variants TO service_role;
REVOKE ALL ON TABLE public.missions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.missions TO service_role;
REVOKE ALL ON TABLE public.ogads_postbacks FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.ogads_postbacks TO service_role;
REVOKE ALL ON TABLE public.payment_products FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.payment_products TO service_role;
REVOKE ALL ON TABLE public.points_ledger FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.points_ledger TO service_role;
REVOKE ALL ON TABLE public.promo_messages FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.promo_messages TO service_role;
REVOKE ALL ON TABLE public.promo_posts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.promo_posts TO service_role;
REVOKE ALL ON TABLE public.promo_templates FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.promo_templates TO service_role;
REVOKE ALL ON TABLE public.promo_zones FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.promo_zones TO service_role;
REVOKE ALL ON TABLE public.purchase_fulfillments FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.purchase_fulfillments TO service_role;
REVOKE ALL ON TABLE public.purchase_ledger FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.purchase_ledger TO service_role;
REVOKE ALL ON TABLE public.purchase_revenue_daily FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.purchase_revenue_daily TO service_role;
REVOKE ALL ON TABLE public.purchases FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.purchases TO service_role;
REVOKE ALL ON TABLE public.rate_limits FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.rate_limits TO service_role;
REVOKE ALL ON TABLE public.referral_config FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.referral_config TO service_role;
REVOKE ALL ON TABLE public.referral_stats FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.referral_stats TO service_role;
REVOKE ALL ON TABLE public.referral_streaks FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.referral_streaks TO service_role;
REVOKE ALL ON TABLE public.referral_tree FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.referral_tree TO service_role;
REVOKE ALL ON TABLE public.referrals FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.referrals TO service_role;
REVOKE ALL ON TABLE public.seasons FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.seasons TO service_role;
REVOKE ALL ON TABLE public.sponsor_campaigns FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.sponsor_campaigns TO service_role;
REVOKE ALL ON TABLE public.sponsor_ledger FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.sponsor_ledger TO service_role;
REVOKE ALL ON TABLE public.sponsor_mission_final_priority FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.sponsor_mission_final_priority TO service_role;
REVOKE ALL ON TABLE public.sponsor_mission_priority FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.sponsor_mission_priority TO service_role;
REVOKE ALL ON TABLE public.sponsor_mission_priority_final FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.sponsor_mission_priority_final TO service_role;
REVOKE ALL ON TABLE public.sponsor_sessions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.sponsor_sessions TO service_role;
REVOKE ALL ON TABLE public.sponsor_settings FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.sponsor_settings TO service_role;
REVOKE ALL ON TABLE public.streak_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.streak_events TO service_role;
REVOKE ALL ON TABLE public.stripe_events_processed FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.stripe_events_processed TO service_role;
REVOKE ALL ON TABLE public.stripe_webhook_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.stripe_webhook_events TO service_role;
REVOKE ALL ON TABLE public.tap_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.tap_events TO service_role;
REVOKE ALL ON TABLE public.tap_packets FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.tap_packets TO service_role;
REVOKE ALL ON TABLE public.tasks FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.tasks TO service_role;
REVOKE ALL ON TABLE public.team_earnings FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.team_earnings TO service_role;
REVOKE ALL ON TABLE public.telemetry_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.telemetry_events TO service_role;
REVOKE ALL ON TABLE public.tier_bonus_lookup FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.tier_bonus_lookup TO service_role;
REVOKE ALL ON TABLE public.top_sponsor_missions_uk_free_v2 FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.top_sponsor_missions_uk_free_v2 TO service_role;
REVOKE ALL ON TABLE public.user_balance_from_ledger FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_balance_from_ledger TO service_role;
REVOKE ALL ON TABLE public.user_balance_ledger FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_balance_ledger TO service_role;
REVOKE ALL ON TABLE public.user_balance_reconciliation FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_balance_reconciliation TO service_role;
REVOKE ALL ON TABLE public.user_boosts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_boosts TO service_role;
REVOKE ALL ON TABLE public.user_devices FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_devices TO service_role;
REVOKE ALL ON TABLE public.user_entitlements FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_entitlements TO service_role;
REVOKE ALL ON TABLE public.user_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_events TO service_role;
REVOKE ALL ON TABLE public.user_mission_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_mission_events TO service_role;
REVOKE ALL ON TABLE public.user_missions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_missions TO service_role;
REVOKE ALL ON TABLE public.user_powerups FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_powerups TO service_role;
REVOKE ALL ON TABLE public.user_tasks FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_tasks TO service_role;
REVOKE ALL ON TABLE public.user_vip FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_vip TO service_role;
REVOKE ALL ON TABLE public.user_withdraw_exposure FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.user_withdraw_exposure TO service_role;
REVOKE ALL ON TABLE public.users FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.users TO service_role;
REVOKE ALL ON TABLE public.v_revenue_daily FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.v_revenue_daily TO service_role;
REVOKE ALL ON TABLE public.vip_products FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.vip_products TO service_role;
REVOKE ALL ON TABLE public.vip_purchases FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.vip_purchases TO service_role;
REVOKE ALL ON TABLE public.withdraw_requests FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON TABLE public.withdraw_requests TO service_role;
REVOKE ALL ON FUNCTION public._touch_sponsor_sessions_updated_at() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public._touch_sponsor_sessions_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.activate_boost(p_user_id uuid, p_boost_type text, p_duration_seconds integer, p_source text, p_metadata jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.activate_boost(p_user_id uuid, p_boost_type text, p_duration_seconds integer, p_source text, p_metadata jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.ad_perf_recalc_epc() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ad_perf_recalc_epc() TO service_role;
REVOKE ALL ON FUNCTION public.apply_fatigue(p_user_id bigint, p_mission_id integer, p_base_score numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_fatigue(p_user_id bigint, p_mission_id integer, p_base_score numeric) TO service_role;
REVOKE ALL ON FUNCTION public.apply_referral_credit(p_inviter bigint, p_invited bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_referral_credit(p_inviter bigint, p_invited bigint) TO service_role;
REVOKE ALL ON FUNCTION public.approve_pending_referral_for_invited(_invited_tg bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.approve_pending_referral_for_invited(_invited_tg bigint) TO service_role;
REVOKE ALL ON FUNCTION public.auto_approve_and_credit_on_user_insert() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.auto_approve_and_credit_on_user_insert() TO service_role;
REVOKE ALL ON FUNCTION public.auto_rotate_sponsors() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.auto_rotate_sponsors() TO service_role;
REVOKE ALL ON FUNCTION public.award_early_access_starter_bonus(p_user_id bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.award_early_access_starter_bonus(p_user_id bigint) TO service_role;
REVOKE ALL ON FUNCTION public.can_start_mission(p_user_id integer, p_mission_id integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.can_start_mission(p_user_id integer, p_mission_id integer) TO service_role;
REVOKE ALL ON FUNCTION public.claim_sponsor_session(p_user_id uuid, p_quest_key text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sponsor_session(p_user_id uuid, p_quest_key text) TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_old_idempotency_keys() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_idempotency_keys() TO service_role;
REVOKE ALL ON FUNCTION public.credit_referral_once(p_referral_id bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.credit_referral_once(p_referral_id bigint) TO service_role;
REVOKE ALL ON FUNCTION public.credit_referral_rewards() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.credit_referral_rewards() TO service_role;
REVOKE ALL ON FUNCTION public.credit_user_coins_from_fulfillment(p_fulfillment_id uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.credit_user_coins_from_fulfillment(p_fulfillment_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.enforce_daily_sponsor_cap() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_daily_sponsor_cap() TO service_role;
REVOKE ALL ON FUNCTION public.fatigue_penalty(p_user_id bigint, p_mission_id integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fatigue_penalty(p_user_id bigint, p_mission_id integer) TO service_role;
REVOKE ALL ON FUNCTION public.geo_match(mission_geo text, user_geo text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.geo_match(mission_geo text, user_geo text) TO service_role;
REVOKE ALL ON FUNCTION public.geo_scope_to_use(p_user_geo text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.geo_scope_to_use(p_user_geo text) TO service_role;
REVOKE ALL ON FUNCTION public.get_points_multiplier(p_user_id uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_points_multiplier(p_user_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_prime_time_boost() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_prime_time_boost() TO service_role;
REVOKE ALL ON FUNCTION public.get_tier_bonus(tier text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_tier_bonus(tier text) TO service_role;
REVOKE ALL ON FUNCTION public.is_vip_active(p_user_id uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.is_vip_active(p_user_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.pick_ad_provider(p_mission_id bigint, p_country text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pick_ad_provider(p_mission_id bigint, p_country text) TO service_role;
REVOKE ALL ON FUNCTION public.pick_reward_variant(p_mission_id integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.pick_reward_variant(p_mission_id integer) TO service_role;
REVOKE ALL ON FUNCTION public.process_coinbase_webhook(payload jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_coinbase_webhook(payload jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.process_pending_referrals_for_new_user() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_pending_referrals_for_new_user() TO service_role;
REVOKE ALL ON FUNCTION public.process_referral() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_referral() TO service_role;
REVOKE ALL ON FUNCTION public.process_referral_on_insert() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_referral_on_insert() TO service_role;
REVOKE ALL ON FUNCTION public.record_mission_completion(p_user_id bigint, p_mission_id integer, p_variant_id integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_mission_completion(p_user_id bigint, p_mission_id integer, p_variant_id integer) TO service_role;
REVOKE ALL ON FUNCTION public.record_mission_impression(p_user_id bigint, p_mission_id integer, p_variant_id integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_mission_impression(p_user_id bigint, p_mission_id integer, p_variant_id integer) TO service_role;
REVOKE ALL ON FUNCTION public.record_sponsor_claim(p_user_id bigint, p_mission_id bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_sponsor_claim(p_user_id bigint, p_mission_id bigint) TO service_role;
REVOKE ALL ON FUNCTION public.record_sponsor_claim(p_user_id integer, p_mission_id integer, p_session_id uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_sponsor_claim(p_user_id integer, p_mission_id integer, p_session_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.record_tap(p_user_id integer, p_fingerprint text, p_taps integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_tap(p_user_id integer, p_fingerprint text, p_taps integer) TO service_role;
REVOKE ALL ON FUNCTION public.rotate_sponsor_missions() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_sponsor_missions() TO service_role;
REVOKE ALL ON FUNCTION public.serve_sponsor_action(p_user_id integer, p_mission_id integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.serve_sponsor_action(p_user_id integer, p_mission_id integer) TO service_role;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.sponsors_available_for_user(p_user_id bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sponsors_available_for_user(p_user_id bigint) TO service_role;
REVOKE ALL ON FUNCTION public.start_sponsor_session(p_user_id uuid, p_quest_key text, p_session_token text, p_partner text, p_click_id text, p_claim_delay_seconds integer, p_metadata jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_sponsor_session(p_user_id uuid, p_quest_key text, p_session_token text, p_partner text, p_click_id text, p_claim_delay_seconds integer, p_metadata jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.sync_energy_max() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_energy_max() TO service_role;
REVOKE ALL ON FUNCTION public.tier_bonus(user_tier text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tier_bonus(user_tier text) TO service_role;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.touch_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.trg_users_award_early_access() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.trg_users_award_early_access() TO service_role;
REVOKE ALL ON FUNCTION public.try_credit_referral_on_referral_insert() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.try_credit_referral_on_referral_insert() TO service_role;
REVOKE ALL ON FUNCTION public.try_credit_referral_on_user_insert() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.try_credit_referral_on_user_insert() TO service_role;
REVOKE ALL ON FUNCTION public.user_daily_sponsor_impressions(p_user_id bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.user_daily_sponsor_impressions(p_user_id bigint) TO service_role;
REVOKE ALL ON SEQUENCE public.ad_performance_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.ad_performance_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.ad_sessions_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.ad_sessions_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.coin_packs_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.coin_packs_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.event_log_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.event_log_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.events_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.events_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.fraud_events_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.fraud_events_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.global_idempotency_keys_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.global_idempotency_keys_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.idempotency_keys_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.idempotency_keys_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.jobs_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.jobs_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.live_events_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.live_events_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.mission_reward_variants_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.mission_reward_variants_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.missions_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.missions_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.ogads_postbacks_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.ogads_postbacks_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.payment_products_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.payment_products_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.points_ledger_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.points_ledger_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.purchase_fulfillments_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.purchase_fulfillments_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.purchases_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.purchases_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.rate_limits_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.rate_limits_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.referral_config_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.referral_config_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.referral_tree_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.referral_tree_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.referrals_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.referrals_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.seasons_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.seasons_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.sponsor_campaigns_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.sponsor_campaigns_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.sponsor_ledger_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.sponsor_ledger_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.streak_events_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.streak_events_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.tap_events_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.tap_events_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.tasks_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.tasks_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.team_earnings_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.team_earnings_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.user_balance_ledger_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.user_balance_ledger_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.user_devices_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.user_devices_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.user_events_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.user_events_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.user_mission_events_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.user_mission_events_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.user_missions_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.user_missions_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.user_tasks_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.user_tasks_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.users_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.users_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.vip_products_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.vip_products_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.vip_purchases_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.vip_purchases_id_seq TO service_role;
REVOKE ALL ON SEQUENCE public.withdraw_requests_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT,UPDATE ON SEQUENCE public.withdraw_requests_id_seq TO service_role;
-- Stop postgres-created public tables/sequences/functions reopening browser access.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon,authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
   AND p.proowner='postgres'::regrole AND p.prosecdef AND
   (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN
   RAISE EXCEPTION 'Privileged application functions are still executable by client roles'; END IF;
 IF has_table_privilege('anon','public.jobs','SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('authenticated','public.jobs','SELECT,INSERT,UPDATE,DELETE') THEN
   RAISE EXCEPTION 'Client job access remains'; END IF;
END $$;
SELECT 'Reviewed application objects restricted; server access retained' AS result;

COMMIT;
SELECT 'PASS — seven rewards, starter ledger and reviewed permissions installed' AS result;
