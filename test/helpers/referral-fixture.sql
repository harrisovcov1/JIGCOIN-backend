-- Disposable test schema; legacy column/constraint contracts verified from the live schema.
CREATE SCHEMA jigcoin_internal;
CREATE TABLE public.users(id bigserial PRIMARY KEY, telegram_id bigint NOT NULL UNIQUE, username text,first_name text,last_name text,language_code text,balance bigint NOT NULL DEFAULT 0,is_system_user boolean NOT NULL DEFAULT FALSE,banned_until timestamptz,referrals_count bigint NOT NULL DEFAULT 0,referrals bigint NOT NULL DEFAULT 0,referrals_points bigint NOT NULL DEFAULT 0,referred_by bigint,taps_today integer NOT NULL DEFAULT 0,today_farmed integer NOT NULL DEFAULT 0,energy integer NOT NULL DEFAULT 55,max_energy integer NOT NULL DEFAULT 55,last_reset date DEFAULT CURRENT_DATE,last_energy_ts timestamptz DEFAULT clock_timestamp(),last_tap_at timestamptz,double_boost_until timestamptz,vip_until timestamptz);
CREATE TABLE public.user_balance_ledger(id bigserial PRIMARY KEY,user_id bigint REFERENCES public.users(id),delta bigint,reason text,ref_type text,ref_id bigint,event_type text,created_at timestamptz DEFAULT clock_timestamp());
CREATE SEQUENCE public.referrals_id_seq;

