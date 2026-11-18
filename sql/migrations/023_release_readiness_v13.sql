-- JIGCOIN v13: private tracking + known legacy ad-timer compatibility.
-- Run BEFORE the v13 backend.
-- Does not enable sales or change coins, prices, referrals, streaks or VIP.
BEGIN;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM jigcoin_internal.vip_v11_migrations WHERE version='vault_vip_v11')
 OR NOT EXISTS(SELECT 1 FROM jigcoin_internal.leaderboard_config_v12)
 OR NOT EXISTS(SELECT 1 FROM jigcoin_internal.referral_migrations WHERE version='referrals_welcome_v10')
 THEN RAISE EXCEPTION 'Install the accepted v10/v11/v12 versions first'; END IF;
END $$;
-- Earlier 006/007 files retained a CHECK allowing only 86400 seconds.
-- Current v12 code already uses 300/1800; repair ONLY that exact known check.
-- Keep old 86400-second receipts valid. No timestamps or rewards are rewritten.
DO $$ DECLARE definition text; BEGIN
 SELECT regexp_replace(pg_get_constraintdef(oid),'\s','','g') INTO definition FROM pg_constraint
 WHERE conrelid='jigcoin_internal.ad_attempts'::regclass AND conname='ad_attempts_cooldown_seconds_check';
 IF definition='CHECK((cooldown_seconds=86400))' THEN
  ALTER TABLE jigcoin_internal.ad_attempts DROP CONSTRAINT ad_attempts_cooldown_seconds_check;
  ALTER TABLE jigcoin_internal.ad_attempts ADD CONSTRAINT ad_attempts_cooldown_seconds_check CHECK(
   cooldown_seconds=86400 OR (reward_kind IN('coins','energy_refill') AND cooldown_seconds=300)
   OR (reward_kind='double_10m' AND cooldown_seconds=1800));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS jigcoin_internal.release_config_v13(
 version text PRIMARY KEY CHECK(version='release_v13'),installed_at timestamptz NOT NULL DEFAULT clock_timestamp());
