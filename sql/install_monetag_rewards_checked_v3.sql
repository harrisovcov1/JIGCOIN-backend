-- JigCoin Monetag checked installation V3 — 14 November 2026.
-- Explicit RLS is enabled on all three private reward tables.
-- Function verification accepts LF and CRLF and reports any failed check by name.
-- Apply to the checked JigCoin project as postgres. Run the complete file.
-- Adds reward tables and replaces the sponsor-cap validation function.
-- No existing balances, purchases or customer rows are modified.
-- This does not deploy the backend or turn ads on.
-- Apply once to a private/staging database first. No legacy balances are changed.
BEGIN;
CREATE SCHEMA IF NOT EXISTS jigcoin_internal;
REVOKE ALL ON SCHEMA jigcoin_internal FROM PUBLIC;

CREATE TABLE IF NOT EXISTS jigcoin_internal.reward_placements (
  user_id bigint NOT NULL REFERENCES public.users(id),
  code text NOT NULL,
  cycle_id uuid NOT NULL,
  claimed_at timestamptz,
  next_available_at timestamptz,
  PRIMARY KEY (user_id, code)
);

CREATE TABLE IF NOT EXISTS jigcoin_internal.ad_attempts (
  id bigserial PRIMARY KEY,
  ymid uuid NOT NULL UNIQUE,
  user_id bigint NOT NULL,
  code text NOT NULL,
  cycle_id uuid NOT NULL,
  zone_id text NOT NULL,
  telegram_id text NOT NULL,
  reward_amount integer NOT NULL CHECK (reward_amount = 200),
  cooldown_seconds integer NOT NULL CHECK (cooldown_seconds = 86400),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  eligible_at timestamptz,
  claimed_at timestamptz,
  ledger_id bigint UNIQUE REFERENCES public.user_balance_ledger(id),
  FOREIGN KEY (user_id, code) REFERENCES jigcoin_internal.reward_placements(user_id, code),
  CHECK ((claimed_at IS NULL) = (ledger_id IS NULL))
);
CREATE INDEX IF NOT EXISTS monetag_attempt_placement_idx
  ON jigcoin_internal.ad_attempts (user_id, code, cycle_id, created_at DESC);

-- No secrets, raw query strings, addresses or user agents are retained here.
-- Values are estimated USD event earnings, never coin balances or settled cash.
CREATE TABLE IF NOT EXISTS jigcoin_internal.monetag_events (
  attempt_id bigint NOT NULL REFERENCES jigcoin_internal.ad_attempts(id),
  event_type text NOT NULL CHECK (event_type IN ('impression', 'click')),
  reward_event_type text NOT NULL CHECK (reward_event_type IN ('valued', 'non_valued')),
  sub_zone_id text NOT NULL,
  estimated_price numeric(20,7) NOT NULL CHECK (estimated_price >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, event_type, reward_event_type)
);
-- Server-owned tables: no browser policies. The owner-backed API retains access;
-- ordinary client roles are denied even if table grants are reintroduced later.
ALTER TABLE jigcoin_internal.reward_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.ad_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.monetag_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA jigcoin_internal FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA jigcoin_internal FROM PUBLIC;
DO $$
DECLARE client_role text;
BEGIN
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA jigcoin_internal FROM %I', client_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA jigcoin_internal FROM %I', client_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA jigcoin_internal FROM %I', client_role);
    END IF;
  END LOOP;
END $$;