CREATE TABLE public.referrals (
  id integer NOT NULL DEFAULT nextval('referrals_id_seq'::regclass),
  inviter_id bigint NOT NULL,
  invited_id bigint NOT NULL,
  created_at timestamp without time zone DEFAULT now(),
  inviter_user_id integer,
  invitee_user_id integer,
  tier integer NOT NULL DEFAULT 1,
  inviter_reward_points bigint NOT NULL DEFAULT 0,
  invitee_reward_points bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'::text,
  credited_at timestamp with time zone,
  CONSTRAINT referrals_invitee_user_id_fkey FOREIGN KEY (invitee_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT referrals_inviter_id_invited_id_key UNIQUE (inviter_id, invited_id),
  CONSTRAINT referrals_inviter_user_id_fkey FOREIGN KEY (inviter_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT referrals_no_self CHECK ((inviter_id <> invited_id)),
  CONSTRAINT referrals_pkey PRIMARY KEY (id),
  CONSTRAINT referrals_unique_pair UNIQUE (inviter_id, invited_id)
);

CREATE TABLE jigcoin_internal.referral_migrations (
  version text NOT NULL,
  installed_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT referral_migrations_pkey PRIMARY KEY (version)
);

CREATE TABLE jigcoin_internal.welcome_credits_v10 (
  user_id bigint NOT NULL,
  telegram_id bigint NOT NULL,
  amount integer NOT NULL,
  ledger_id bigint NOT NULL,
  awarded_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT welcome_credits_v10_amount_check CHECK ((amount = 1000)),
  CONSTRAINT welcome_credits_v10_ledger_id_fkey FOREIGN KEY (ledger_id) REFERENCES user_balance_ledger(id),
  CONSTRAINT welcome_credits_v10_ledger_id_key UNIQUE (ledger_id),
  CONSTRAINT welcome_credits_v10_pkey PRIMARY KEY (user_id),
  CONSTRAINT welcome_credits_v10_telegram_id_check CHECK ((telegram_id > 0)),
  CONSTRAINT welcome_credits_v10_telegram_id_key UNIQUE (telegram_id),
  CONSTRAINT welcome_credits_v10_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE jigcoin_internal.referral_credits_v9 (
  referral_id bigint NOT NULL,
  inviter_user_id bigint NOT NULL,
  invitee_user_id bigint NOT NULL,
  activation_required boolean NOT NULL,
  min_taps integer NOT NULL,
  registered_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  awarded_at timestamp with time zone,
  inviter_reward integer,
  friend_reward integer,
  inviter_ledger_id bigint,
  friend_ledger_id bigint,
  qualification text,
  CONSTRAINT referral_credits_v9_check CHECK ((inviter_user_id <> invitee_user_id)),
  CONSTRAINT referral_credits_v9_check1 CHECK ((((awarded_at IS NULL) AND (inviter_reward IS NULL) AND (friend_reward IS NULL) AND (inviter_ledger_id IS NULL) AND (friend_ledger_id IS NULL) AND (qualification IS NULL)) OR ((awarded_at IS NOT NULL) AND (inviter_reward IS NOT NULL) AND (friend_reward IS NOT NULL) AND (inviter_ledger_id IS NOT NULL) AND (friend_ledger_id IS NOT NULL) AND (qualification IS NOT NULL) AND (inviter_reward = ANY (ARRAY[800, 840, 920, 1040, 1280, 1600])) AND (friend_reward = 800) AND (inviter_ledger_id <> friend_ledger_id)))),
  CONSTRAINT referral_credits_v9_friend_ledger_id_fkey FOREIGN KEY (friend_ledger_id) REFERENCES user_balance_ledger(id),
  CONSTRAINT referral_credits_v9_friend_ledger_id_key UNIQUE (friend_ledger_id),
  CONSTRAINT referral_credits_v9_invitee_user_id_fkey FOREIGN KEY (invitee_user_id) REFERENCES users(id),
  CONSTRAINT referral_credits_v9_invitee_user_id_key UNIQUE (invitee_user_id),
  CONSTRAINT referral_credits_v9_inviter_ledger_id_fkey FOREIGN KEY (inviter_ledger_id) REFERENCES user_balance_ledger(id),
  CONSTRAINT referral_credits_v9_inviter_ledger_id_key UNIQUE (inviter_ledger_id),
  CONSTRAINT referral_credits_v9_inviter_user_id_fkey FOREIGN KEY (inviter_user_id) REFERENCES users(id),
  CONSTRAINT referral_credits_v9_min_taps_check CHECK (((min_taps >= 1) AND (min_taps <= 1000000))),
  CONSTRAINT referral_credits_v9_pkey PRIMARY KEY (referral_id),
  CONSTRAINT referral_credits_v9_qualification_check CHECK ((qualification = ANY (ARRAY['join'::text, 'taps'::text, 'confirmed_ad'::text]))),
  CONSTRAINT referral_credits_v9_referral_id_fkey FOREIGN KEY (referral_id) REFERENCES referrals(id)
);

CREATE TABLE jigcoin_internal.referral_credits_v10 (
  referral_id bigint NOT NULL,
  inviter_user_id bigint NOT NULL,
  invitee_user_id bigint NOT NULL,
  activation_required boolean NOT NULL,
  min_taps integer NOT NULL,
  registered_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  awarded_at timestamp with time zone,
  referral_ordinal integer,
  inviter_reward integer,
  inviter_ledger_id bigint,
  qualification text,
  CONSTRAINT referral_credits_v10_check CHECK ((inviter_user_id <> invitee_user_id)),
  CONSTRAINT referral_credits_v10_check1 CHECK ((((awarded_at IS NULL) AND (referral_ordinal IS NULL) AND (inviter_reward IS NULL) AND (inviter_ledger_id IS NULL) AND (qualification IS NULL)) OR ((awarded_at IS NOT NULL) AND (referral_ordinal IS NOT NULL) AND (referral_ordinal > 0) AND (inviter_reward IS NOT NULL) AND (inviter_ledger_id IS NOT NULL) AND (qualification IS NOT NULL) AND (inviter_reward =
CASE
    WHEN (referral_ordinal >= 200) THEN 2000
    WHEN (referral_ordinal >= 50) THEN 1500
    WHEN (referral_ordinal >= 20) THEN 1250
    WHEN (referral_ordinal >= 5) THEN 1000
    ELSE 500
END)))),
  CONSTRAINT referral_credits_v10_invitee_user_id_fkey FOREIGN KEY (invitee_user_id) REFERENCES users(id),
  CONSTRAINT referral_credits_v10_invitee_user_id_key UNIQUE (invitee_user_id),
  CONSTRAINT referral_credits_v10_inviter_ledger_id_fkey FOREIGN KEY (inviter_ledger_id) REFERENCES user_balance_ledger(id),
  CONSTRAINT referral_credits_v10_inviter_ledger_id_key UNIQUE (inviter_ledger_id),
  CONSTRAINT referral_credits_v10_inviter_user_id_fkey FOREIGN KEY (inviter_user_id) REFERENCES users(id),
  CONSTRAINT referral_credits_v10_min_taps_check CHECK (((min_taps >= 1) AND (min_taps <= 1000000))),
  CONSTRAINT referral_credits_v10_pkey PRIMARY KEY (referral_id),
  CONSTRAINT referral_credits_v10_qualification_check CHECK ((qualification = ANY (ARRAY['join'::text, 'taps'::text, 'confirmed_ad'::text]))),
  CONSTRAINT referral_credits_v10_referral_id_fkey FOREIGN KEY (referral_id) REFERENCES referrals(id)
);

CREATE TABLE jigcoin_internal.tap_claims (
  user_id bigint NOT NULL,
  packet_id text NOT NULL,
  requested_count integer NOT NULL,
  applied integer NOT NULL,
  gained integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  vip_bonus bigint NOT NULL DEFAULT 0,
  CONSTRAINT tap_claims_check CHECK (((applied >= 0) AND (applied <= requested_count))),
  CONSTRAINT tap_claims_gained_check CHECK ((gained >= 0)),
  CONSTRAINT tap_claims_pkey PRIMARY KEY (user_id, packet_id),
  CONSTRAINT tap_claims_requested_count_check CHECK (((requested_count >= 1) AND (requested_count <= 100))),
  CONSTRAINT tap_claims_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT tap_claims_vip_bonus_check CHECK ((vip_bonus >= 0))
);

CREATE UNIQUE INDEX referrals_invited_unique ON public.referrals(invited_id);

CREATE TABLE public.referral_streaks(user_id bigint PRIMARY KEY REFERENCES public.users(id),streak_count integer,last_referral_at timestamptz,updated_at timestamptz);

CREATE TABLE public.sponsor_ledger(id bigserial PRIMARY KEY,user_id bigint REFERENCES public.users(id),event text,amount bigint,meta jsonb);

CREATE TABLE public.event_log(id bigserial PRIMARY KEY,user_id bigint REFERENCES public.users(id),event text,meta jsonb,created_at timestamptz DEFAULT clock_timestamp());

CREATE TABLE jigcoin_internal.ad_attempts(id bigserial PRIMARY KEY,user_id bigint REFERENCES public.users(id),eligible_at timestamptz,claimed_at timestamptz);

CREATE TABLE public.tap_packets(packet_id text PRIMARY KEY,telegram_id bigint NOT NULL);

CREATE TABLE jigcoin_internal.tap_fraction(user_id bigint PRIMARY KEY REFERENCES public.users(id),units integer NOT NULL);

CREATE TABLE jigcoin_internal.vip_tap_stats_v11(user_id bigint PRIMARY KEY REFERENCES public.users(id),bonus_coins bigint NOT NULL,fraction_units integer NOT NULL);

INSERT INTO jigcoin_internal.referral_migrations(version) VALUES('referral_credit_v9'),('referrals_welcome_v10');

CREATE OR REPLACE FUNCTION jigcoin_internal.award_welcome_v10()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE receipt bigint;
BEGIN
 IF NEW.is_system_user OR NEW.telegram_id<=0 THEN RETURN NEW; END IF;
 -- Only an AFTER INSERT trigger can call this function. The unique Telegram
 -- account and receipt constraints prevent concurrent/retry double awards.
 INSERT INTO public.user_balance_ledger(user_id,delta,reason,ref_type,ref_id,event_type)
 VALUES(NEW.id,1000,'welcome_bonus','welcome_v10',NEW.id,'bonus') RETURNING id INTO receipt;
 UPDATE public.users SET balance=COALESCE(balance,0)+1000 WHERE id=NEW.id;
 INSERT INTO jigcoin_internal.welcome_credits_v10(user_id,telegram_id,amount,ledger_id)
 VALUES(NEW.id,NEW.telegram_id,1000,receipt);
 INSERT INTO public.event_log(user_id,event,meta)
 VALUES(NEW.id,'welcome_bonus',jsonb_build_object('version','referrals_welcome_v10','amount',1000,'ledger_id',receipt));
 RETURN NEW;
END $function$
;



CREATE TRIGGER users_award_welcome_v10 AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION jigcoin_internal.award_welcome_v10();
