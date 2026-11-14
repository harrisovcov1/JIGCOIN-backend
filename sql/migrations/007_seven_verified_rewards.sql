-- Seven verified rewards and transactional taps. Run BEFORE the backend upload.
-- Existing balances, claims and cooldowns are preserved. No reward reset.
BEGIN;
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
COMMIT;
SELECT 'Seven reward schema installed; existing rewards preserved' AS result;
