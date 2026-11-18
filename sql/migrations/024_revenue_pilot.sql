BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(14142026);

CREATE TABLE IF NOT EXISTS jigcoin_internal.pilot_players_v14 (
  user_id bigint PRIMARY KEY REFERENCES public.users(id),
  ad_group text NOT NULL CHECK (ad_group IN ('baseline', 'refill', 'holdout')),
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  returned_day7_at timestamptz,
  vip_coin boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS jigcoin_internal.weekly_racers_v14 (
  week date NOT NULL,
  user_id bigint NOT NULL REFERENCES public.users(id),
  share_code text NOT NULL UNIQUE,
  best integer NOT NULL DEFAULT 0 CHECK (best >= 0),
  PRIMARY KEY (week, user_id)
);
CREATE INDEX IF NOT EXISTS weekly_scores_v14 ON jigcoin_internal.weekly_racers_v14 (week, best DESC, user_id);
CREATE INDEX IF NOT EXISTS weekly_history_v14 ON jigcoin_internal.weekly_racers_v14 (user_id, week DESC);

CREATE TABLE IF NOT EXISTS jigcoin_internal.weekly_runs_v14 (
  id uuid PRIMARY KEY,
  request_key uuid NOT NULL,
  week date NOT NULL,
  user_id bigint NOT NULL,
  slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 3),
  seed text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  turn integer NOT NULL DEFAULT 0 CHECK (turn >= 0),
  score integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND turn),
  UNIQUE (user_id, request_key),
  UNIQUE (week, user_id, slot),
  FOREIGN KEY (week, user_id) REFERENCES jigcoin_internal.weekly_racers_v14 (week, user_id)
);

-- First 30 days from pilot enrolment, including existing players. Record only
-- reconciled totals for the exact group and day. A missing amount stays NULL.
CREATE TABLE IF NOT EXISTS jigcoin_internal.pilot_finance_v14 (
  cohort_day date NOT NULL,
  ad_group text NOT NULL CHECK (ad_group IN ('baseline', 'refill', 'holdout')),
  stars_net_gbp numeric(18,4) NOT NULL,
  ads_net_gbp numeric(18,4) NOT NULL,
  delivery_cost_gbp numeric(18,4) NOT NULL CHECK (delivery_cost_gbp >= 0),
  acquisition_cost_gbp numeric(18,4) NOT NULL CHECK (acquisition_cost_gbp >= 0),
  evidence text NOT NULL CHECK (length(trim(evidence)) > 0),
  PRIMARY KEY (cohort_day, ad_group)
);
ALTER TABLE jigcoin_internal.pilot_finance_v14 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.pilot_finance_v14 FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON jigcoin_internal.pilot_finance_v14 TO service_role;

ALTER TABLE jigcoin_internal.pilot_players_v14 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.weekly_racers_v14 ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.weekly_runs_v14 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.pilot_players_v14, jigcoin_internal.weekly_racers_v14,
  jigcoin_internal.weekly_runs_v14 FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON jigcoin_internal.pilot_players_v14, jigcoin_internal.weekly_racers_v14,
  jigcoin_internal.weekly_runs_v14 TO service_role;
COMMIT;
