BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE jigcoin_internal.stars_offers
  ADD COLUMN IF NOT EXISTS offer_sku text NOT NULL DEFAULT 'JC_STARTER'
  REFERENCES jigcoin_internal.stars_products(sku);

-- Stage closed so installing the migration cannot open sales on an older backend.
INSERT INTO jigcoin_internal.stars_products(sku,title,coins,stars,starter,featured,sort_order,active)
VALUES('JC_STARTER_MAX','Maximum welcome offer',700000,17500,true,true,0,false)
ON CONFLICT(sku) DO NOTHING;
COMMIT;
