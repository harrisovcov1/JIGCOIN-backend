CREATE TABLE jigcoin_internal.leaderboard_config_v12(singleton boolean PRIMARY KEY DEFAULT true,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()-interval '4 days',
  award_start_day date NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date-3);
 INSERT INTO jigcoin_internal.leaderboard_config_v12(singleton) VALUES(true);
 CREATE TABLE jigcoin_internal.leaderboard_days_v12(day date PRIMARY KEY,finalized_at timestamptz,participant_count integer);
 CREATE TABLE jigcoin_internal.leaderboard_scores_v12(day date NOT NULL,user_id bigint NOT NULL REFERENCES public.users(id),
  score bigint NOT NULL,updated_at timestamptz DEFAULT clock_timestamp(),PRIMARY KEY(day,user_id));
 CREATE TABLE jigcoin_internal.leaderboard_awards_v12(day date NOT NULL,place smallint NOT NULL,
  user_id bigint NOT NULL REFERENCES public.users(id),score bigint NOT NULL,display_name text NOT NULL,
  awarded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(day,place),UNIQUE(day,user_id));
