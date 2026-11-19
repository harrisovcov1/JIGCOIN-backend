BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(14142026);

CREATE TABLE IF NOT EXISTS jigcoin_internal.telegram_write_grants (
  telegram_id bigint PRIMARY KEY,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jigcoin_internal.daily_streak_reminders (
  user_id bigint NOT NULL REFERENCES public.users(id),
  target_day date NOT NULL,
  due_at timestamptz NOT NULL,
  time_zone text NOT NULL,
  local_time text NOT NULL,
  opted_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('scheduled','cancelled','reserved','sent','skipped','undelivered')),
  attempted_at timestamptz,
  delivered_at timestamptz,
  PRIMARY KEY (user_id,target_day)
);
CREATE INDEX IF NOT EXISTS daily_streak_reminders_due ON jigcoin_internal.daily_streak_reminders(next_attempt_at)
  WHERE state='scheduled';
ALTER TABLE jigcoin_internal.telegram_write_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.daily_streak_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.telegram_write_grants, jigcoin_internal.daily_streak_reminders FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE ON jigcoin_internal.telegram_write_grants, jigcoin_internal.daily_streak_reminders TO service_role;
COMMIT;
