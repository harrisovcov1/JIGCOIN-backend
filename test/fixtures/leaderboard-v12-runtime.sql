-- Snapshot of the installed v12 daily race functions, verified on 19 Nov 2026.
-- Test fixture only: never applied by the application or a deployment.
CREATE OR REPLACE FUNCTION jigcoin_internal.capture_daily_score_v12()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE utc_day date := (clock_timestamp() AT TIME ZONE 'UTC')::date; first_day date;
BEGIN
 IF NEW.last_reset IS NULL OR NEW.last_reset>utc_day OR COALESCE(NEW.today_farmed,0)<=0 THEN RETURN NEW; END IF;
 IF NEW.last_reset IS NOT DISTINCT FROM OLD.last_reset AND NEW.today_farmed IS NOT DISTINCT FROM OLD.today_farmed THEN RETURN NEW; END IF;
 SELECT (installed_at AT TIME ZONE 'UTC')::date INTO first_day FROM jigcoin_internal.leaderboard_config_v12;
 IF NEW.last_reset<first_day THEN RETURN NEW; END IF;
 -- Shared day lock serializes against finalization without serializing players.
 PERFORM pg_advisory_xact_lock_shared(731212,NEW.last_reset-DATE '2000-01-01');
 INSERT INTO jigcoin_internal.leaderboard_days_v12(day) VALUES(NEW.last_reset) ON CONFLICT DO NOTHING;
 IF EXISTS(SELECT 1 FROM jigcoin_internal.leaderboard_days_v12 WHERE day=NEW.last_reset AND finalized_at IS NOT NULL)
 THEN RAISE EXCEPTION 'DAILY_RACE_CLOSED: retry the tap in the current UTC day'; END IF;
 INSERT INTO jigcoin_internal.leaderboard_scores_v12(day,user_id,score) VALUES(NEW.last_reset,NEW.id,NEW.today_farmed)
 ON CONFLICT(day,user_id) DO UPDATE SET score=GREATEST(leaderboard_scores_v12.score,EXCLUDED.score),updated_at=clock_timestamp();
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION jigcoin_internal.finalize_daily_race_v12(race_day date)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE first_day date; stamp timestamptz := clock_timestamp(); participants integer;
BEGIN
 SELECT award_start_day INTO first_day FROM jigcoin_internal.leaderboard_config_v12;
 IF race_day IS NULL OR race_day<first_day OR stamp<((race_day+1)::timestamp AT TIME ZONE 'UTC')+interval '2 minutes' THEN RETURN FALSE; END IF;
 PERFORM pg_advisory_xact_lock(731212,race_day-DATE '2000-01-01');
 INSERT INTO jigcoin_internal.leaderboard_days_v12(day) VALUES(race_day) ON CONFLICT DO NOTHING;
 IF EXISTS(SELECT 1 FROM jigcoin_internal.leaderboard_days_v12 WHERE day=race_day AND finalized_at IS NOT NULL) THEN RETURN FALSE; END IF;
 WITH eligible AS MATERIALIZED (
  SELECT s.user_id,s.score,u.telegram_id,LEFT(COALESCE(NULLIF(u.username,''),NULLIF(u.first_name,''),'Player'),64) AS display_name
  FROM jigcoin_internal.leaderboard_scores_v12 s JOIN public.users u ON u.id=s.user_id
  WHERE s.day=race_day AND s.score>0 AND u.telegram_id>0 AND COALESCE(u.is_system_user,FALSE)=FALSE
  AND (u.banned_until IS NULL OR u.banned_until<=stamp)
 ), numbered AS (SELECT *,ROW_NUMBER() OVER(ORDER BY score DESC,telegram_id ASC) AS place FROM eligible),
 awards AS (
  INSERT INTO jigcoin_internal.leaderboard_awards_v12(day,place,user_id,score,display_name)
  SELECT race_day,place,user_id,score,display_name FROM numbered WHERE place<=3 ON CONFLICT DO NOTHING RETURNING user_id
 ) SELECT count(*)::integer INTO participants FROM eligible;
 UPDATE jigcoin_internal.leaderboard_days_v12 SET finalized_at=stamp,participant_count=participants WHERE day=race_day;
 RETURN TRUE;
END $function$
;
