BEGIN;
SET LOCAL lock_timeout='5s';
CREATE SCHEMA IF NOT EXISTS jigcoin_internal;
CREATE TABLE IF NOT EXISTS jigcoin_internal.streak_restore_orders (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id),
  telegram_id bigint NOT NULL,
  payload text NOT NULL UNIQUE CHECK(payload ~ '^sr_[a-f0-9]{48}$'),
  prior_last_day date NOT NULL,
  prior_streak integer NOT NULL CHECK(prior_streak>0),
  missed_day date NOT NULL,
  stars integer NOT NULL DEFAULT 250 CHECK(stars=250),
  status text NOT NULL DEFAULT 'created' CHECK(status IN ('created','invoiced','approved','restored','refund_pending','refunded')),
  precheckout_id text UNIQUE,
  charge_id text UNIQUE,
  invoice_url text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_at timestamptz,
  restored_at timestamptz,
  refunded_at timestamptz,
  UNIQUE(user_id,missed_day),
  CHECK(missed_day=prior_last_day+1),
  CHECK(expires_at=((prior_last_day+3)::timestamp AT TIME ZONE 'UTC'))
);
ALTER TABLE jigcoin_internal.streak_restore_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.streak_restore_orders FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE jigcoin_internal.streak_restore_orders_id_seq FROM PUBLIC,anon,authenticated;
-- Backend database connection owns the table. No browser access or balance changes.
COMMIT;
