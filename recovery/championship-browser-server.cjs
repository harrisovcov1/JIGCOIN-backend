// Test controller over stdin/stdout only. Production never imports this module.
'use strict';
const {Pool}=require('pg');
const {readFileSync}=require('node:fs');
const {createInterface}=require('node:readline');
const {startIsolatedApp,signedInitData}=require('../test/helpers/httpApp.cjs');
const {setupLegacy}=require('../test/helpers/championshipRollback.cjs');
const solve=require('../test/helpers/championshipSolver.cjs');
const {schedule}=require('../lib/championshipRules');
async function main(){
 const port=Number(process.env.CHAMP_QA_PORT);
 if(!port)throw Error('A disposable loopback cluster is required');
 const db=new Pool({host:'127.0.0.1',port,user:'champ',database:'postgres'});
 const tx=async fn=>{const c=await db.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 if((await db.query("select to_regclass('public.users') existing")).rows[0].existing)throw Error('Requires empty database');
 await db.query(readFileSync('test/helpers/referral-fixture.sql','utf8'));
 await setupLegacy(db);
 await db.query(readFileSync('sql/migrations/20261119172826_referral_cumulative_activation.sql','utf8'));
 for(const name of ['030_championship_v2','031_championship_cutover'])await db.query(readFileSync('sql/migrations/'+name+'.sql','utf8'));
 await db.query('create table jigcoin_internal.telegram_write_grants(telegram_id bigint primary key)');
 // Latch a known synthetic cutover before inserting v2 trophy history.
 await db.query("INSERT INTO jigcoin_internal.championship_config VALUES(true,'2023-12-31T00:00:00Z')");
 const cleanup=[];
 const app=await startIsolatedApp({after:f=>cleanup.push(f)},false,{pool:db,withTransaction:tx,env:{CHAMPIONSHIP_V2:'1'}});
 const post=async(path,initData,body={})=>{
  const r=await fetch(app.url+'/api/championship/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,initData})});
  return r.status;
 };
 if(await post('status','')!==401)throw Error('Missing authentication boundary');
 const stream=createInterface({input:process.stdin});
 console.log(JSON.stringify({url:app.url}));
 for await(const line of stream){
  const q=JSON.parse(line);let result;
  if(q.cmd==='case'){
   const id=q.player,now=Date.now();
   let at=now-7*86400000;
   while(schedule(now,at).challenge!==q.variant)at-=7*86400000;
   await db.query('INSERT INTO jigcoin_internal.championship_config VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET accepted_at=excluded.accepted_at',[new Date(at)]);
   const user=(await db.query('INSERT INTO public.users(telegram_id,first_name) VALUES($1,$2) RETURNING id',[id,'QA Player'])).rows[0];
   await db.query('INSERT INTO jigcoin_internal.telegram_write_grants VALUES($1)',[id]);
   const day='2020-01-06';
   await db.query('INSERT INTO jigcoin_internal.leaderboard_days_v12(day,finalized_at,participant_count) VALUES($1,now(),1) ON CONFLICT DO NOTHING',[day]);
   // Historical fixtures use distinct dates per player and predate activation.
   const medalDay=new Date(Date.UTC(2020,0,6)+(id-10001)*86400000).toISOString().slice(0,10);
   await db.query("INSERT INTO jigcoin_internal.leaderboard_awards_v12(day,place,user_id,score,display_name) VALUES($1,1,$2,42,'QA Player')",[medalDay,user.id]);
   await db.query("INSERT INTO jigcoin_internal.weekly_finalizations_v16 VALUES('2020-01-06',now(),1,9,'weekly-v14','legacy_import') ON CONFLICT DO NOTHING");
   await db.query("INSERT INTO jigcoin_internal.weekly_awards_v16(week,user_id,score,place,awarded_at,player_name) VALUES('2020-01-06',$1,9,1,now(),'QA Player')",[user.id]);
   await db.query('update public.users set balance=17800 where id=$1',[user.id]);
   // Each case has its own week and account. Seed a settled historical bronze
   // through the same transaction/ledger helper used by production.
   await tx(async c=>{
    const week=new Date(Date.UTC(2024,0,1)+(id-10001)*7*86400000).toISOString().slice(0,10);
    await c.query('insert into jigcoin_internal.championship_weeks(week) values($1)',[week]);
    const {ledgerId}=await require('../lib/ledger').applyBalanceChangeTx(c,{userId:user.id,delta:25000,reason:'weekly_championship',eventType:'challenge_reward'});
    await c.query('insert into jigcoin_internal.championship_trophies values($1,3,$2,4400,25000,$3)',[week,user.id,ledgerId]);
   });
   result={initData:signedInitData(id),telegram_id:id,balance:42800};
  }else if(q.cmd==='answer'){
   const {rows:[row]}=await db.query('SELECT board FROM jigcoin_internal.championship_runs WHERE id=$1',[q.id]);
   result=solve(row.board);
  }else throw Error('Unknown QA command');
  console.log(JSON.stringify(result));
 }
 for(const f of cleanup)await f();
 await db.end();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
