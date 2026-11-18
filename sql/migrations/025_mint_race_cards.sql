BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(14142026);

-- Older runs have no recorded finish. Keep that history explicitly unknown.
ALTER TABLE jigcoin_internal.weekly_runs_v14 ADD COLUMN IF NOT EXISTS finish_key text
  CHECK (finish_key IN ('rank-0','rank-1','rank-2','rank-3','rank-4','rank-5','rank-6','rank-7','launch','midnight'));

CREATE TABLE IF NOT EXISTS jigcoin_internal.weekly_result_cards (
  code text PRIMARY KEY CHECK (code ~ '^[a-f0-9]{32}$'),
  first_run uuid NOT NULL REFERENCES jigcoin_internal.weekly_runs_v14(id),
  second_run uuid NOT NULL REFERENCES jigcoin_internal.weekly_runs_v14(id),
  CHECK (first_run < second_run),
  UNIQUE (first_run, second_run)
);
ALTER TABLE jigcoin_internal.weekly_result_cards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.weekly_result_cards FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON jigcoin_internal.weekly_result_cards TO service_role;
COMMIT;