-- The recovered trigger compares a mission-wide counter to a daily cap. These
-- five quests now have locked PER-USER limits above. Allow their mirrored status
-- update only when it exactly matches an atomically credited Monetag attempt.
-- Keep the original rule for all other missions. No trigger is auto-created on
-- installations that did not have it; the application always enforces the gate.
CREATE OR REPLACE FUNCTION public.enforce_daily_sponsor_cap() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE mission_code text;
BEGIN
  SELECT code INTO mission_code FROM public.missions WHERE id=NEW.mission_id;
  IF mission_code IN ('sp_visit_partner','sp_watch_content','sp_watch_earn','sp_claim_reward','sp_bonus_mission') THEN
    IF NOT EXISTS (
      SELECT 1 FROM jigcoin_internal.ad_attempts a
      JOIN jigcoin_internal.reward_placements p ON p.user_id=a.user_id AND p.code=a.code AND p.cycle_id=a.cycle_id
      WHERE a.user_id=NEW.user_id AND a.code=mission_code AND a.ledger_id IS NOT NULL
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

DO $verify$
DECLARE failed_checks text;
BEGIN
  SELECT string_agg(check_name, ', ' ORDER BY check_name)
    INTO failed_checks
    FROM (
SELECT '01 reward_placements table' AS check_name,
  CASE WHEN to_regclass('jigcoin_internal.reward_placements') IS NOT NULL THEN 'PASS' ELSE 'FAILED' END AS result
UNION ALL
SELECT '02 ad_attempts table',
  CASE WHEN to_regclass('jigcoin_internal.ad_attempts') IS NOT NULL THEN 'PASS' ELSE 'FAILED' END
UNION ALL
SELECT '03 monetag_events table',
  CASE WHEN to_regclass('jigcoin_internal.monetag_events') IS NOT NULL THEN 'PASS' ELSE 'FAILED' END
UNION ALL
SELECT '04 verified-claim trigger function',
  CASE WHEN (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid=to_regprocedure('public.enforce_daily_sponsor_cap()')) = 'ba0fab51f598ab946067194821cb3e42'
    THEN 'PASS' ELSE 'FAILED' END
UNION ALL
SELECT '05 anon access restricted',
  CASE WHEN NOT has_schema_privilege('anon','jigcoin_internal','USAGE') AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='jigcoin_internal' AND c.relkind='r'
      AND has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    THEN 'PASS' ELSE 'FAILED' END
UNION ALL
SELECT '06 authenticated access restricted',
  CASE WHEN NOT has_schema_privilege('authenticated','jigcoin_internal','USAGE') AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='jigcoin_internal' AND c.relkind='r'
      AND has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    THEN 'PASS' ELSE 'FAILED' END
UNION ALL
SELECT '07 row-level security enabled',
  CASE WHEN (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='jigcoin_internal' AND c.relkind='r' AND c.relrowsecurity
      AND c.relname IN ('reward_placements','ad_attempts','monetag_events'))=3
    THEN 'PASS' ELSE 'FAILED' END
  ) checks WHERE result <> 'PASS';
  IF failed_checks IS NOT NULL THEN
    RAISE EXCEPTION 'Monetag verification failed: %; changes not committed', failed_checks;
  END IF;
END
$verify$;
COMMIT;

SELECT '01 reward_placements table' AS check_name,
  CASE WHEN to_regclass('jigcoin_internal.reward_placements') IS NOT NULL THEN 'PASS' ELSE 'FAILED' END AS result
UNION ALL
SELECT '02 ad_attempts table',
  CASE WHEN to_regclass('jigcoin_internal.ad_attempts') IS NOT NULL THEN 'PASS' ELSE 'FAILED' END
UNION ALL
SELECT '03 monetag_events table',
  CASE WHEN to_regclass('jigcoin_internal.monetag_events') IS NOT NULL THEN 'PASS' ELSE 'FAILED' END
UNION ALL
SELECT '04 verified-claim trigger function',
  CASE WHEN (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid=to_regprocedure('public.enforce_daily_sponsor_cap()')) = 'ba0fab51f598ab946067194821cb3e42'
    THEN 'PASS' ELSE 'FAILED' END
UNION ALL
SELECT '05 anon access restricted',
  CASE WHEN NOT has_schema_privilege('anon','jigcoin_internal','USAGE') AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='jigcoin_internal' AND c.relkind='r'
      AND has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    THEN 'PASS' ELSE 'FAILED' END
UNION ALL
SELECT '06 authenticated access restricted',
  CASE WHEN NOT has_schema_privilege('authenticated','jigcoin_internal','USAGE') AND NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='jigcoin_internal' AND c.relkind='r'
      AND has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
    THEN 'PASS' ELSE 'FAILED' END
UNION ALL
SELECT '07 row-level security enabled',
  CASE WHEN (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='jigcoin_internal' AND c.relkind='r' AND c.relrowsecurity
      AND c.relname IN ('reward_placements','ad_attempts','monetag_events'))=3
    THEN 'PASS' ELSE 'FAILED' END
ORDER BY check_name;
