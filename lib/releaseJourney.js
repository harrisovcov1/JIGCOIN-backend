'use strict';
const {ids}=require('./releaseAccess');
const fail=(code,status=409)=>Object.assign(Error(code),{code,status});
const sourceFrom=value=>{
 const s=typeof value==='string'?value:'';
 const m=/^(?:ref_[1-9]\d{0,15}__)?src_([a-z0-9][a-z0-9_-]{0,39})$/.exec(s);
 if(m && /^duel_[a-f0-9]{32}$/.test(m[1]))return 'weekly_result';
 if(m && /^race_[a-f0-9]{20}$/.test(m[1]))return 'weekly_race';
 return m?m[1]:/^ref_[1-9]\d{0,15}$/.test(s)?'referral':'organic';
};
function createReleaseJourney({pool,withTransaction,env=process.env}) {
 const tests=ids(env.ANALYTICS_TEST_TELEGRAM_IDS);
 const excluded=u=>!!u.is_system_user||tests.has(String(u.telegram_id))||String(u.telegram_id)===String(env.RECOVERY_TEST_TELEGRAM_ID);
 async function assertReady(){
  if(!(await pool.query("SELECT 1 FROM jigcoin_internal.release_config_v13 WHERE version='release_v13'")).rows.length)throw fail('INSTALL_RELEASE_V13_MIGRATION',503);
 }
 async function registerTx(c,user,param){
  await c.query(`INSERT INTO jigcoin_internal.acquisition_v13(user_id,source,is_new,excluded)
   VALUES($1,$2,TRUE,$3) ON CONFLICT DO NOTHING`,[user.id,sourceFrom(param),excluded(user)]);
 }
 // Caller owns the user row lock, shared with taps, daily claims and purchases.
 async function touchTx(c,user,kind='open',accepted=0){
  if(!['open','tap','daily','ad'].includes(kind)||!Number.isSafeInteger(accepted)||accepted<0)throw fail('INVALID_JOURNEY_EVENT');
  if(kind==='tap'&&!accepted)return;
  const acquisition = await c.query(`INSERT INTO jigcoin_internal.acquisition_v13(user_id,source,is_new,excluded)
   VALUES($1,'existing',FALSE,$2) ON CONFLICT(user_id) DO UPDATE
   SET excluded=acquisition_v13.excluded OR EXCLUDED.excluded RETURNING is_new`,[user.id,excluded(user)]);
  await c.query(`INSERT INTO jigcoin_internal.journey_v13(user_id) VALUES($1) ON CONFLICT DO NOTHING`,[user.id]);
  const j=(await c.query('SELECT *,clock_timestamp() AS db_now FROM jigcoin_internal.journey_v13 WHERE user_id=$1 FOR UPDATE',[user.id])).rows[0];
  const now=new Date(j.db_now),first=j.first_open_at?new Date(j.first_open_at):now;
  let sessions=j.sessions||0,start=j.session_started_at?new Date(j.session_started_at):now;
  if(!j.first_open_at||now-new Date(j.last_seen_at)>30*60000||now-start>=4*3600000){sessions++;start=now;}
  const firstTaps=Number(j.first_session_taps)+(sessions===1&&kind==='tap'?accepted:0);
  const firstDaily=j.first_session_daily||(sessions===1&&kind==='daily');
  const active=kind!=='open',age=now-first;
  const returned=(old,lo,hi)=>old||(active&&age>=lo*3600000&&age<hi*3600000?now:null);
  await c.query(`UPDATE jigcoin_internal.journey_v13 SET
   first_open_at=$2,last_seen_at=$3,session_started_at=$4,sessions=$5,
   accepted_taps=accepted_taps+$6,first_session_taps=$7,first_session_daily=$8,
   daily_claimed_at=COALESCE(daily_claimed_at,$9),activated_at=COALESCE(activated_at,$10),
   d1_return_at=$11,d7_return_at=$12,d30_return_at=$13 WHERE user_id=$1`,
  [user.id,first,now,start,sessions,kind==='tap'?accepted:0,firstTaps,firstDaily,
   kind==='daily'?now:null,sessions===1&&firstTaps>=20&&firstDaily?now:null,
   returned(j.d1_return_at,24,48),returned(j.d7_return_at,168,192),returned(j.d30_return_at,720,744)]);
  // Inspection and recording happen under the same user lock on every device.
  return kind === 'open' && acquisition.rows[0].is_new && !j.first_open_at && user.has_completed_onboarding !== true;
 }
 async function open(identity){
  return withTransaction(async c=>{
   const u=(await c.query('SELECT * FROM public.users WHERE id=$1 FOR UPDATE',[identity.id])).rows[0];
   if(!u)throw fail('ACCOUNT_UNAVAILABLE',404);
   const firstVisitHint = await touchTx(c,u);
   return {...u, first_visit_hint:firstVisitHint};
  });
 }
 function progress(u,j={}){
  const taps=Number(j.accepted_taps||0);
  const daily=!!(j.daily_claimed_at||u.last_checkin_at||u.last_daily||u.last_checkin_date);
  return {accepted_taps:taps,target_taps:20,daily_claimed:daily,ready:taps>=20&&daily};
 }
 async function status(u){
  const j=await pool.query('SELECT accepted_taps,daily_claimed_at FROM jigcoin_internal.journey_v13 WHERE user_id=$1',[u.id]);
  const state=progress(u,j.rows[0]);
  if(typeof u.first_visit_hint==='boolean')state.first_visit_hint=u.first_visit_hint;
  return state;
 }
 async function complete(identity){
  return withTransaction(async c=>{
   const u=(await c.query('SELECT * FROM public.users WHERE id=$1 FOR UPDATE',[identity.id])).rows[0];
   if(!u)throw fail('ACCOUNT_UNAVAILABLE',404);
   if(u.has_completed_onboarding===true)return u;
   const j=(await c.query('SELECT * FROM jigcoin_internal.journey_v13 WHERE user_id=$1 FOR UPDATE',[u.id])).rows[0];
   if(!progress(u,j).ready)throw fail('INTRODUCTION_INCOMPLETE');
   await c.query('UPDATE jigcoin_internal.journey_v13 SET onboarding_completed_at=COALESCE(onboarding_completed_at,clock_timestamp()),daily_claimed_at=COALESCE(daily_claimed_at,$2) WHERE user_id=$1',[u.id,u.last_checkin_at||u.last_checkin_date||u.last_daily]);
   return (await c.query('UPDATE public.users SET has_completed_onboarding=TRUE WHERE id=$1 RETURNING *',[u.id])).rows[0];
  });
 }
 return {assertReady,registerTx,touchTx,open,status,complete};
}
module.exports={createReleaseJourney,sourceFrom};
