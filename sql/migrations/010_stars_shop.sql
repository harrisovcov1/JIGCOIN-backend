-- Additive private Stars catalogue/orders. Does not enable payments or change existing balances.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE SCHEMA IF NOT EXISTS jigcoin_internal;
CREATE TABLE IF NOT EXISTS jigcoin_internal.stars_products (
 sku text PRIMARY KEY,title text NOT NULL CHECK(length(title) BETWEEN 1 AND 32),
 coins bigint NOT NULL CHECK(coins>0 AND coins<=1000000),stars integer NOT NULL CHECK(stars>0 AND stars<=100000),
 starter boolean NOT NULL DEFAULT false,featured boolean NOT NULL DEFAULT true,sort_order integer NOT NULL DEFAULT 0,
 active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS jigcoin_internal.stars_offers (
 user_id bigint PRIMARY KEY REFERENCES public.users(id),opened_at timestamptz NOT NULL DEFAULT NOW(),expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS jigcoin_internal.stars_shop_visitors (
 user_id bigint NOT NULL REFERENCES public.users(id),visit_day date NOT NULL,PRIMARY KEY(user_id,visit_day)
);
CREATE TABLE IF NOT EXISTS jigcoin_internal.stars_orders (
 id bigserial PRIMARY KEY,user_id bigint NOT NULL REFERENCES public.users(id),telegram_id bigint NOT NULL,
 sku text NOT NULL REFERENCES jigcoin_internal.stars_products(sku),title text NOT NULL,
 coins bigint NOT NULL CHECK(coins>0),stars integer NOT NULL CHECK(stars>0),starter boolean NOT NULL DEFAULT false,
 payload text NOT NULL UNIQUE CHECK(payload ~ '^[a-f0-9]{48}$'),invoice_url text,
 status text NOT NULL DEFAULT 'created' CHECK(status IN ('created','invoiced','approved','paid','expired','refunded')),
 precheckout_id text UNIQUE,charge_id text UNIQUE,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT NOW(),
 paid_at timestamptz,refunded_at timestamptz,unrecovered_coins bigint NOT NULL DEFAULT 0 CHECK(unrecovered_coins>=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS stars_one_open_sku ON jigcoin_internal.stars_orders(user_id,sku) WHERE status IN ('created','invoiced','approved');
CREATE UNIQUE INDEX IF NOT EXISTS stars_one_starter ON jigcoin_internal.stars_orders(user_id) WHERE starter=TRUE AND status IN ('approved','paid','refunded');
CREATE INDEX IF NOT EXISTS stars_orders_user_date ON jigcoin_internal.stars_orders(user_id,created_at DESC);
-- Initial test prices, not an asserted GBP conversion or proven optimum. No overwrite on rerun.
INSERT INTO jigcoin_internal.stars_products(sku,title,coins,stars,starter,featured,sort_order) VALUES
 ('JC_STARTER','Starter offer',1000,50,true,true,0),
 ('JC_SMALL','Small coin pack',1000,100,false,true,1),
 ('JC_MEDIUM','Medium coin pack',3000,250,false,true,2),
 ('JC_LARGE','Large coin pack',7000,500,false,true,3)
ON CONFLICT(sku) DO NOTHING;
ALTER TABLE jigcoin_internal.stars_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.stars_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.stars_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE jigcoin_internal.stars_shop_visitors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.stars_products,jigcoin_internal.stars_offers,jigcoin_internal.stars_orders,jigcoin_internal.stars_shop_visitors FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE jigcoin_internal.stars_orders_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA jigcoin_internal TO service_role;
GRANT SELECT,INSERT,UPDATE ON jigcoin_internal.stars_products,jigcoin_internal.stars_offers,jigcoin_internal.stars_orders,jigcoin_internal.stars_shop_visitors TO service_role;
GRANT USAGE,SELECT ON SEQUENCE jigcoin_internal.stars_orders_id_seq TO service_role;
COMMIT;
SELECT 'Stars shop schema ready; purchases remain controlled by STARS_SHOP_ENABLED and the tester account' AS result;
