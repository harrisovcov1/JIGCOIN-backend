-- Read-only, single-statement verification for Supabase rvglsktxkorvasdxjcpg.
-- Run as the database administrator immediately AFTER these exact migrations:
--   20261119172826_referral_cumulative_activation.sql
--   20261119172851_weekly_daily_runs_and_awards.sql
-- It neither invokes application functions nor starts runs, grants rewards,
-- changes balances, finalizes races, or writes any data. A missing relation or
-- column can fail parsing: treat that as an incomplete migration, not a pass.
-- Accept only blocking_findings=[]; review warnings before deploying the server.
-- The live preflight at 2026-11-19 18:01:03.623565 UTC found 3 completed ranked
-- runs, 0 active runs, 0 historic weeks/medals, 19 referrals, and 0 v9/v10/welcome
-- credits. New requests during a rolling deploy may increase counts. The strict
-- request-key and rank-finish backfill checks therefore cover the known baseline;
-- newer legacy-server inserts without these optional snapshots are warnings.
-- Separately re-run Supabase security advisors: baseline 31 mutable-search-path
-- WARN / 85 private-RLS-no-policy INFO / 0 ERROR; six new private tables can make
-- INFO=91. No additional mutable-search-path warning or browser access is expected.
WITH
baseline AS (
  SELECT timestamptz '2026-11-19 18:01:03.623565+00' AS observed_at,
    date '2026-11-16' AS legacy_cutoff, timestamptz '2026-11-23 00:00:00+00' AS daily_cutover
),
table_manifest(tbl, required_privileges, forbidden_privileges, pks, uniques, fks, checks) AS (
  VALUES
    ('referral_credits_v16',ARRAY['SELECT','INSERT','UPDATE'],ARRAY['DELETE','TRUNCATE','REFERENCES','TRIGGER'],1,2,4,6),
    ('weekly_run_requests_v16',ARRAY['SELECT','INSERT'],ARRAY['UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'],1,0,2,0),
    ('weekly_practice_runs_v16',ARRAY['SELECT','INSERT','UPDATE'],ARRAY['DELETE','TRUNCATE','REFERENCES','TRIGGER'],1,1,1,4),
    ('weekly_finalizations_v16',ARRAY['SELECT','INSERT'],ARRAY['UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'],1,0,0,4),
    ('weekly_awards_v16',ARRAY['SELECT','INSERT'],ARRAY['UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'],1,0,2,3),
    ('weekly_upgrade_v16',ARRAY['SELECT'],ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'],1,0,0,1)
),
tables AS (
  SELECT m.*, c.oid, c.relrowsecurity, c.relkind
  FROM table_manifest m
  LEFT JOIN pg_class c ON c.oid=to_regclass('jigcoin_internal.'||m.tbl)
),
column_manifest(tbl,col,typ,nn) AS (
  VALUES
    ('referral_credits_v16','referral_id','bigint',true),
    ('referral_credits_v16','inviter_user_id','bigint',true),
    ('referral_credits_v16','invitee_user_id','bigint',true),
    ('referral_credits_v16','policy_version','text',true),
    ('referral_credits_v16','min_taps','integer',true),
    ('referral_credits_v16','registered_at','timestamp with time zone',true),
    ('referral_credits_v16','verified_taps','integer',true),
    ('referral_credits_v16','qualified_at','timestamp with time zone',false),
    ('referral_credits_v16','awarded_at','timestamp with time zone',false),
    ('referral_credits_v16','referral_ordinal','integer',false),
    ('referral_credits_v16','inviter_reward','integer',false),
    ('referral_credits_v16','inviter_ledger_id','bigint',false),
    ('weekly_runs_v14','allowance_day','date',true),
    ('weekly_runs_v14','policy_version','text',true),
    ('weekly_runs_v14','puzzle_version','text',true),
    ('weekly_runs_v14','vip_active_at_start','boolean',false),
    ('weekly_runs_v14','rank_finish_key','text',false),
    ('weekly_run_requests_v16','user_id','bigint',true),
    ('weekly_run_requests_v16','request_key','uuid',true),
    ('weekly_run_requests_v16','run_id','uuid',true),
    ('weekly_practice_runs_v16','user_id','bigint',true),
    ('weekly_practice_runs_v16','id','uuid',true),
    ('weekly_practice_runs_v16','request_key','uuid',true),
    ('weekly_practice_runs_v16','request_keys','uuid[]',true),
    ('weekly_practice_runs_v16','seed','text',true),
    ('weekly_practice_runs_v16','starts_at','timestamp with time zone',true),
    ('weekly_practice_runs_v16','ends_at','timestamp with time zone',true),
    ('weekly_practice_runs_v16','turn','integer',true),
    ('weekly_practice_runs_v16','score','integer',true),
    ('weekly_finalizations_v16','week','date',true),
    ('weekly_finalizations_v16','finalized_at','timestamp with time zone',true),
    ('weekly_finalizations_v16','participants','integer',true),
    ('weekly_finalizations_v16','winning_score','integer',true),
    ('weekly_finalizations_v16','policy_version','text',true),
    ('weekly_finalizations_v16','source','text',true),
    ('weekly_awards_v16','week','date',true),
    ('weekly_awards_v16','user_id','bigint',true),
    ('weekly_awards_v16','score','integer',true),
    ('weekly_awards_v16','place','smallint',true),
    ('weekly_awards_v16','awarded_at','timestamp with time zone',true),
    ('weekly_awards_v16','player_name','text',true),
    ('weekly_awards_v16','finish_key','text',false),
    ('weekly_awards_v16','vip_active','boolean',false),
    ('weekly_awards_v16','rank_finish_key','text',false),
    ('weekly_upgrade_v16','id','boolean',true),
    ('weekly_upgrade_v16','legacy_before_week','date',true)
),
default_manifest(tbl,col,expr) AS (
  VALUES ('referral_credits_v16','policy_version','''referrals_cumulative_v16''::text'),
    ('referral_credits_v16','min_taps','100'),
    ('referral_credits_v16','registered_at','clock_timestamp()'),
    ('referral_credits_v16','verified_taps','0'),
    ('weekly_runs_v14','policy_version','''weekly-v14''::text'),
    ('weekly_runs_v14','puzzle_version','''weekly-v14''::text'),
    ('weekly_practice_runs_v16','turn','0'),('weekly_practice_runs_v16','score','0'),
    ('weekly_awards_v16','place','1'),('weekly_upgrade_v16','id','true')
),
columns_actual AS (
  SELECT m.*, a.attnum, format_type(a.atttypid,a.atttypmod) AS actual_type,
    a.attnotnull, pg_get_expr(d.adbin,d.adrelid) AS actual_default
  FROM column_manifest m
  LEFT JOIN pg_attribute a ON a.attrelid=to_regclass('jigcoin_internal.'||m.tbl)
    AND a.attname=m.col AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
),
constraints_actual AS (
  SELECT c.*, t.relname AS tbl,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,ord)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.ord) AS cols,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,ord)
      JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.ord) AS target_cols,
    regexp_replace(lower(pg_get_constraintdef(c.oid,true)),'[[:space:]()]','','g') AS compact_def
  FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
  WHERE c.conrelid IN (SELECT oid FROM tables)
    OR c.conrelid=to_regclass('jigcoin_internal.weekly_runs_v14')
),
key_manifest(tbl,kind,cols,target,target_cols) AS (
  VALUES
    ('referral_credits_v16','p',ARRAY['referral_id'],NULL::text,NULL::text[]),
    ('referral_credits_v16','u',ARRAY['invitee_user_id'],NULL,NULL),
    ('referral_credits_v16','u',ARRAY['inviter_ledger_id'],NULL,NULL),
    ('referral_credits_v16','f',ARRAY['referral_id'],'public.referrals',ARRAY['id']),
    ('referral_credits_v16','f',ARRAY['inviter_user_id'],'public.users',ARRAY['id']),
    ('referral_credits_v16','f',ARRAY['invitee_user_id'],'public.users',ARRAY['id']),
    ('referral_credits_v16','f',ARRAY['inviter_ledger_id'],'public.user_balance_ledger',ARRAY['id']),
    ('weekly_run_requests_v16','p',ARRAY['user_id','request_key'],NULL,NULL),
    ('weekly_run_requests_v16','f',ARRAY['user_id'],'public.users',ARRAY['id']),
    ('weekly_run_requests_v16','f',ARRAY['run_id'],'jigcoin_internal.weekly_runs_v14',ARRAY['id']),
    ('weekly_practice_runs_v16','p',ARRAY['user_id'],NULL,NULL),
    ('weekly_practice_runs_v16','u',ARRAY['id'],NULL,NULL),
    ('weekly_practice_runs_v16','f',ARRAY['user_id'],'public.users',ARRAY['id']),
    ('weekly_finalizations_v16','p',ARRAY['week'],NULL,NULL),
    ('weekly_awards_v16','p',ARRAY['week','user_id'],NULL,NULL),
    ('weekly_awards_v16','f',ARRAY['week'],'jigcoin_internal.weekly_finalizations_v16',ARRAY['week']),
    ('weekly_awards_v16','f',ARRAY['user_id'],'public.users',ARRAY['id']),
    ('weekly_upgrade_v16','p',ARRAY['id'],NULL,NULL),
    ('weekly_runs_v14','p',ARRAY['id'],NULL,NULL),
    ('weekly_runs_v14','u',ARRAY['user_id','request_key'],NULL,NULL),
    ('weekly_runs_v14','f',ARRAY['week','user_id'],'jigcoin_internal.weekly_racers_v14',ARRAY['week','user_id'])
),
-- Constraint counts plus these expression tokens check the actual bounds and
-- contract shape, independently of automatically generated constraint names.
check_manifest(tbl,label,tokens) AS (
  VALUES
    ('referral_credits_v16','policy',ARRAY['policy_version=','''referrals_cumulative_v16''']),
    ('referral_credits_v16','minimum',ARRAY['min_taps=100']),
    ('referral_credits_v16','progress bounds',ARRAY['verified_taps>=0','verified_taps<=100']),
    ('referral_credits_v16','distinct players',ARRAY['inviter_user_id<>invitee_user_id']),
    ('referral_credits_v16','qualification contract',ARRAY['qualified_atisnull','verified_taps<min_taps','qualified_atisnotnull','verified_taps=min_taps']),
    ('referral_credits_v16','award contract',ARRAY['awarded_atisnull','referral_ordinalisnull','inviter_rewardisnull','inviter_ledger_idisnull','awarded_atisnotnull','qualified_atisnotnull','referral_ordinal>0','inviter_ledger_idisnotnull','inviter_reward=case','referral_ordinal>=200then2000','referral_ordinal>=50then1500','referral_ordinal>=20then1250','referral_ordinal>=5then1000','else500end']),
    ('weekly_runs_v14','quota policy',ARRAY['policy_version','''weekly-v14''','''daily-v16''']),
    ('weekly_runs_v14','puzzle provenance',ARRAY['puzzle_version','''weekly-v14''','''daily-v16''']),
    ('weekly_runs_v14','rank finish',ARRAY['rank_finish_key~','''^rank-[0-7]$''']),
    ('weekly_runs_v14','duration',ARRAY['ends_at>starts_at']),
    ('weekly_runs_v14','slot bounds',ARRAY['slot>=1','slot<=3']),
    ('weekly_runs_v14','turn bounds',ARRAY['turn>=0']),
    ('weekly_runs_v14','score bounds',ARRAY['score>=0','score<=turn']),
    ('weekly_runs_v14','legacy appearance',ARRAY['finish_key','''rank-0''','''rank-7''','''launch''','''midnight''']),
    ('weekly_practice_runs_v16','retry bound',ARRAY['cardinalityrequest_keys>=1','cardinalityrequest_keys<=16']),
    ('weekly_practice_runs_v16','duration',ARRAY['ends_at>starts_at']),
    ('weekly_practice_runs_v16','turn bounds',ARRAY['turn>=0']),
    ('weekly_practice_runs_v16','score bounds',ARRAY['score>=0','score<=turn']),
    ('weekly_finalizations_v16','participants',ARRAY['participants>=0']),
    ('weekly_finalizations_v16','winning score',ARRAY['winning_score>=0']),
    ('weekly_finalizations_v16','policy',ARRAY['policy_version','''weekly-v14''','''daily-v16''']),
    ('weekly_finalizations_v16','source',ARRAY['source','''legacy_import''','''server''']),
    ('weekly_awards_v16','positive score',ARRAY['score>0']),
    ('weekly_awards_v16','gold place',ARRAY['place=1']),
    ('weekly_awards_v16','rank finish',ARRAY['rank_finish_key~','''^rank-[0-7]$''']),
    ('weekly_upgrade_v16','singleton',ARRAY['checkid'])
),
index_manifest(idx,tbl,uq,keys,includes,descending,predicate) AS (
  VALUES
    ('jigcoin_internal.referral_credits_v16_inviter_recent','jigcoin_internal.referral_credits_v16',false,ARRAY['inviter_user_id','registered_at'],ARRAY[]::text[],ARRAY[false,true],''),
    ('jigcoin_internal.tap_claims_positive_referral_v16','jigcoin_internal.tap_claims',false,ARRAY['user_id'],ARRAY['applied'],ARRAY[false],'applied>0'),
    ('public.referrals_inviter_recent_v16','public.referrals',false,ARRAY['inviter_id','created_at','id'],ARRAY[]::text[],ARRAY[false,true,true],''),
    ('jigcoin_internal.weekly_legacy_slots_v16','jigcoin_internal.weekly_runs_v14',true,ARRAY['week','user_id','slot'],ARRAY[]::text[],ARRAY[false,false,false],'policy_version=''weekly-v14''::text'),
    ('jigcoin_internal.weekly_daily_slots_v16','jigcoin_internal.weekly_runs_v14',true,ARRAY['user_id','allowance_day','slot'],ARRAY[]::text[],ARRAY[false,false,false],'policy_version=''daily-v16''::text'),
    ('jigcoin_internal.weekly_latest_runs_v16','jigcoin_internal.weekly_runs_v14',false,ARRAY['user_id','starts_at','id'],ARRAY[]::text[],ARRAY[false,true,false],''),
    ('jigcoin_internal.weekly_request_run_v16','jigcoin_internal.weekly_run_requests_v16',false,ARRAY['run_id'],ARRAY[]::text[],ARRAY[false],''),
    ('jigcoin_internal.weekly_award_history_v16','jigcoin_internal.weekly_awards_v16',false,ARRAY['user_id','week'],ARRAY[]::text[],ARRAY[false,true],'')
),
indexes_actual AS (
  SELECT m.*, i.indrelid,i.indisvalid,i.indisready,i.indisunique,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n,ord)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.n
      WHERE k.ord<=i.indnkeyatts ORDER BY k.ord) AS actual_keys,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n,ord)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.n
      WHERE k.ord>i.indnkeyatts ORDER BY k.ord) AS actual_includes,
    ARRAY(SELECT (o&1)=1 FROM unnest(i.indoption) WITH ORDINALITY x(o,ord) ORDER BY ord) AS actual_descending,
    regexp_replace(coalesce(pg_get_expr(i.indpred,i.indrelid,true),''),'[[:space:]()]','','g') AS actual_predicate
  FROM index_manifest m LEFT JOIN pg_index i ON i.indexrelid=to_regclass(m.idx)
),
function_manifest(fn,body_md5) AS (
  VALUES ('jigcoin_internal.weekly_run_start_fields_v16()','2bb8869c5ec8b272c27fab84d050d94a'),
    ('jigcoin_internal.reject_weekly_history_change_v16()','ded07c955e499b6676c46949e49fec47')
),
functions_actual AS (
  SELECT m.*,p.oid,p.prosecdef,p.proconfig,p.prorettype,p.prosrc,l.lanname
  FROM function_manifest m LEFT JOIN pg_proc p ON p.oid=to_regprocedure(m.fn)
  LEFT JOIN pg_language l ON l.oid=p.prolang
),
trigger_manifest(tbl,trg,fn,flags) AS (
  VALUES ('weekly_runs_v14','weekly_run_start_fields_v16','jigcoin_internal.weekly_run_start_fields_v16()',7),
    ('weekly_finalizations_v16','weekly_history_immutable_v16','jigcoin_internal.reject_weekly_history_change_v16()',27),
    ('weekly_awards_v16','weekly_awards_immutable_v16','jigcoin_internal.reject_weekly_history_change_v16()',27)
),
run_backfills AS (
  SELECT count(*) AS runs,
    count(*) FILTER(WHERE r.starts_at<=b.observed_at) AS baseline_runs,
    count(*) FILTER(WHERE r.allowance_day IS DISTINCT FROM (r.starts_at AT TIME ZONE 'UTC')::date) AS wrong_allowance_day,
    count(*) FILTER(WHERE r.policy_version IS DISTINCT FROM CASE WHEN r.starts_at>=b.daily_cutover THEN 'daily-v16' ELSE 'weekly-v14' END) AS wrong_policy,
    count(*) FILTER(WHERE r.week IS DISTINCT FROM date_trunc('week',r.starts_at AT TIME ZONE 'UTC')::date) AS wrong_week,
    count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM jigcoin_internal.weekly_run_requests_v16 q WHERE q.user_id=r.user_id AND q.request_key=r.request_key AND q.run_id=r.id) AND r.starts_at<=b.observed_at) AS baseline_missing_request_keys,
    count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM jigcoin_internal.weekly_run_requests_v16 q WHERE q.user_id=r.user_id AND q.request_key=r.request_key AND q.run_id=r.id) AND r.starts_at>b.observed_at) AS newer_missing_request_keys,
    count(*) FILTER(WHERE r.finish_key ~ '^rank-[0-7]$' AND r.rank_finish_key IS DISTINCT FROM r.finish_key AND r.starts_at<=b.observed_at) AS baseline_wrong_rank_finish,
    count(*) FILTER(WHERE r.finish_key ~ '^rank-[0-7]$' AND r.rank_finish_key IS DISTINCT FROM r.finish_key AND r.starts_at>b.observed_at) AS newer_wrong_rank_finish,
    count(*) FILTER(WHERE r.starts_at<=b.observed_at AND r.vip_active_at_start IS NOT NULL) AS legacy_vip_inferred
  FROM jigcoin_internal.weekly_runs_v14 r CROSS JOIN baseline b
),
legacy_weeks AS (
  SELECT r.week,count(*) FILTER(WHERE r.best>0)::integer AS participants,coalesce(max(r.best),0) AS winning_score
  FROM jigcoin_internal.weekly_racers_v14 r
  WHERE r.week<(SELECT legacy_before_week FROM jigcoin_internal.weekly_upgrade_v16 WHERE id)
  GROUP BY r.week
),
legacy_expected_awards AS (
  SELECT r.week,r.user_id,r.best AS score
  FROM legacy_weeks w JOIN jigcoin_internal.weekly_racers_v14 r
    ON r.week=w.week AND r.best=w.winning_score AND r.best>0
),
legacy_actual_awards AS (
  SELECT a.week,a.user_id,a.score FROM jigcoin_internal.weekly_awards_v16 a
  JOIN jigcoin_internal.weekly_finalizations_v16 f ON f.week=a.week
  WHERE f.source='legacy_import'
),
legacy_audit AS (
  SELECT (SELECT count(*) FROM legacy_weeks) AS expected_weeks,
    (SELECT count(*) FROM jigcoin_internal.weekly_finalizations_v16 WHERE source='legacy_import') AS imported_weeks,
    (SELECT count(*) FROM legacy_expected_awards) AS expected_awards,
    (SELECT count(*) FROM legacy_actual_awards) AS imported_awards,
    (SELECT count(*) FROM legacy_weeks w FULL JOIN
      (SELECT * FROM jigcoin_internal.weekly_finalizations_v16 WHERE source='legacy_import') f ON f.week=w.week
      WHERE w.week IS NULL OR f.week IS NULL OR w.participants IS DISTINCT FROM f.participants
        OR w.winning_score IS DISTINCT FROM f.winning_score OR f.policy_version IS DISTINCT FROM 'weekly-v14') AS incorrect_weeks,
    (SELECT count(*) FROM ((SELECT * FROM legacy_expected_awards EXCEPT SELECT * FROM legacy_actual_awards)
      UNION ALL (SELECT * FROM legacy_actual_awards EXCEPT SELECT * FROM legacy_expected_awards)) d) AS award_set_difference
),
retained_referrals AS (
  SELECT (SELECT count(*) FROM public.referrals) AS referrals,
    (SELECT count(*) FROM jigcoin_internal.referral_credits_v9) AS v9_contracts,
    (SELECT count(*) FROM jigcoin_internal.referral_credits_v10) AS v10_contracts,
    (SELECT count(*) FROM jigcoin_internal.welcome_credits_v10) AS welcome_credits,
    (SELECT count(*) FROM jigcoin_internal.referral_credits_v16) AS v16_contracts,
    (SELECT jsonb_agg(version ORDER BY version) FROM jigcoin_internal.referral_migrations) AS markers
),
checks(label,severity,passed,detail) AS (
  SELECT 'table private: '||tbl,'BLOCK',oid IS NOT NULL AND relkind='r' AND relrowsecurity
    AND NOT has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_any_column_privilege('anon',oid,'SELECT,INSERT,UPDATE,REFERENCES')
    AND NOT has_any_column_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,REFERENCES'),
    jsonb_build_object('exists',oid IS NOT NULL,'rls',relrowsecurity) FROM tables
  UNION ALL SELECT 'service grants: '||tbl,'BLOCK',
    NOT EXISTS(SELECT 1 FROM unnest(required_privileges) p WHERE NOT has_table_privilege('service_role',oid,p))
    AND NOT EXISTS(SELECT 1 FROM unnest(forbidden_privileges) p WHERE has_table_privilege('service_role',oid,p)),
    jsonb_build_object('required',required_privileges,'forbidden',forbidden_privileges,
      'actual',ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('service_role',oid,p))) FROM tables
  UNION ALL SELECT 'private schema usage','BLOCK',
    NOT has_schema_privilege('anon','jigcoin_internal','USAGE')
    AND NOT has_schema_privilege('authenticated','jigcoin_internal','USAGE')
    AND has_schema_privilege('service_role','jigcoin_internal','USAGE'),'{}'::jsonb
  UNION ALL SELECT 'column: '||tbl||'.'||col,'BLOCK',attnum IS NOT NULL AND actual_type=typ AND attnotnull=nn,
    jsonb_build_object('expected_type',typ,'type',actual_type,'expected_not_null',nn,'not_null',attnotnull) FROM columns_actual
  UNION ALL SELECT 'default: '||a.tbl||'.'||a.col,'BLOCK',a.actual_default IS NOT DISTINCT FROM m.expr,
    jsonb_build_object('expected',m.expr,'actual',a.actual_default)
    FROM columns_actual a LEFT JOIN default_manifest m USING(tbl,col)
  UNION ALL SELECT 'constraint totals: '||t.tbl,'BLOCK',
    (SELECT count(*) FROM constraints_actual c WHERE c.tbl=t.tbl AND c.contype='p')=t.pks
    AND (SELECT count(*) FROM constraints_actual c WHERE c.tbl=t.tbl AND c.contype='u')=t.uniques
    AND (SELECT count(*) FROM constraints_actual c WHERE c.tbl=t.tbl AND c.contype='f')=t.fks
    AND (SELECT count(*) FROM constraints_actual c WHERE c.tbl=t.tbl AND c.contype='c')=t.checks
    AND NOT EXISTS(SELECT 1 FROM constraints_actual c WHERE c.tbl=t.tbl AND (NOT c.convalidated OR c.condeferrable)),
    jsonb_build_object('expected_pk',t.pks,'expected_unique',t.uniques,'expected_fk',t.fks,'expected_check',t.checks)
    FROM tables t
  UNION ALL SELECT 'key: '||m.tbl||' '||m.kind||' '||array_to_string(m.cols,','),'BLOCK',
    EXISTS(SELECT 1 FROM constraints_actual c WHERE c.tbl=m.tbl AND c.contype::text=m.kind AND c.cols=m.cols
      AND c.convalidated AND NOT c.condeferrable
      AND (m.kind<>'f' OR (c.confrelid=to_regclass(m.target) AND c.target_cols=m.target_cols AND c.confupdtype='a' AND c.confdeltype='a'))),
    jsonb_build_object('target',m.target,'target_columns',m.target_cols) FROM key_manifest m
  UNION ALL SELECT 'check: '||m.tbl||' '||m.label,'BLOCK',
    EXISTS(SELECT 1 FROM constraints_actual c WHERE c.tbl=m.tbl AND c.contype='c' AND c.convalidated
      AND NOT EXISTS(SELECT 1 FROM unnest(m.tokens) token WHERE strpos(c.compact_def,token)=0)),
    jsonb_build_object('required_tokens',m.tokens) FROM check_manifest m
  UNION ALL SELECT 'legacy weekly unique replaced','BLOCK',
    NOT EXISTS(SELECT 1 FROM constraints_actual c WHERE c.tbl='weekly_runs_v14' AND c.contype='u' AND c.cols=ARRAY['week','user_id','slot'])
    AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid='jigcoin_internal.weekly_runs_v14'::regclass
      AND i.indisunique AND i.indpred IS NULL AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n,ord)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.n WHERE k.ord<=i.indnkeyatts ORDER BY k.ord)=ARRAY['week','user_id','slot']),
    '{}'::jsonb
  UNION ALL SELECT 'index: '||idx,'BLOCK',indrelid=to_regclass(tbl) AND indisvalid AND indisready AND indisunique=uq
    AND actual_keys=keys AND actual_includes=includes AND actual_descending=descending AND actual_predicate=predicate,
    jsonb_build_object('keys',actual_keys,'includes',actual_includes,'descending',actual_descending,'predicate',actual_predicate,'valid',indisvalid) FROM indexes_actual
  UNION ALL SELECT 'function: '||fn,'BLOCK',oid IS NOT NULL AND NOT prosecdef AND lanname='plpgsql'
    AND prorettype='trigger'::regtype AND proconfig=ARRAY['search_path=pg_catalog']
    AND md5(regexp_replace(prosrc,'[[:space:]]+','','g'))=body_md5
    AND NOT has_function_privilege('anon',oid,'EXECUTE')
    AND NOT has_function_privilege('authenticated',oid,'EXECUTE'),
    jsonb_build_object('security_definer',prosecdef,'config',proconfig,'body_matches',md5(regexp_replace(prosrc,'[[:space:]]+','','g'))=body_md5) FROM functions_actual
  UNION ALL SELECT 'trigger: '||m.trg,'BLOCK',
    EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('jigcoin_internal.'||m.tbl)
      AND t.tgname=m.trg AND t.tgfoid=to_regprocedure(m.fn) AND t.tgtype=m.flags
      AND t.tgenabled='O' AND NOT t.tgisinternal),'{}'::jsonb FROM trigger_manifest m
  UNION ALL SELECT 'known run backfills and quota dates','BLOCK',baseline_runs>=3 AND wrong_allowance_day=0
    AND wrong_policy=0 AND wrong_week=0 AND baseline_missing_request_keys=0
    AND baseline_wrong_rank_finish=0 AND legacy_vip_inferred=0,to_jsonb(r) FROM run_backfills r
  UNION ALL SELECT 'newer legacy inserts need review','WARN',newer_missing_request_keys=0 AND newer_wrong_rank_finish=0,to_jsonb(r) FROM run_backfills r
  UNION ALL SELECT 'request aliases belong to run owner','BLOCK',
    NOT EXISTS(SELECT 1 FROM jigcoin_internal.weekly_run_requests_v16 q JOIN jigcoin_internal.weekly_runs_v14 r ON r.id=q.run_id WHERE q.user_id<>r.user_id),'{}'::jsonb
  UNION ALL SELECT 'one-time legacy cutoff','BLOCK',
    (SELECT count(*)=1 AND bool_and(id AND legacy_before_week=(SELECT legacy_cutoff FROM baseline)) FROM jigcoin_internal.weekly_upgrade_v16),
    (SELECT coalesce(jsonb_agg(to_jsonb(u)),'[]'::jsonb) FROM jigcoin_internal.weekly_upgrade_v16 u)
  UNION ALL SELECT 'historical medals preserved','BLOCK',incorrect_weeks=0 AND award_set_difference=0,to_jsonb(a) FROM legacy_audit a
  UNION ALL SELECT 'legacy referral contracts retained','BLOCK',r.referrals>=19
    AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['referral_credit_v9','referrals_welcome_v10','referrals_cumulative_v16']) v
      WHERE NOT EXISTS(SELECT 1 FROM jigcoin_internal.referral_migrations m WHERE m.version=v)),to_jsonb(r) FROM retained_referrals r
  UNION ALL SELECT 'legacy referral private: '||name,'BLOCK',
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('jigcoin_internal.'||name) AND c.relrowsecurity)
    AND NOT has_table_privilege('anon',to_regclass('jigcoin_internal.'||name),'SELECT,INSERT,UPDATE,DELETE')
    AND NOT has_table_privilege('authenticated',to_regclass('jigcoin_internal.'||name),'SELECT,INSERT,UPDATE,DELETE'),
    '{}'::jsonb FROM unnest(ARRAY['referral_credits_v9','referral_credits_v10','welcome_credits_v10','referral_migrations','tap_claims']) name
)
SELECT jsonb_build_object(
  'checked_at',clock_timestamp(),
  'baseline_at',(SELECT observed_at FROM baseline),
  'passed',count(*) FILTER(WHERE passed IS TRUE),
  'total_checks',count(*),
  'ready',count(*) FILTER(WHERE severity='BLOCK' AND passed IS NOT TRUE)=0,
  'blocking_findings',coalesce(jsonb_agg(jsonb_build_object('check',label,'detail',detail) ORDER BY label)
    FILTER(WHERE severity='BLOCK' AND passed IS NOT TRUE),'[]'::jsonb),
  'warnings',coalesce(jsonb_agg(jsonb_build_object('check',label,'detail',detail) ORDER BY label)
    FILTER(WHERE severity='WARN' AND passed IS NOT TRUE),'[]'::jsonb),
  'run_backfills',(SELECT to_jsonb(r) FROM run_backfills r),
  'historical_import',(SELECT to_jsonb(a) FROM legacy_audit a),
  'retained_referrals',(SELECT to_jsonb(r) FROM retained_referrals r)
) AS integrated_v16_verification
FROM checks;
