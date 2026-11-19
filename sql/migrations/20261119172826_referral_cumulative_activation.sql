-- New registrations only. v9/v10 pending contracts and all existing credits
-- remain untouched. Install before the v16 server; older servers ignore this
-- table, including during rollback.
BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('jigcoin_internal.referral_credits_v9') IS NULL
    OR to_regclass('jigcoin_internal.referral_credits_v10') IS NULL
    OR to_regclass('jigcoin_internal.welcome_credits_v10') IS NULL
    OR to_regclass('jigcoin_internal.tap_claims') IS NULL
    OR NOT EXISTS(SELECT 1 FROM jigcoin_internal.referral_migrations WHERE version='referrals_welcome_v10')
  THEN RAISE EXCEPTION 'Install the existing referral/welcome and verified tap schema first'; END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS jigcoin_internal.referral_credits_v16 (
  referral_id bigint PRIMARY KEY REFERENCES public.referrals(id),
  inviter_user_id bigint NOT NULL REFERENCES public.users(id),
  invitee_user_id bigint NOT NULL UNIQUE REFERENCES public.users(id),
  policy_version text NOT NULL DEFAULT 'referrals_cumulative_v16'
    CHECK(policy_version='referrals_cumulative_v16'),
  min_taps integer NOT NULL DEFAULT 100 CHECK(min_taps=100),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_taps integer NOT NULL DEFAULT 0 CHECK(verified_taps BETWEEN 0 AND 100),
  qualified_at timestamptz,
  awarded_at timestamptz,
  referral_ordinal integer,
  inviter_reward integer,
  inviter_ledger_id bigint UNIQUE REFERENCES public.user_balance_ledger(id),
  CHECK(inviter_user_id<>invitee_user_id),
  CHECK((qualified_at IS NULL AND verified_taps<min_taps)
    OR (qualified_at IS NOT NULL AND verified_taps=min_taps)),
  CHECK((awarded_at IS NULL AND referral_ordinal IS NULL
      AND inviter_reward IS NULL AND inviter_ledger_id IS NULL)
    OR (awarded_at IS NOT NULL AND qualified_at IS NOT NULL
      AND referral_ordinal IS NOT NULL AND referral_ordinal>0
      AND inviter_reward IS NOT NULL AND inviter_ledger_id IS NOT NULL
      AND inviter_reward=CASE WHEN referral_ordinal>=200 THEN 2000
        WHEN referral_ordinal>=50 THEN 1500 WHEN referral_ordinal>=20 THEN 1250
        WHEN referral_ordinal>=5 THEN 1000 ELSE 500 END))
);

CREATE INDEX IF NOT EXISTS referral_credits_v16_inviter_recent
  ON jigcoin_internal.referral_credits_v16(inviter_user_id,registered_at DESC);
CREATE INDEX IF NOT EXISTS tap_claims_positive_referral_v16
  ON jigcoin_internal.tap_claims(user_id) INCLUDE(applied) WHERE applied>0;
CREATE INDEX IF NOT EXISTS referrals_inviter_recent_v16
  ON public.referrals(inviter_id,created_at DESC,id DESC);

ALTER TABLE jigcoin_internal.referral_credits_v16 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.referral_credits_v16 FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON jigcoin_internal.referral_credits_v16 TO service_role;

INSERT INTO jigcoin_internal.referral_migrations(version)
  VALUES('referrals_cumulative_v16') ON CONFLICT(version) DO NOTHING;

DO $verify$
BEGIN
  IF has_table_privilege('anon','jigcoin_internal.referral_credits_v16','SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('authenticated','jigcoin_internal.referral_credits_v16','SELECT,INSERT,UPDATE,DELETE')
    OR NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='jigcoin_internal' AND c.relname='referral_credits_v16' AND c.relrowsecurity)
  THEN RAISE EXCEPTION 'Referral v16 must remain private to the server'; END IF;
END
$verify$;

COMMIT;