INSERT INTO jigcoin_internal.release_config_v13(version) VALUES('release_v13') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS jigcoin_internal.acquisition_v13(
 user_id bigint PRIMARY KEY REFERENCES public.users(id),source text NOT NULL CHECK(source~'^[a-z0-9][a-z0-9_-]{0,39}$'),
 is_new boolean NOT NULL,excluded boolean NOT NULL DEFAULT FALSE,registered_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS jigcoin_internal.journey_v13(
 user_id bigint PRIMARY KEY REFERENCES public.users(id),first_open_at timestamptz,last_seen_at timestamptz,
 session_started_at timestamptz,sessions integer NOT NULL DEFAULT 0 CHECK(sessions>=0),
 accepted_taps bigint NOT NULL DEFAULT 0 CHECK(accepted_taps>=0),
 first_session_taps bigint NOT NULL DEFAULT 0 CHECK(first_session_taps>=0),first_session_daily boolean NOT NULL DEFAULT FALSE,
 daily_claimed_at timestamptz,onboarding_completed_at timestamptz,activated_at timestamptz,
 d1_return_at timestamptz,d7_return_at timestamptz,d30_return_at timestamptz);
CREATE INDEX IF NOT EXISTS journey_v13_first_open ON jigcoin_internal.journey_v13(first_open_at);
-- Cumulative, evidenced FIRST-30-DAY totals per first-open UTC day + source.
-- Unknown amounts stay NULL. Provider-reported income is not an SDK estimate.
-- purchase_gbp is BEFORE refunds/direct_cost_gbp; avoid deducting fees twice.
-- acquisition_gbp includes advertising, creator fees and content production.
-- cash_received_gbp is a separate settlement measure, never added to revenue.
CREATE TABLE IF NOT EXISTS jigcoin_internal.cohort_finance_v13(
 cohort_day date NOT NULL,source text NOT NULL CHECK(source~'^[a-z0-9][a-z0-9_-]{0,39}$'),
 purchase_gbp numeric(18,4) CHECK(purchase_gbp>=0),refund_gbp numeric(18,4) CHECK(refund_gbp>=0),
 ads_gbp numeric(18,4) CHECK(ads_gbp>=0),direct_cost_gbp numeric(18,4) CHECK(direct_cost_gbp>=0),
 acquisition_gbp numeric(18,4) CHECK(acquisition_gbp>=0),cash_received_gbp numeric(18,4) CHECK(cash_received_gbp>=0),
 coverage_complete boolean NOT NULL DEFAULT FALSE,evidence_ref text,allocation_method text,
 reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(cohort_day,source),
 CHECK(NOT coverage_complete OR (purchase_gbp IS NOT NULL AND refund_gbp IS NOT NULL AND ads_gbp IS NOT NULL
 AND direct_cost_gbp IS NOT NULL AND acquisition_gbp IS NOT NULL AND COALESCE(length(trim(evidence_ref)),0)>=10 AND COALESCE(length(trim(allocation_method)),0)>=10)));
CREATE OR REPLACE VIEW jigcoin_internal.purchase_receipts_v13 AS
 SELECT user_id,'coins'::text product,payload,stars,status,created_at,paid_at,refunded_at,charge_id
 FROM jigcoin_internal.stars_orders
 UNION ALL SELECT user_id,'vip',payload,stars,status,created_at,paid_at,refunded_at,charge_id
 FROM jigcoin_internal.vip_orders_v11
 UNION ALL SELECT user_id,'restore',payload,stars,status,created_at,restored_at,refunded_at,charge_id
 FROM jigcoin_internal.streak_restore_orders;
CREATE OR REPLACE VIEW jigcoin_internal.release_scorecard_v13 AS
 WITH players AS (
  SELECT a.source,(j.first_open_at AT TIME ZONE 'UTC')::date cohort_day,j.*
  FROM jigcoin_internal.acquisition_v13 a JOIN jigcoin_internal.journey_v13 j USING(user_id)
  JOIN public.users u ON u.id=a.user_id
  WHERE a.is_new AND NOT a.excluded AND NOT u.is_system_user AND j.first_open_at IS NOT NULL
 ), cohorts AS (
  SELECT source,cohort_day,count(*) players,count(onboarding_completed_at) intro_completed,count(activated_at) first_session_activated,
   count(*) FILTER(WHERE clock_timestamp()>=first_open_at+interval '48 hours') d1_eligible,
   count(d1_return_at) FILTER(WHERE clock_timestamp()>=first_open_at+interval '48 hours') d1_returned,
   count(*) FILTER(WHERE clock_timestamp()>=first_open_at+interval '192 hours') d7_eligible,
   count(d7_return_at) FILTER(WHERE clock_timestamp()>=first_open_at+interval '192 hours') d7_returned,
   count(*) FILTER(WHERE clock_timestamp()>=first_open_at+interval '744 hours') d30_retention_eligible,
   count(d30_return_at) FILTER(WHERE clock_timestamp()>=first_open_at+interval '744 hours') d30_returned,
   bool_and(clock_timestamp()>=first_open_at+interval '720 hours') contribution_window_elapsed
  FROM players GROUP BY source,cohort_day
 ), receipts AS (
  SELECT p.source,p.cohort_day,
   count(*) FILTER(WHERE r.charge_id IS NOT NULL) confirmed_purchases,
   count(DISTINCT r.user_id) FILTER(WHERE r.charge_id IS NOT NULL) paying_players,
   COALESCE(sum(r.stars) FILTER(WHERE r.charge_id IS NOT NULL),0) confirmed_stars,
   COALESCE(sum(r.stars) FILTER(WHERE r.refunded_at IS NOT NULL),0) refunded_stars
  FROM players p JOIN jigcoin_internal.purchase_receipts_v13 r ON r.user_id=p.user_id
  AND COALESCE(r.paid_at,r.refunded_at)>=p.first_open_at
  AND COALESCE(r.paid_at,r.refunded_at)<p.first_open_at+interval '720 hours'
  GROUP BY p.source,p.cohort_day
 )
 SELECT c.*,COALESCE(r.confirmed_purchases,0) confirmed_purchases,COALESCE(r.paying_players,0) paying_players,
 COALESCE(r.confirmed_stars,0) confirmed_stars,COALESCE(r.refunded_stars,0) refunded_stars,
 f.purchase_gbp,f.refund_gbp,f.ads_gbp,f.direct_cost_gbp,f.acquisition_gbp,f.cash_received_gbp,
 COALESCE(f.coverage_complete,FALSE) evidence_complete,f.evidence_ref,f.allocation_method,f.reconciled_at,
 CASE WHEN c.contribution_window_elapsed AND f.coverage_complete
 THEN (f.purchase_gbp-f.refund_gbp+f.ads_gbp-f.direct_cost_gbp)/c.players END observed_30d_contribution_per_player_gbp,
 CASE WHEN c.contribution_window_elapsed AND f.coverage_complete THEN f.acquisition_gbp/c.players END acquisition_cost_per_player_gbp
 FROM cohorts c LEFT JOIN receipts r USING(source,cohort_day) LEFT JOIN jigcoin_internal.cohort_finance_v13 f USING(source,cohort_day);
CREATE OR REPLACE VIEW jigcoin_internal.ad_estimates_v13 AS
 SELECT (e.received_at AT TIME ZONE 'UTC')::date event_day,COALESCE(a.source,'existing') source,
 e.event_type,e.reward_event_type,count(*) events,sum(e.estimated_price) estimated_usd_NOT_cash
 FROM jigcoin_internal.monetag_events e JOIN jigcoin_internal.ad_attempts t ON t.id=e.attempt_id
 LEFT JOIN jigcoin_internal.acquisition_v13 a ON a.user_id=t.user_id
 WHERE NOT COALESCE(a.excluded,TRUE)
 GROUP BY 1,2,3,4;
ALTER TABLE jigcoin_internal.release_config_v13 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.acquisition_v13 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.journey_v13 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.cohort_finance_v13 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.release_config_v13,jigcoin_internal.acquisition_v13,jigcoin_internal.journey_v13,
 jigcoin_internal.cohort_finance_v13,jigcoin_internal.purchase_receipts_v13,jigcoin_internal.release_scorecard_v13,
 jigcoin_internal.ad_estimates_v13 FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON jigcoin_internal.release_config_v13,jigcoin_internal.acquisition_v13,
 jigcoin_internal.journey_v13,jigcoin_internal.cohort_finance_v13 TO service_role;
GRANT SELECT ON jigcoin_internal.purchase_receipts_v13,jigcoin_internal.release_scorecard_v13,jigcoin_internal.ad_estimates_v13 TO service_role;
COMMIT;
SELECT 'v13 tracking ready; sales settings unchanged' result;
