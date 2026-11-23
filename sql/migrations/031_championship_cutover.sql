BEGIN;
ALTER TABLE jigcoin_internal.championship_runs
 ADD COLUMN points integer CHECK(points BETWEEN 0 AND 1000),
 ADD COLUMN flips integer[] NOT NULL DEFAULT '{}';
UPDATE jigcoin_internal.championship_runs SET points=correct*200;
ALTER TABLE jigcoin_internal.championship_runs ALTER COLUMN points SET DEFAULT 0,
 ALTER COLUMN points SET NOT NULL;

-- Permanent cutoff, latched when activation is recorded. An old binary does
-- not know this table. Reverting flags, or removing config, cannot lift it.
CREATE TABLE jigcoin_internal.championship_legacy_cutoff(
 singleton boolean PRIMARY KEY CHECK(singleton), first_week date NOT NULL);
CREATE FUNCTION jigcoin_internal.latch_championship_cutoff() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO jigcoin_internal.championship_legacy_cutoff VALUES
 (true,(date_trunc('week',NEW.accepted_at AT TIME ZONE 'UTC')::date+7))
 ON CONFLICT(singleton) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER championship_activation_latch AFTER INSERT OR UPDATE ON jigcoin_internal.championship_config
 FOR EACH ROW EXECUTE FUNCTION jigcoin_internal.latch_championship_cutoff();
INSERT INTO jigcoin_internal.championship_legacy_cutoff
 SELECT true,(date_trunc('week',accepted_at AT TIME ZONE 'UTC')::date+7)
 FROM jigcoin_internal.championship_config;

CREATE FUNCTION jigcoin_internal.guard_legacy_championship_award() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE period date;
BEGIN
 period := (to_jsonb(NEW)->>TG_ARGV[0])::date;
 IF EXISTS(SELECT FROM jigcoin_internal.championship_legacy_cutoff WHERE first_week<=period) THEN
   RETURN NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER championship_daily_guard BEFORE INSERT OR UPDATE ON jigcoin_internal.leaderboard_awards_v12
 FOR EACH ROW EXECUTE FUNCTION jigcoin_internal.guard_legacy_championship_award('day');
CREATE TRIGGER championship_weekly_guard BEFORE INSERT OR UPDATE ON jigcoin_internal.weekly_awards_v16
 FOR EACH ROW EXECUTE FUNCTION jigcoin_internal.guard_legacy_championship_award('week');
COMMIT;
