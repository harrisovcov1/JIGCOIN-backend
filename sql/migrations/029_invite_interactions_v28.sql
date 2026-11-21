-- JigCoin Invite v28: additive private engagement telemetry only.
-- No referral credits, account balances, reward rates, or payment tables changed.
CREATE TABLE IF NOT EXISTS jigcoin_internal.invite_interactions_v28 (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (event_name IN ('share_open','copy_link','card_open','card_download','friends_open','race_open')),
  bucket_10m BIGINT NOT NULL CHECK (bucket_10m > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id,event_name,bucket_10m)
);
CREATE INDEX IF NOT EXISTS invite_interactions_recent_v28 ON jigcoin_internal.invite_interactions_v28(event_name,created_at DESC);
ALTER TABLE jigcoin_internal.invite_interactions_v28 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.invite_interactions_v28 FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE jigcoin_internal.invite_interactions_v28_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA jigcoin_internal TO service_role;
GRANT SELECT,INSERT ON jigcoin_internal.invite_interactions_v28 TO service_role;
GRANT USAGE,SELECT ON SEQUENCE jigcoin_internal.invite_interactions_v28_id_seq TO service_role;
