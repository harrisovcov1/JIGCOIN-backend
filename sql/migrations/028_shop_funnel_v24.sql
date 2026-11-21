-- JigCoin Shop v24: private, deduplicated engagement signals.
-- This additive migration changes no balances, orders, or active prices.
CREATE TABLE IF NOT EXISTS jigcoin_internal.shop_funnel_events_v24 (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK(event_name IN ('pack_selected','vip_opened','finish_preview','checkout_review','starter_seen')),
  sku TEXT NOT NULL DEFAULT '' CHECK(sku='' OR sku ~ '^JC_[A-Z0-9_]{1,40}$'),
  bucket_10m BIGINT NOT NULL CHECK(bucket_10m>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id,event_name,sku,bucket_10m)
);
CREATE INDEX IF NOT EXISTS shop_funnel_event_recent_v24
  ON jigcoin_internal.shop_funnel_events_v24(event_name,created_at DESC);
ALTER TABLE jigcoin_internal.shop_funnel_events_v24 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.shop_funnel_events_v24
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE jigcoin_internal.shop_funnel_events_v24_id_seq
  FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA jigcoin_internal TO service_role;
GRANT SELECT,INSERT ON jigcoin_internal.shop_funnel_events_v24 TO service_role;
GRANT USAGE,SELECT ON SEQUENCE jigcoin_internal.shop_funnel_events_v24_id_seq TO service_role;
-- The proposed 1,000-Star bridge pack is intentionally inactive: it cannot
-- be displayed or purchased until a separately reviewed pricing experiment.
INSERT INTO jigcoin_internal.stars_products
  (sku,title,coins,stars,starter,featured,sort_order,active)
VALUES ('JC_BRIDGE_TEST','Bridge pack (test)',14500,1000,FALSE,FALSE,4,FALSE)
ON CONFLICT (sku) DO NOTHING;
