BEGIN;
CREATE SCHEMA IF NOT EXISTS jigcoin_internal;
CREATE TABLE jigcoin_internal.championship_config(
 singleton boolean PRIMARY KEY CHECK(singleton), accepted_at timestamptz NOT NULL);
CREATE TABLE jigcoin_internal.championship_exclusions(
 player bigint PRIMARY KEY REFERENCES public.users(id), reason text NOT NULL);
CREATE TABLE jigcoin_internal.championship_runs(
 id uuid PRIMARY KEY, player bigint NOT NULL REFERENCES public.users(id), day date NOT NULL, week date NOT NULL,
 mode text NOT NULL CHECK(mode IN ('practice','ranked')), slot int NOT NULL CHECK(slot BETWEEN 1 AND 3 AND (mode='ranked' OR slot=1)),
 request uuid NOT NULL, variant int NOT NULL CHECK(variant BETWEEN 0 AND 29), board jsonb NOT NULL,
 expires timestamptz NOT NULL, opened timestamptz NOT NULL, round int NOT NULL DEFAULT 0 CHECK(round BETWEEN 0 AND 5),
 correct int NOT NULL DEFAULT 0 CHECK(correct BETWEEN 0 AND round), finished boolean NOT NULL DEFAULT false,
 UNIQUE(player,day,mode,slot), UNIQUE(player,request));
CREATE INDEX championship_week ON jigcoin_internal.championship_runs(week,player) WHERE finished AND mode='ranked';
CREATE TABLE jigcoin_internal.championship_weeks(week date PRIMARY KEY, settled timestamptz NOT NULL DEFAULT now());
CREATE TABLE jigcoin_internal.championship_trophies(
 week date NOT NULL REFERENCES jigcoin_internal.championship_weeks, place int NOT NULL,
 player bigint NOT NULL REFERENCES public.users(id), score int NOT NULL CHECK(score BETWEEN 1 AND 6000),
 coins int NOT NULL CHECK((place,coins) IN ((1,100000),(2,50000),(3,25000))), ledger_id bigint NOT NULL UNIQUE REFERENCES public.user_balance_ledger(id),
 PRIMARY KEY(week,place), UNIQUE(week,player));
CREATE TABLE jigcoin_internal.championship_reminders(
 player bigint PRIMARY KEY REFERENCES public.users(id), minute int NOT NULL CHECK(minute BETWEEN 0 AND 1439),
 quiet_from int NOT NULL CHECK(quiet_from BETWEEN 0 AND 23), quiet_to int NOT NULL CHECK(quiet_to BETWEEN 0 AND 23));
CREATE TABLE jigcoin_internal.championship_deliveries(
 player bigint NOT NULL, day date NOT NULL, state text NOT NULL CHECK(state IN ('reserved','sent','uncertain','blocked')),
 PRIMARY KEY(player,day));
COMMIT;
