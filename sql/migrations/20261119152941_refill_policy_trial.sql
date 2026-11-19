-- Generated with Supabase CLI 2.81.3 migration new refill_policy_trial.
-- Apply before the v15 backend. Additive; never changes balances, rewards,
-- existing v14 groups, attempt timestamps, or prior receipts.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock(15112026);

-- Both names occur in supported installs. Preserve ALL known legacy values,
-- including the deployed 3600-second energy/double attempts absent from 023.
ALTER TABLE jigcoin_internal.ad_attempts DROP CONSTRAINT IF EXISTS ad_attempts_cooldown_seconds_check;
ALTER TABLE jigcoin_internal.ad_attempts DROP CONSTRAINT IF EXISTS ad_attempts_cooldown_policy;
ALTER TABLE jigcoin_internal.ad_attempts ADD CONSTRAINT ad_attempts_cooldown_policy CHECK (
  cooldown_seconds=86400
  OR (reward_kind IN ('energy_refill','double_10m') AND cooldown_seconds=3600)
  OR (reward_kind IN ('coins','energy_refill') AND cooldown_seconds=300)
  OR (reward_kind='double_10m' AND cooldown_seconds=1800)
  OR (reward_kind='energy_refill' AND cooldown_seconds=120)
);

CREATE TABLE IF NOT EXISTS jigcoin_internal.refill_cohorts_v15 (
  user_id bigint NOT NULL REFERENCES public.users(id),
  policy_version text NOT NULL CHECK (policy_version='refill-v15-20261119'),
  cohort text NOT NULL CHECK (cohort IN ('control_300','treatment_120','qa_120')),
  cooldown_seconds integer NOT NULL,
  excluded boolean NOT NULL DEFAULT FALSE,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  returned_day7_at timestamptz,
  PRIMARY KEY (user_id,policy_version),
  CHECK ((cohort='control_300' AND cooldown_seconds=300)
    OR (cohort IN ('treatment_120','qa_120') AND cooldown_seconds=120)),
  CHECK (cohort<>'qa_120' OR excluded)
);
CREATE INDEX IF NOT EXISTS refill_cohorts_v15_group_time
  ON jigcoin_internal.refill_cohorts_v15(policy_version,cohort,assigned_at);

ALTER TABLE jigcoin_internal.ad_attempts ADD COLUMN IF NOT EXISTS refill_policy_version text;
ALTER TABLE jigcoin_internal.ad_attempts ADD COLUMN IF NOT EXISTS refill_group text;
ALTER TABLE jigcoin_internal.ad_attempts ADD COLUMN IF NOT EXISTS refill_start_energy integer;
ALTER TABLE jigcoin_internal.ad_attempts ADD COLUMN IF NOT EXISTS refill_start_cap integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='jigcoin_internal.ad_attempts'::regclass
    AND conname='ad_attempts_refill_snapshot_v15') THEN
    ALTER TABLE jigcoin_internal.ad_attempts ADD CONSTRAINT ad_attempts_refill_snapshot_v15 CHECK (
      (refill_policy_version IS NULL AND refill_group IS NULL
        AND refill_start_energy IS NULL AND refill_start_cap IS NULL)
      OR (refill_policy_version IS NOT NULL AND refill_group IS NOT NULL
        AND refill_policy_version='refill-v15-20261119' AND reward_kind='energy_refill'
        AND refill_group IN ('control_300','treatment_120','qa_120')
        AND refill_start_energy IS NOT NULL AND refill_start_cap IS NOT NULL
        AND refill_start_cap BETWEEN 1 AND 100000 AND refill_start_energy BETWEEN 0 AND refill_start_cap
        AND ((refill_group='control_300' AND cooldown_seconds=300)
          OR (refill_group IN ('treatment_120','qa_120') AND cooldown_seconds=120)))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='jigcoin_internal.ad_attempts'::regclass
    AND conname='ad_attempts_refill_cohort_v15') THEN
    ALTER TABLE jigcoin_internal.ad_attempts ADD CONSTRAINT ad_attempts_refill_cohort_v15
      FOREIGN KEY (user_id,refill_policy_version) REFERENCES jigcoin_internal.refill_cohorts_v15(user_id,policy_version);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ad_attempts_refill_v15_time
  ON jigcoin_internal.ad_attempts(refill_policy_version,refill_group,created_at)
  WHERE refill_policy_version IS NOT NULL;

