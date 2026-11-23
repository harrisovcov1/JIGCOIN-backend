'use strict';
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
const ELIGIBLE="u.telegram_id>0 AND COALESCE(u.is_system_user,FALSE)=FALSE AND (u.banned_until IS NULL OR u.banned_until<=CURRENT_TIMESTAMP)";
const EVENTS=new Set(['view_daily','view_global','view_friends','keep_tapping','open_vip','open_rewards','open_shop','open_invite','view_history','load_error']);
function createLeaderboards({pool,streakRewards,pilot,logger=console}) {
 let finalizing=null,lastFinalizedCheck=0;
 async function assertReady(){
  const r=await pool.query(`SELECT EXISTS(SELECT 1 FROM jigcoin_internal.leaderboard_config_v12) AS installed,
   EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass AND tgname='users_daily_score_v12' AND tgenabled='O'
   AND tgfoid=to_regprocedure('jigcoin_internal.capture_daily_score_v12()')) AS capture`);
  if(!r.rows[0]?.installed||!r.rows[0]?.capture)throw fail('LEADERBOARD_MIGRATION_REQUIRED',503);
 }
 async function rank(user){
  // Read this account's energy, balance and position under one DB snapshot.
  // Only the account row is joined to the windowed ranks.
  const result = await pool.query(`SELECT u.*, standings.place, standings.total,
      (EXTRACT(EPOCH FROM statement_timestamp()) * 1000000)::bigint AS sampled_us
    FROM public.users u
    LEFT JOIN (SELECT u.id, ROW_NUMBER() OVER(ORDER BY u.balance DESC,u.telegram_id ASC) AS place,
      COUNT(*) OVER() AS total FROM public.users u WHERE ${ELIGIBLE}) standings ON standings.id=u.id
    WHERE u.id=$1`, [user.id]);
  if (!result.rows.length) return {rank:null, total:0, account:null};
  const {place, total, sampled_us, ...account} = result.rows[0];
  return {rank:place == null ? null : Number(place), total:Number(total || 0),
    balance:Number(account.balance), account, sampledUs:Number(sampled_us)};
 }
 async function finalizeDue(force=false){
  if(finalizing)return finalizing;
  if(!force&&Date.now()-lastFinalizedCheck<60000)return;
  lastFinalizedCheck=Date.now();
  finalizing=(async()=>{
   // Catch up after restarts. Empty historical days cannot invent winners.
   const due=await pool.query(`SELECT d.day::text FROM jigcoin_internal.leaderboard_days_v12 d CROSS JOIN jigcoin_internal.leaderboard_config_v12 c
    WHERE d.finalized_at IS NULL AND d.day>=c.award_start_day
    ${require('./championshipRules').legacyPeriodFilter('d.day')} AND clock_timestamp()>=((d.day+1)::timestamp AT TIME ZONE 'UTC')+interval '2 minutes' ORDER BY d.day LIMIT 32`);
   for(const d of due.rows)await pool.query('SELECT jigcoin_internal.finalize_daily_race_v12($1::date)',[d.day]);
  })().finally(()=>{finalizing=null;});
  return finalizing;
 }
 function kickFinalizer(){void finalizeDue().catch(e=>logger.error('Leaderboard finalization failed',{code:e.code||'INTERNAL'}));}
 async function decorate(rows){
  if(!rows.length)return rows;
  const base=streakRewards?.decorate?await streakRewards.decorate(rows):rows;
  const medals=(await pool.query(`SELECT DISTINCT ON(u.telegram_id) u.telegram_id::text,a.day::text,a.place
   FROM jigcoin_internal.leaderboard_awards_v12 a JOIN public.users u ON u.id=a.user_id
   WHERE u.telegram_id=ANY($1::bigint[]) ORDER BY u.telegram_id,a.day DESC`,[rows.map(r=>r.telegram_id)])).rows;
  const map=new Map(medals.map(m=>[String(m.telegram_id),{day:m.day,place:Number(m.place)}]));
  const decorated=base.map(r=>({...r,medal:map.get(String(r.telegram_id))||null}));
  return pilot ? pilot.dress(decorated) : decorated;
 }
 async function board(user,mode='daily',body={}){
  if(!['global','daily','friends'].includes(mode))throw fail('BAD_LEADERBOARD');
  const page=body.page===undefined?0:body.page;
  if(!Number.isInteger(page)||page<0||page>10000)throw fail('BAD_PAGE');
  kickFinalizer();
  const score=mode==='daily'?'COALESCE(s.score,0)':'COALESCE(u.balance,0)';
  const joins=mode==='daily'?`LEFT JOIN jigcoin_internal.leaderboard_scores_v12 s ON s.user_id=u.id AND s.day=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`:'';
  const friends=mode==='friends'?`AND (u.id=$1 OR EXISTS(SELECT 1 FROM public.referrals f
   WHERE (f.inviter_id=$2::bigint AND f.invited_id=u.telegram_id) OR (f.invited_id=$2::bigint AND f.inviter_id=u.telegram_id)))`:'';
  const r=(await pool.query(`WITH eligible AS MATERIALIZED (
    SELECT u.id,u.telegram_id,LEFT(COALESCE(NULLIF(u.username,''),NULLIF(u.first_name,''),'Player'),64) AS display_name,${score} AS score
    FROM public.users u ${joins} WHERE ${ELIGIBLE} ${friends}
   ), ranked AS MATERIALIZED (
    SELECT *,ROW_NUMBER() OVER(ORDER BY score DESC,telegram_id ASC) AS rank FROM eligible ${mode==='daily'?'WHERE score>0':''}
   ), mine AS (SELECT * FROM ranked WHERE id=$1), formatted AS (
    SELECT telegram_id::text,display_name,score,rank FROM ranked
   ) SELECT $2::bigint AS viewer_telegram_id,CURRENT_TIMESTAMP AS server_now,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::text AS day,
    (((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date+1)::timestamp AT TIME ZONE 'UTC') AS ends_at,
    (SELECT award_start_day::text FROM jigcoin_internal.leaderboard_config_v12) AS award_start_day,
    (SELECT count(*)::integer FROM ranked) AS total,
    (SELECT jsonb_build_object('telegram_id',telegram_id::text,'score',score,'rank',(SELECT rank FROM mine),'display_name',display_name) FROM eligible WHERE id=$1) AS me,
    COALESCE((SELECT jsonb_agg(f ORDER BY f.rank) FROM formatted f WHERE rank<=3),'[]'::jsonb) AS podium,
    COALESCE((SELECT jsonb_agg(f ORDER BY f.rank) FROM formatted f WHERE rank BETWEEN (SELECT rank FROM mine)-3 AND (SELECT rank FROM mine)+3),'[]'::jsonb) AS nearby,
    COALESCE((SELECT jsonb_agg(f ORDER BY f.rank) FROM formatted f WHERE rank>$3 AND rank<=$3+20),'[]'::jsonb) AS entries`,[user.id,String(user.telegram_id),page*20])).rows[0];
  // Telegram IDs fit safely in JS integers; keep the existing Home contract.
  const normalize=x=>({...x,telegram_id:Number(x.telegram_id),score:Number(x.score),rank:x.rank==null?null:Number(x.rank),
   username:x.display_name,balance:mode==='daily'?undefined:Number(x.score),today_farmed:mode==='daily'?Number(x.score):undefined,
   global_rank:mode==='global'?Number(x.rank):undefined,daily_rank:mode==='daily'?Number(x.rank):undefined,friend_rank:mode==='friends'?Number(x.rank):undefined});
  const unique=[...new Map([...r.podium,...r.nearby,...r.entries].map(x=>[x.telegram_id,normalize(x)])).values()];
  const decorated=new Map((await decorate(unique)).map(x=>[String(x.telegram_id),x]));
  const rows=key=>r[key].map(x=>decorated.get(String(x.telegram_id)));
  const me=r.me?{...normalize(r.me),total:Number(r.total),global_total:Number(r.total),daily_total:Number(r.total)}:null;
  const above=me?.rank?rows('nearby').find(x=>x.rank===me.rank-1):null;
  const below=me?.rank?rows('nearby').find(x=>x.rank===me.rank+1):null;
  return {ok:true,version:12,telegram_id:String(user.telegram_id),mode,server_now:new Date(r.server_now).toISOString(),
   day:r.day,ends_at:new Date(r.ends_at).toISOString(),award_start_day:r.award_start_day,
   awards_enabled:r.day>=r.award_start_day,total:Number(r.total),me,
   podium:rows('podium'),nearby:rows('nearby'),entries:rows('entries'),page,page_size:20,has_more:(page+1)*20<Number(r.total),
   // Legacy Home/Rivals contract stays compatible during a rolling deployment.
   global:mode==='global'?rows('entries'):undefined,daily:mode==='daily'?rows('entries'):undefined,
   friends:mode==='friends'?rows('entries'):undefined,window:rows('nearby'),
   overtake:above?{target_telegram_id:above.telegram_id,target_display_name:above.display_name,need_points:Math.max(1,above.score-me.score+1)}:null,
   gap_below:below?Math.max(0,me.score-below.score):null};
 }
 async function history(user,body={}){
  const page=body.page===undefined?0:body.page;if(!Number.isInteger(page)||page<0||page>10000)throw fail('BAD_PAGE');
  await finalizeDue();
  const result=await pool.query(`SELECT a.day::text,a.place,a.score,a.display_name,u.telegram_id::text
   FROM jigcoin_internal.leaderboard_awards_v12 a JOIN public.users u ON u.id=a.user_id
   WHERE a.day IN (SELECT day FROM jigcoin_internal.leaderboard_days_v12 WHERE finalized_at IS NOT NULL AND participant_count>0 ORDER BY day DESC LIMIT 7 OFFSET $1)
   ORDER BY a.day DESC,a.place`,[page*7]);
  const mine=await pool.query(`SELECT day::text,place,score FROM jigcoin_internal.leaderboard_awards_v12 WHERE user_id=$1 ORDER BY day DESC LIMIT 30`,[user.id]);
  const total=Number((await pool.query('SELECT count(*)::integer AS n FROM jigcoin_internal.leaderboard_days_v12 WHERE finalized_at IS NOT NULL AND participant_count>0')).rows[0].n);
  return {ok:true,version:12,telegram_id:String(user.telegram_id),page,has_more:(page+1)*7<total,
   podiums:result.rows.map(x=>({...x,place:Number(x.place),score:Number(x.score)})),my_awards:mine.rows.map(x=>({...x,place:Number(x.place),score:Number(x.score)}))};
 }
 async function event(user,body={}){
  if(!EVENTS.has(body.event))throw fail('BAD_EVENT');
  await pool.query(`INSERT INTO jigcoin_internal.leaderboard_events_v12(day,user_id,event)
   VALUES((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date,$1,$2) ON CONFLICT(day,user_id,event)
   DO UPDATE SET count=LEAST(1000,leaderboard_events_v12.count+1),last_at=clock_timestamp()`,[user.id,body.event]);
  return {ok:true};
 }
 const handler=fn=>async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{res.json(await fn(req));}catch(e){const expected=Number.isInteger(e.status);logger.error('Leaderboard request failed',{route:req.path,code:e.code||'INTERNAL'});res.status(expected?e.status:503).json({ok:false,error:expected?(e.code||'UNAUTHORIZED'):'LEADERBOARD_UNAVAILABLE'});}
 };
 return {assertReady,rank,board,history,event,finalizeDue,kickFinalizer,handler};
}
module.exports={createLeaderboards};
