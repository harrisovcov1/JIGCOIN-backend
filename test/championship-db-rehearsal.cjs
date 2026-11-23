// Run only against a newly created, empty, loopback QA database.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Pool}=require('pg');
const {randomUUID}=require('node:crypto');
const {createChampionship}=require('../lib/championshipService');
const {createReminders}=require('../lib/championshipReminders');
const {applyBalanceChangeTx}=require('../lib/ledger');
async function main(){
 const port=Number(process.env.CHAMP_QA_PORT);
 if(!port)throw Error('Set CHAMP_QA_PORT for a disposable local cluster');
 const db=new Pool({host:'127.0.0.1',port,user:'champ',database:'postgres'});
 const tx=async fn=>{const c=await db.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 try{
 assert.equal((await db.query("select to_regclass('public.users') as u")).rows[0].u,null);
 await db.query(fs.readFileSync('test/helpers/referral-fixture.sql','utf8'));
 await db.query("create table jigcoin_internal.legacy_honours_fixture(day date, kind text);insert into jigcoin_internal.legacy_honours_fixture values('2026-01-01','daily gold'),('2026-01-05','weekly gold')");
 await db.query(fs.readFileSync('sql/migrations/030_championship_v2.sql','utf8'));
 await db.query("insert into jigcoin_internal.championship_config values(true,now()-interval '30 days')");
 await db.query("insert into public.users(telegram_id,balance) select n,1000 from generate_series(1,5) n");
 const u={id:1,telegram_id:1}, service=createChampionship({withTransaction:tx,applyBalanceChangeTx});
 for(const mode of ['ranked','practice']){
  const requests=await Promise.all(Array.from({length:4},()=>service.start(u,{mode,request:randomUUID()})));
  assert.equal(new Set(requests.map(r=>r.id)).size,1);
  for(let slot=0;slot<(mode==='practice'?1:3);slot++){
   const run=slot?await service.start(u,{mode,request:randomUUID()}):requests[0];
   for(let round=0;round<5;round++){
    await db.query("update jigcoin_internal.championship_runs set opened=opened-interval '1 minute' where id=$1",[run.id]);
    const a={id:run.id,round,actions:[]};
    const [x,y]=await Promise.all([service.answer(u,a),service.answer(u,a)]);
    assert.equal(x.round,round+1);assert.equal(y.round,x.round);
   }
  }
  await assert.rejects(service.start(u,{mode,request:randomUUID()}),/ALLOWANCE_USED/);
 }
 const status=await service.status(u,{scope:'friends'});assert.deepEqual(status.remaining,{ranked:0,practice:0});
 const {rows:[{week}]}=await db.query("select (date_trunc('week',now() at time zone 'UTC')::date-7)::text as week");
 await db.query(`insert into jigcoin_internal.championship_runs(id,player,day,week,mode,slot,request,variant,board,opened,expires,round,correct,finished)
 select gen_random_uuid(),n,$1,$1,'ranked',1,gen_random_uuid(),0,'{}',now()-interval '8 days',now()-interval '7 days',5,6-n,true from generate_series(1,5) n`,[week]);
 await db.query("insert into jigcoin_internal.championship_exclusions values(1,'synthetic duplicate')");
 await db.query("update public.users set banned_until=now()+interval '1 day' where id=5");
 let count=0;const interrupted=createChampionship({withTransaction:tx,applyBalanceChangeTx:async(...args)=>{const r=await applyBalanceChangeTx(...args);if(++count===2)throw Error('synthetic interruption');return r;}});
 await assert.rejects(interrupted.settle(week),/interruption/);
 assert.equal((await db.query("select * from public.user_balance_ledger where reason='weekly_championship'")).rowCount,0);
 await Promise.all([service.settle(week),service.settle(week)]);
 await createChampionship({withTransaction:tx,applyBalanceChangeTx}).settle(week);
 assert.deepEqual((await db.query('select player::int,coins from jigcoin_internal.championship_trophies order by place')).rows,[{player:2,coins:100000},{player:3,coins:50000},{player:4,coins:25000}]);
 assert.equal((await db.query("select sum(delta)::int as n from public.user_balance_ledger where reason='weekly_championship'")).rows[0].n,175000);
 await db.query('create table jigcoin_internal.telegram_write_grants(telegram_id bigint primary key)');
 const user={id:2,telegram_id:2}, minute=new Date().getUTCHours()*60+new Date().getUTCMinutes();
 let sent=0;const reminders=createReminders({withTransaction:tx,callTelegram:async()=>{sent++;}});
 const pref={enabled:true,minute,quietFrom:0,quietTo:0};
 await assert.rejects(reminders.set(user,pref),/permission/);
 await db.query('insert into jigcoin_internal.telegram_write_grants values(2)');
 await reminders.set(user,pref);await Promise.all([reminders.dispatch(),reminders.dispatch()]);assert.equal(sent,1);
 await reminders.set(user,{enabled:false});assert.equal((await db.query('select * from jigcoin_internal.championship_reminders')).rowCount,0);
 await db.query('INSERT INTO jigcoin_internal.telegram_write_grants VALUES(3)');
 const uncertain=createReminders({withTransaction:tx,callTelegram:async()=>{throw Error('Ambiguous delivery');}});
 await uncertain.set({id:3,telegram_id:3},pref);await uncertain.dispatch();await uncertain.dispatch();
 assert.deepEqual((await db.query('SELECT state FROM jigcoin_internal.championship_deliveries WHERE player=3')).rows,[{state:'uncertain'}]);
 assert.equal((await db.query('select * from jigcoin_internal.legacy_honours_fixture')).rowCount,2);
 await assert.rejects(service.settle('2000-01-03'),/WEEK_NOT_CLOSED/);
 const solve=require('./helpers/championshipSolver.cjs');
 const games=require('../lib/championshipGames');
 const covered=new Set();
 for(let n=0;n<30;n++){
  // A seven-day shift moves the rotation by seven. Seven and thirty are coprime.
  await db.query("UPDATE jigcoin_internal.championship_config SET accepted_at=date_trunc('week',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-($1::int*7+1)*interval '1 day'",[n]);
  const player=(await db.query('INSERT INTO public.users(telegram_id) VALUES($1) RETURNING id,telegram_id',[200+n])).rows[0];
  let run=await service.start(player,{mode:'ranked',request:randomUUID()});
  covered.add(run.variant);
  for(let round=0;round<5;round++){
   const {rows:[{board}]}=await db.query('SELECT board FROM jigcoin_internal.championship_runs WHERE id=$1',[run.id]);
   const body={id:run.id,round,actions:solve(board)};
   if(board.crossings||board.reveal||board.hidden)await assert.rejects(service.answer(player,body),/OBSERVE_FIRST/);
   await db.query("UPDATE jigcoin_internal.championship_runs SET opened=opened-interval '1 minute' WHERE id=$1",[run.id]);
   run=await service.answer(player,body);
  }
  assert.equal(run.finished,true);assert.equal(run.score,1000);
  const peer=await service.status(player,{scope:'friends'});
  assert.equal(peer.me.total,1000);assert.equal(peer.rows.length,1);
  console.log('DB gameplay PASS',run.variant,games.names[run.variant]);
 }
 assert.equal(covered.size,30);
 console.log('PASS: additive migration, concurrent/resumed starts, daily limits, answer retries, synthetic payout failure rollback, concurrent settlement, new service instance retry, exclusions, 175000 ledger total, reminders consent/dedup/disable');
 }finally{await db.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