CREATE TABLE IF NOT EXISTS jigcoin_internal.refill_events_v15 (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL,
  policy_version text NOT NULL,
  cohort text NOT NULL CHECK (cohort IN ('control_300','treatment_120','qa_120')),
  attempt_id uuid REFERENCES jigcoin_internal.ad_attempts(ymid),
  event text NOT NULL CHECK (event IN ('PROMPT_SHOWN','PREPARED','PREPARED_EXPIRED')),
  elapsed_ms integer CHECK (elapsed_ms BETWEEN 0 AND 300000),
  offer_window timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id,policy_version) REFERENCES jigcoin_internal.refill_cohorts_v15(user_id,policy_version),
  CHECK ((event='PROMPT_SHOWN' AND attempt_id IS NULL AND offer_window IS NOT NULL)
    OR (event IN ('PREPARED','PREPARED_EXPIRED') AND attempt_id IS NOT NULL AND offer_window IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS refill_events_v15_attempt_once
  ON jigcoin_internal.refill_events_v15(attempt_id,event) WHERE attempt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS refill_events_v15_offer_minute
  ON jigcoin_internal.refill_events_v15(user_id,policy_version,event,offer_window) WHERE attempt_id IS NULL;
CREATE INDEX IF NOT EXISTS refill_events_v15_group_time
  ON jigcoin_internal.refill_events_v15(policy_version,cohort,created_at);

-- Reconciled totals for each assignment day's first 30 days. Do not allocate
-- old v14 revenue by player counts or turn SDK estimates into settled GBP.
CREATE TABLE IF NOT EXISTS jigcoin_internal.refill_finance_v15 (
  policy_version text NOT NULL CHECK (policy_version='refill-v15-20261119'),
  cohort_day date NOT NULL,
  cohort text NOT NULL CHECK (cohort IN ('control_300','treatment_120')),
  ads_net_gbp numeric(18,4), stars_net_gbp numeric(18,4),
  delivery_cost_gbp numeric(18,4) CHECK (delivery_cost_gbp>=0),
  acquisition_cost_gbp numeric(18,4) CHECK (acquisition_cost_gbp>=0),
  coverage_complete boolean NOT NULL DEFAULT FALSE,
  evidence_ref text, allocation_method text,
  reconciled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (policy_version,cohort_day,cohort),
  CHECK (NOT coverage_complete OR (ads_net_gbp IS NOT NULL AND stars_net_gbp IS NOT NULL
    AND delivery_cost_gbp IS NOT NULL AND acquisition_cost_gbp IS NOT NULL
    AND coalesce(length(trim(evidence_ref)),0)>=10 AND coalesce(length(trim(allocation_method)),0)>=10))
);

ALTER TABLE jigcoin_internal.refill_cohorts_v15 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.refill_events_v15 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.refill_finance_v15 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.refill_cohorts_v15,jigcoin_internal.refill_events_v15,
  jigcoin_internal.refill_finance_v15 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE jigcoin_internal.refill_events_v15_id_seq FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON jigcoin_internal.refill_cohorts_v15,jigcoin_internal.refill_finance_v15 TO service_role;
GRANT SELECT,INSERT ON jigcoin_internal.refill_events_v15 TO service_role;
GRANT USAGE,SELECT ON SEQUENCE jigcoin_internal.refill_events_v15_id_seq TO service_role;
COMMIT;
