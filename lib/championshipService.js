'use strict';
const {randomUUID}=require('node:crypto');
const {schedule,standings}=require('./championshipRules');
const games=require('./championshipGames');
const schema='jigcoin_internal.championship_';
const eligible="u.telegram_id>0 AND NOT coalesce(u.is_system_user,false) AND (u.banned_until IS NULL OR u.banned_until<=now()) AND NOT EXISTS(SELECT 1 FROM "+schema+"exclusions x WHERE x.player=u.id)";
const uuid=s=>typeof s==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
function fail(message){throw Object.assign(Error(message),{status:400,code:message});}
function view(r){
 const matched=[];
 if(r.board.hidden)for(let i=0;i+1<r.flips.length;i+=2){
  if(r.board.faces[r.flips[i]]===r.board.faces[r.flips[i+1]])matched.push(r.flips[i],r.flips[i+1]);
 }
 return {matched,pendingFace:r.board.hidden && r.flips.length%2?r.board.faces[r.flips.at(-1)]:null,id:r.id,round:r.round,finished:r.finished,mode:r.mode,score:r.points,expires:r.expires,
  flips:r.board.hidden?r.flips:undefined,board:r.finished?null:games.display(r.board),variant:r.variant,name:games.names[r.variant]};
}
function createChampionship({withTransaction,applyBalanceChangeTx}){
 async function calendar(c){
  const {rows}=await c.query('SELECT clock_timestamp() AS now,accepted_at FROM '+schema+'config WHERE singleton');
  return rows[0] && schedule(rows[0].now,rows[0].accepted_at);
 }
 async function ranking(c,week){
  const {rows}=await c.query(`SELECT r.player::text, (r.day-r.week) AS day, r.points AS score,r.slot,
    'ranked' AS mode,true AS eligible, left(coalesce(nullif(u.username,''),nullif(u.first_name,''),'Player'),40) AS name
    FROM ${schema}runs r JOIN public.users u ON u.id=r.player WHERE r.week=$1 AND r.mode='ranked' AND r.finished
    AND ${eligible}`,[week]);
  const names=new Map(rows.map(r=>[r.player,r.name]));
  return standings(rows,week).map(r=>({...r,name:names.get(r.player)}));
 }
 async function access(c,user){
  const {rowCount}=await c.query('SELECT id FROM public.users u WHERE id=$1 AND '+eligible+' FOR UPDATE OF u',[user.id]);
  if(!rowCount)fail('INELIGIBLE');
 }
 async function start(user,b){
  if(!uuid(b.request)||!['practice','ranked'].includes(b.mode))fail('INVALID_START');
  return withTransaction(async c=>{
   await access(c,user);
   const day=await calendar(c);if(!day)fail('INACTIVE');
   const {rows}=await c.query(`SELECT *, expires>clock_timestamp() AS active FROM ${schema}runs
    WHERE player=$1 AND day=$2 AND mode=$3 ORDER BY slot`,[user.id,day.day,b.mode]);
   const existing=rows.find(r=>r.request===b.request)||rows.find(r=>r.active&&!r.finished);
   if(existing)return view(existing);
   if(rows.length>=(b.mode==='practice'?1:3))fail('ALLOWANCE_USED');
   const board=games.puzzle(day.challenge);
   const result=await c.query(`INSERT INTO ${schema}runs(id,player,day,week,mode,slot,request,variant,board,opened,expires)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp(),least(clock_timestamp()+interval '10 minutes',($3::date+1)::timestamp AT TIME ZONE 'UTC')) RETURNING *`,
    [randomUUID(),user.id,day.day,day.week,b.mode,rows.length+1,b.request,day.challenge,board]);
   return view(result.rows[0]);
  });
 }
 async function observe(user,b){
  return withTransaction(async c=>{
   if(!uuid(b.id)||!Number.isInteger(b.round))fail('INVALID_RUN');
   const {rows:[r]}=await c.query(`SELECT board,extract(epoch FROM clock_timestamp()-opened)*1000 AS age FROM ${schema}runs
     WHERE id=$1 AND player=$2 AND round=$3 AND NOT finished AND expires>clock_timestamp()`,[b.id,user.id,b.round]);
   if(!r)fail('ROUND_CLOSED');
   const o=games.observation(r.board);
   const frame=o && Math.floor(Number(r.age)/o.interval);
   if(!o || frame>=o.frames.length)return {done:true};
   return {frame:o.frames[frame],wait:Math.max(1,Math.ceil((frame+1)*o.interval-r.age))};
  });
 }
 async function flip(user,b){
  return withTransaction(async c=>{
   if(!uuid(b.id)||!Number.isInteger(b.step)||!Number.isInteger(b.tile))fail('INVALID_FLIP');
   const {rows:[r]}=await c.query(`SELECT *,opened+interval '2.2 seconds'<=clock_timestamp() AS ready FROM ${schema}runs
    WHERE id=$1 AND player=$2 AND round=$3 AND NOT finished AND expires>clock_timestamp() FOR UPDATE`,[b.id,user.id,b.round]);
   if(!r||!r.ready||!r.board.hidden||b.tile<0||b.tile>=r.board.faces.length||b.step<0||b.step>=r.board.turns*2)fail('INVALID_FLIP');
   const flips=r.flips, faces=r.board.faces;
   if(b.step===flips.length){
    for(let i=0;i+1<flips.length;i+=2){
     if(faces[flips[i]]===faces[flips[i+1]] && (flips[i]===b.tile||flips[i+1]===b.tile))fail('ALREADY_MATCHED');
    }
    if(b.step%2 && flips.at(-1)===b.tile)fail('SAME_TILE');
    await c.query(`UPDATE ${schema}runs SET flips=array_append(flips,$2) WHERE id=$1`,[b.id,b.tile]);
   }else if(b.step!==flips.length-1 || flips[b.step]!==b.tile)fail('STALE_FLIP');
   return {face:faces[b.tile],matched:!!(b.step%2 && faces[flips[b.step-1]]===faces[b.tile])};
  });
 }
 async function answer(user,b){
  if(!uuid(b.id)||!Number.isInteger(b.round)||!Array.isArray(b.actions)||b.actions.length>20)fail('INVALID_ANSWER');
  return withTransaction(async c=>{
   await access(c,user);
   const {rows:[r]}=await c.query(`SELECT *, expires>clock_timestamp() AS active FROM ${schema}runs WHERE id=$1 AND player=$2 FOR UPDATE`,[b.id,user.id]);
   if(!r)fail('UNKNOWN_RUN');
   if(r.finished||b.round<r.round)return view(r);
   if(!r.active||r.round!==b.round)fail('ROUND_CLOSED');
   const observation=games.observation(r.board);
   const observationMs=observation?observation.interval*observation.frames.length:0;
   if(observationMs && !(await c.query(`SELECT clock_timestamp()>=$1::timestamptz+$2::int*interval '1 millisecond' AS ready`,[r.opened,observationMs])).rows[0].ready)fail('OBSERVE_FIRST');
   const actions=r.board.hidden?r.flips:b.actions;
   if(r.board.hidden && JSON.stringify(actions)!==JSON.stringify(b.actions))fail('MISMATCHED_FLIPS');
   const score=games.points(r.board,actions);
   const correct=score===200;
   const result=await c.query(`UPDATE ${schema}runs SET points=points+$4, flips='{}', opened=clock_timestamp(), round=round+1, correct=correct+$2, finished=round=4, board=$3 WHERE id=$1 RETURNING *`,
    [r.id,correct?1:0,r.round===4?{}:games.puzzle(r.variant),score]);
   return {...view(result.rows[0]),lastCorrect:correct};
  });
 }
 async function status(user,b){
  return withTransaction(async c=>{
   const day=await calendar(c);if(!day)return {active:false};
   const ranks=await ranking(c,day.week), me=ranks.find(r=>r.player===String(user.id));
   const friends=new Set([String(user.telegram_id)]);
   const f=await c.query('SELECT inviter_id,invited_id FROM public.referrals WHERE inviter_id=$1 OR invited_id=$1',[user.telegram_id]);
   for(const row of f.rows){friends.add(String(row.inviter_id));friends.add(String(row.invited_id));}
   const ids=await c.query('SELECT id::text FROM public.users WHERE telegram_id=ANY($1::bigint[])',[[...friends]]);
   const friendPlayers=new Set(ids.rows.map(r=>r.id));
   const usage=await c.query(`SELECT mode,count(*)::int AS used FROM ${schema}runs WHERE player=$1 AND day=$2 GROUP BY mode`,[user.id,day.day]);
   const remaining={practice:1,ranked:3};
   for(const r of usage.rows)remaining[r.mode]-=r.used;
   const history=await c.query(`SELECT week::text,place,score,coins,left(coalesce(nullif(u.username,''),u.first_name,'Player'),40) AS name,t.player=$1 AS mine
    FROM ${schema}trophies t JOIN public.users u ON u.id=t.player ORDER BY week DESC,place LIMIT 30`,[user.id]);
   const reminder=(await c.query('SELECT minute,quiet_from,quiet_to FROM '+schema+'reminders WHERE player=$1',[user.id])).rows[0];
   const visible=b.scope==='friends'?ranks.filter(r=>friendPlayers.has(r.player)):ranks;
   const publicRow=r=>r && ({place:r.place,name:r.name,total:r.total});
   const trophies=await c.query('SELECT week::text,place,score,coins FROM '+schema+'trophies WHERE player=$1 ORDER BY week DESC',[user.id]);
   return {active:true,reminder:reminder||null,instructions:games.instructions[day.challenge],trophies:trophies.rows,...day,name:games.names[day.challenge],remaining,me:publicRow(me),daily:me?.daily||Array(7).fill(0),
    rival:publicRow(me && ranks[me.place-2]),podium:ranks[2]?.total||0,rows:visible.slice(0,30).map(publicRow),history:history.rows};
  });
 }
 async function settle(week){
  return withTransaction(async c=>{
   const {rows:[config]}=await c.query('SELECT accepted_at,clock_timestamp() AS now FROM '+schema+'config WHERE singleton FOR UPDATE');
   if(!config)fail('INACTIVE');
   const season=schedule(week+'T00:00:00Z',config.accepted_at);
   if(!season||season.week!==week||Date.parse(season.close)>+config.now)fail('WEEK_NOT_CLOSED');
   const inserted=await c.query('INSERT INTO '+schema+'weeks(week) VALUES($1) ON CONFLICT DO NOTHING RETURNING week',[week]);
   if(!inserted.rowCount)return [];
   const winners=(await ranking(c,week)).slice(0,3);
   for(const r of winners){
    await access(c,{id:r.player});
    const credit=await applyBalanceChangeTx(c,{userId:r.player,delta:r.prize,reason:'weekly_championship',refType:'championship_week',refId:Number(week.replaceAll('-','')),eventType:'challenge_reward'});
    await c.query('INSERT INTO '+schema+'trophies(week,place,player,score,coins,ledger_id) VALUES($1,$2,$3,$4,$5,$6)',[week,r.place,r.player,r.total,r.prize,credit.ledgerId]);
   }
   return winners;
  });
 }
 async function maintain(dispatch){
  const due=await withTransaction(async c=>{
   const day=await calendar(c);if(!day)return null;
   return (await c.query(`SELECT DISTINCT week::text AS week FROM ${schema}runs r WHERE week<$1 AND
    NOT EXISTS(SELECT 1 FROM ${schema}weeks w WHERE w.week=r.week) ORDER BY week`,[day.week])).rows;
  });
  if(due){for(const row of due)await settle(row.week);await dispatch();}
 }
 return {start,answer,status,observe,flip,settle,maintain};
}
module.exports={createChampionship,viewRun:view};
