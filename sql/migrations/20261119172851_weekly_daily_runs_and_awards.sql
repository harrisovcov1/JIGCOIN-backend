BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(14142026);

-- The current week keeps its original three-run allowance. New daily slots are
-- independent of legacy weekly slots and are charged to their UTC start date.
ALTER TABLE jigcoin_internal.weekly_runs_v14
  ADD COLUMN IF NOT EXISTS allowance_day date,
  ADD COLUMN IF NOT EXISTS policy_version text NOT NULL DEFAULT 'weekly-v14'
    CHECK (policy_version IN ('weekly-v14','daily-v16')),
  ADD COLUMN IF NOT EXISTS puzzle_version text NOT NULL DEFAULT 'weekly-v14'
    CHECK (puzzle_version IN ('weekly-v14','daily-v16')),
  ADD COLUMN IF NOT EXISTS vip_active_at_start boolean,
  ADD COLUMN IF NOT EXISTS rank_finish_key text CHECK (rank_finish_key ~ '^rank-[0-7]$');
UPDATE jigcoin_internal.weekly_runs_v14
  SET allowance_day=(starts_at AT TIME ZONE 'UTC')::date WHERE allowance_day IS NULL;
ALTER TABLE jigcoin_internal.weekly_runs_v14 ALTER COLUMN allowance_day SET NOT NULL;

-- Migration-first deployment must keep the old v14 INSERT working while old
-- instances drain. Derive from the run start, not the migration/database day.
-- Policy is timestamp-derived for both versions, so a rollback cannot create
-- a second allowance bucket after the daily policy activates. Puzzle provenance
-- is separate: omitted puzzle_version means the old server's legacy algorithm.
CREATE OR REPLACE FUNCTION jigcoin_internal.weekly_run_start_fields_v16()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  NEW.allowance_day := (NEW.starts_at AT TIME ZONE 'UTC')::date;
  NEW.policy_version := CASE WHEN NEW.starts_at>=timestamptz '2026-11-23 00:00:00+00'
    THEN 'daily-v16' ELSE 'weekly-v14' END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION jigcoin_internal.weekly_run_start_fields_v16() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS weekly_run_start_fields_v16 ON jigcoin_internal.weekly_runs_v14;
CREATE TRIGGER weekly_run_start_fields_v16 BEFORE INSERT ON jigcoin_internal.weekly_runs_v14
  FOR EACH ROW EXECUTE FUNCTION jigcoin_internal.weekly_run_start_fields_v16();
ALTER TABLE jigcoin_internal.weekly_runs_v14
  DROP CONSTRAINT IF EXISTS weekly_runs_v14_week_user_id_slot_key;
CREATE UNIQUE INDEX IF NOT EXISTS weekly_legacy_slots_v16
  ON jigcoin_internal.weekly_runs_v14 (week,user_id,slot) WHERE policy_version='weekly-v14';
CREATE UNIQUE INDEX IF NOT EXISTS weekly_daily_slots_v16
  ON jigcoin_internal.weekly_runs_v14 (user_id,allowance_day,slot) WHERE policy_version='daily-v16';
CREATE INDEX IF NOT EXISTS weekly_latest_runs_v16
  ON jigcoin_internal.weekly_runs_v14 (user_id,starts_at DESC,id);

-- A retry may arrive with a second key while a run is already active. Retain
-- that alias as well, so a delayed retry cannot consume the next ranked slot.
CREATE TABLE IF NOT EXISTS jigcoin_internal.weekly_run_requests_v16 (
  user_id bigint NOT NULL REFERENCES public.users(id),
  request_key uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES jigcoin_internal.weekly_runs_v14(id),
  PRIMARY KEY (user_id,request_key)
);
CREATE INDEX IF NOT EXISTS weekly_request_run_v16 ON jigcoin_internal.weekly_run_requests_v16(run_id);
INSERT INTO jigcoin_internal.weekly_run_requests_v16(user_id,request_key,run_id)
  SELECT user_id,request_key,id FROM jigcoin_internal.weekly_runs_v14 ON CONFLICT DO NOTHING;

-- An old recorded cosmetic remains unchanged. Do not infer a historic VIP
-- entitlement or rank from a player's current balance or current purchase.
UPDATE jigcoin_internal.weekly_runs_v14 SET rank_finish_key=finish_key
  WHERE rank_finish_key IS NULL AND finish_key ~ '^rank-[0-7]$';

-- Keep only the latest practice run per player. It has no racer/award linkage,
-- and no shared request or puzzle seed with ranked runs.
CREATE TABLE IF NOT EXISTS jigcoin_internal.weekly_practice_runs_v16 (
  user_id bigint PRIMARY KEY REFERENCES public.users(id),
  id uuid NOT NULL UNIQUE,
  request_key uuid NOT NULL,
  request_keys uuid[] NOT NULL CHECK (cardinality(request_keys) BETWEEN 1 AND 16),
  seed text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at>starts_at),
  turn integer NOT NULL DEFAULT 0 CHECK (turn>=0),
  score integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND turn)
);

