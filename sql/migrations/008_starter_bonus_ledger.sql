-- Correct NEW starter awards only. No historical balance or ledger backfill.
-- Preserve the established 5,000-coin bonus for the first 1,000 awards.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.award_early_access_starter_bonus(bigint)')
   AND md5(replace(prosrc,chr(13),'')) IN ('c57e444b526a41f235af8bc374e3a9b3','42879110c28ee2fee5ac8e61aadf6f25')) THEN
   RAISE EXCEPTION 'Starter function differs from reviewed version; no changes applied'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='users_award_early_access' AND tgenabled='O') THEN
   RAISE EXCEPTION 'Expected starter trigger is not enabled'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.award_early_access_starter_bonus(p_user_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $starter$
DECLARE credited_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('early_access_starter_bonus_lock'));
  IF EXISTS(SELECT 1 FROM public.event_log WHERE user_id=p_user_id AND event='early_access_starter_bonus') THEN RETURN; END IF;
  SELECT count(*) INTO credited_count FROM public.event_log WHERE event='early_access_starter_bonus';
  IF credited_count>=1000 THEN RETURN; END IF;
  PERFORM 1 FROM public.users WHERE id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Starter account not found'; END IF;
  INSERT INTO public.user_balance_ledger(user_id,delta,reason,ref_type,ref_id,event_type)
    VALUES(p_user_id,5000,'early_access_starter_bonus','early_access',credited_count+1,'bonus');
  UPDATE public.users SET balance=balance+5000 WHERE id=p_user_id;
  INSERT INTO public.event_log(user_id,event,meta,created_at) VALUES
    (p_user_id,'early_access_starter_bonus',jsonb_build_object('amount',5000,'reason','db_trigger','rank',credited_count+1),now());
END;
$starter$;
REVOKE ALL ON FUNCTION public.award_early_access_starter_bonus(bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.award_early_access_starter_bonus(bigint) TO service_role;
COMMIT;
SELECT 'Starter bonus remains 5000 once, with a matching ledger entry for new awards' AS result;
