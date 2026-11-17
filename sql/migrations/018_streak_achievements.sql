-- Apply before the v6 backend. Adds cosmetics; does not credit or reset coins.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE jigcoin_internal.streak_cosmetics
 DROP CONSTRAINT IF EXISTS streak_cosmetics_cosmetic_key_check;
ALTER TABLE jigcoin_internal.streak_cosmetics
 ADD CONSTRAINT streak_cosmetics_cosmetic_key_check
 CHECK(cosmetic_key IN ('momentum_aura','veteran_frame','century_crest','endurance_frame'));
-- Honour milestones already reached, including recorded past broken streaks.
INSERT INTO jigcoin_internal.streak_cosmetics(user_id,cosmetic_key)
 SELECT u.id,c.key FROM public.users u
 CROSS JOIN (VALUES('century_crest',100),('endurance_frame',300)) c(key,days)
 WHERE COALESCE(u.streak_count,0)>=c.days ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF to_regclass('public.streak_events') IS NOT NULL THEN
  INSERT INTO jigcoin_internal.streak_cosmetics(user_id,cosmetic_key)
  SELECT e.user_id,c.key FROM public.streak_events e JOIN public.users u ON u.id=e.user_id
  CROSS JOIN (VALUES('century_crest',100),('endurance_frame',300)) c(key,days)
  WHERE e.event='checkin' AND CASE WHEN e.meta->>'streak' ~ '^[0-9]{1,10}$'
   THEN (e.meta->>'streak')::numeric ELSE 0 END>=c.days ON CONFLICT DO NOTHING;
 END IF;
END $$;
ALTER TABLE jigcoin_internal.streak_cosmetics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON jigcoin_internal.streak_cosmetics FROM PUBLIC,anon,authenticated;
COMMIT;