CREATE TABLE IF NOT EXISTS jigcoin_internal.weekly_finalizations_v16 (
  week date PRIMARY KEY,
  finalized_at timestamptz NOT NULL,
  participants integer NOT NULL CHECK (participants>=0),
  winning_score integer NOT NULL CHECK (winning_score>=0),
  policy_version text NOT NULL CHECK (policy_version IN ('weekly-v14','daily-v16')),
  source text NOT NULL CHECK (source IN ('legacy_import','server'))
);
CREATE TABLE IF NOT EXISTS jigcoin_internal.weekly_awards_v16 (
  week date NOT NULL REFERENCES jigcoin_internal.weekly_finalizations_v16(week),
  user_id bigint NOT NULL REFERENCES public.users(id),
  score integer NOT NULL CHECK (score>0),
  place smallint NOT NULL DEFAULT 1 CHECK (place=1),
  awarded_at timestamptz NOT NULL,
  player_name text NOT NULL,
  finish_key text,
  vip_active boolean,
  rank_finish_key text CHECK (rank_finish_key ~ '^rank-[0-7]$'),
  PRIMARY KEY (week,user_id)
);
CREATE INDEX IF NOT EXISTS weekly_award_history_v16
  ON jigcoin_internal.weekly_awards_v16 (user_id,week DESC);

-- Record a one-time legacy cutoff, so reapplying this migration cannot turn a
-- later week into an import or recalculate already earned medals.
CREATE TABLE IF NOT EXISTS jigcoin_internal.weekly_upgrade_v16 (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  legacy_before_week date NOT NULL
);
INSERT INTO jigcoin_internal.weekly_upgrade_v16(id,legacy_before_week)
  VALUES (true,date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date)
  ON CONFLICT DO NOTHING;
WITH weeks AS (
  SELECT r.week,count(*) FILTER (WHERE r.best>0)::integer AS participants,
    coalesce(max(r.best),0) AS winning_score
  FROM jigcoin_internal.weekly_racers_v14 r
  WHERE r.week<(SELECT legacy_before_week FROM jigcoin_internal.weekly_upgrade_v16 WHERE id)
  GROUP BY r.week
), imported AS (
  INSERT INTO jigcoin_internal.weekly_finalizations_v16
    (week,finalized_at,participants,winning_score,policy_version,source)
  SELECT week,clock_timestamp(),participants,winning_score,'weekly-v14','legacy_import' FROM weeks
  ON CONFLICT DO NOTHING RETURNING *
)
INSERT INTO jigcoin_internal.weekly_awards_v16
  (week,user_id,score,place,awarded_at,player_name,finish_key,vip_active,rank_finish_key)
SELECT f.week,r.user_id,r.best,1,f.finalized_at,
  left(coalesce(nullif(u.username,''),nullif(u.first_name,''),'Player'),48),
  best.finish_key,best.vip_active_at_start,best.rank_finish_key
FROM imported f JOIN jigcoin_internal.weekly_racers_v14 r
  ON r.week=f.week AND r.best=f.winning_score AND r.best>0
JOIN public.users u ON u.id=r.user_id
LEFT JOIN LATERAL (
  SELECT run.finish_key,run.vip_active_at_start,run.rank_finish_key
  FROM jigcoin_internal.weekly_runs_v14 run
  WHERE run.week=r.week AND run.user_id=r.user_id AND run.score=r.best
  ORDER BY run.starts_at DESC,run.id LIMIT 1
) best ON true
ON CONFLICT DO NOTHING;

-- Awards are append-only snapshots, including when a player's name, coin,
-- balance, VIP entitlement or eligibility later changes.
CREATE OR REPLACE FUNCTION jigcoin_internal.reject_weekly_history_change_v16()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Finalized weekly history is immutable' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION jigcoin_internal.reject_weekly_history_change_v16() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS weekly_history_immutable_v16 ON jigcoin_internal.weekly_finalizations_v16;
CREATE TRIGGER weekly_history_immutable_v16 BEFORE UPDATE OR DELETE
  ON jigcoin_internal.weekly_finalizations_v16 FOR EACH ROW
  EXECUTE FUNCTION jigcoin_internal.reject_weekly_history_change_v16();
DROP TRIGGER IF EXISTS weekly_awards_immutable_v16 ON jigcoin_internal.weekly_awards_v16;
CREATE TRIGGER weekly_awards_immutable_v16 BEFORE UPDATE OR DELETE
  ON jigcoin_internal.weekly_awards_v16 FOR EACH ROW
  EXECUTE FUNCTION jigcoin_internal.reject_weekly_history_change_v16();

ALTER TABLE jigcoin_internal.weekly_practice_runs_v16 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.weekly_run_requests_v16 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.weekly_finalizations_v16 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.weekly_awards_v16 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.weekly_upgrade_v16 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.weekly_practice_runs_v16,
  jigcoin_internal.weekly_run_requests_v16,
  jigcoin_internal.weekly_finalizations_v16,jigcoin_internal.weekly_awards_v16,
  jigcoin_internal.weekly_upgrade_v16 FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON jigcoin_internal.weekly_practice_runs_v16 TO service_role;
GRANT SELECT,INSERT ON jigcoin_internal.weekly_run_requests_v16 TO service_role;
GRANT SELECT,INSERT ON jigcoin_internal.weekly_finalizations_v16,
  jigcoin_internal.weekly_awards_v16 TO service_role;
GRANT SELECT ON jigcoin_internal.weekly_upgrade_v16 TO service_role;
COMMIT;
