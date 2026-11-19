'use strict';

const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {Pool}=require('pg');
const {createWeeklyRace,board,policyOf}=require('../lib/weeklyRace');

const port=Number(process.env.JIGCOIN_TEST_POSTGRES_PORT);
const integration=port?test:test.skip;
const options={host:'127.0.0.1',port,user:process.env.USER||'agent',ssl:false};
const dbName='jigcoin_weekly_daily_test_'+process.pid;
const migration='20261119172851_weekly_daily_runs_and_awards.sql';
const sqlFile=name=>readFileSync(path.join(__dirname,'../sql/migrations',name),'utf8');
let admin,pool,race,players,now;
const clock=()=>now;
async function transaction(fn) {
  const c=await pool.connect();
  try {await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}
  catch(error){await c.query('ROLLBACK');throw error;}
  finally{c.release();}
}
const make=(extra={})=>createWeeklyRace({pool,withTransaction:transaction,clock,env:{},...extra});
const at=iso=>{now=Date.parse(iso);};
const start=(user,extra={})=>race.start(user,{request_key:randomUUID(),...extra}).then(r=>r.run);
function picks(run) {
  for(let a=0;a<6;a++) for(let b=a+1;b<6;b++)
    if(run.board.tiles[a]+run.board.tiles[b]===run.board.target)return[a,b];
  throw new Error('Missing solution');
}
const answer=(user,run,extra={})=>race.answer(user,{id:run.id,turn:run.turn,picks:picks(run),...extra});
async function seedScore(user,week,best) {
  return (await pool.query(`INSERT INTO jigcoin_internal.weekly_racers_v14(week,user_id,share_code,best)
    VALUES($1,$2,$3,$4) ON CONFLICT(week,user_id) DO UPDATE SET best=EXCLUDED.best RETURNING *`,
    [week,user.id,randomBytes(10).toString('hex'),best])).rows[0];
}

test('policy changes exactly at the approved Monday, with new date-specific ranked puzzle sequences',()=>{
  assert.equal(policyOf('2026-11-22T23:59:59.999Z').period,'week');
  assert.equal(policyOf('2026-11-23T00:00:00.000Z').period,'day');
  const signature=day=>Array.from({length:12},(_,turn)=>{
    const value=board({week_key:'2026-11-23',allowance_key:day,policy_version:'daily-v16',slot:1,turn,seed:'fixture'});
    return[value.target,...value.tiles.slice().sort()];
  });
  assert.notDeepEqual(signature('2026-11-23'),signature('2026-11-24'));
  assert.deepEqual(signature('2026-11-23'),signature('2026-11-23'));
});

before(async()=>{
  if(!port)return;
  at('2026-11-19T12:00:00Z');
  admin=new Pool({...options,database:'postgres'});
  await admin.query('CREATE DATABASE '+dbName);
  pool=new Pool({...options,database:dbName,max:12});
  await pool.query(`DO $$ BEGIN
    PERFORM pg_advisory_xact_lock(14142025);
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  END $$;
  CREATE SCHEMA jigcoin_internal;
  CREATE TABLE public.users(id bigint PRIMARY KEY,telegram_id bigint,username text,first_name text,
    balance bigint DEFAULT 17800,vip_until timestamptz,banned_until timestamptz,is_system_user boolean DEFAULT false);
  CREATE TABLE public.referrals(inviter_id bigint,invited_id bigint);
  INSERT INTO public.users(id,telegram_id,username) SELECT n,n+2000,'Player '||n FROM generate_series(1,20)n;`);
  players=(await pool.query('SELECT * FROM public.users ORDER BY id')).rows;
  for(const name of ['024_revenue_pilot.sql','025_mint_race_cards.sql'])await pool.query(sqlFile(name));
  await seedScore(players[17],'2026-11-02',4);
  await seedScore(players[18],'2026-11-02',4);
  await seedScore(players[19],'2026-11-02',0);
  race=make();
});
after(async()=>{
  if(pool)await pool.end();
  if(admin){await admin.query('DROP DATABASE IF EXISTS '+dbName);await admin.end();}
});

integration('readiness requires the new schema and the repeatable migration preserves historical tied medals',async()=>{
  await assert.rejects(()=>race.prepareRelease(),{code:'WEEKLY_SCHEMA_REQUIRED',status:503});
  await pool.query(sqlFile(migration));
  await pool.query(sqlFile(migration));
  race=make();
  await race.prepareRelease();
  for(const user of players.slice(17,19))
    assert.deepEqual((await race.profile(user)).medals,[{week:'2026-11-02',score:4}]);
  const flags=(await pool.query(`SELECT c.relname,c.relrowsecurity,
    has_table_privilege('anon',c.oid,'SELECT') AS exposed
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='jigcoin_internal'
      AND c.relname IN ('weekly_practice_runs_v16','weekly_awards_v16','weekly_finalizations_v16','weekly_run_requests_v16')`)).rows;
  assert.equal(flags.length,4);
  assert.ok(flags.every(row=>row.relrowsecurity&&!row.exposed));
  assert.equal((await pool.query("SELECT has_table_privilege('service_role','jigcoin_internal.weekly_awards_v16','UPDATE') AS writable")).rows[0].writable,false);
  await assert.rejects(()=>pool.query("UPDATE jigcoin_internal.weekly_awards_v16 SET score=5 WHERE week='2026-11-02'"),{code:'55000'});
  await assert.rejects(()=>pool.query("DELETE FROM jigcoin_internal.weekly_finalizations_v16 WHERE week='2026-11-02'"),{code:'55000'});
});

integration('this week keeps three total runs even when the UTC day changes',async()=>{
  const user=players[0];
  for(const [index,date] of ['2026-11-19','2026-11-20','2026-11-21'].entries()){
    at(date+'T12:00:00Z');
    const run=await start(user);
    assert.equal(run.slot,index+1);
    assert.equal(run.policy_version,'weekly-v14');
    assert.equal(run.allowance_day,date);
  }
  at('2026-11-22T12:00:00Z');
  await assert.rejects(()=>start(user),{code:'RUNS_USED'});
  const state=await race.standings(user,{});
  assert.equal(state.policy.period,'week');assert.equal(state.runs_left,0);
  assert.equal(new Date(state.resets_at).toISOString(),'2026-11-23T00:00:00.000Z');
});

integration('the old v14 INSERT remains valid during migration-first deployment and cannot split the new quota bucket',async()=>{
  const user=players[19];
  const oldInsert=async(week,started)=>{
    await seedScore(user,week,0);
    return (await pool.query(`INSERT INTO jigcoin_internal.weekly_runs_v14
      (id,request_key,week,user_id,slot,seed,starts_at,ends_at,finish_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING allowance_day::text AS day,policy_version,puzzle_version`,
      [randomUUID(),randomUUID(),week,user.id,1,randomBytes(24).toString('hex'),new Date(started),new Date(Date.parse(started)+45000),'rank-1'])).rows[0];
  };
  assert.deepEqual(await oldInsert('2026-11-16','2026-11-20T23:59:50Z'),{day:'2026-11-20',policy_version:'weekly-v14',puzzle_version:'weekly-v14'});
  assert.deepEqual(await oldInsert('2026-11-23','2026-11-26T23:59:50Z'),{day:'2026-11-26',policy_version:'daily-v16',puzzle_version:'weekly-v14'});
  await assert.rejects(()=>pool.query(`INSERT INTO jigcoin_internal.weekly_runs_v14
    (id,request_key,week,user_id,slot,seed,starts_at,ends_at,policy_version,allowance_day)
    VALUES($1,$2,'2026-11-23',$3,1,'fixture','2026-11-26T12:00:00Z','2026-11-26T12:00:45Z','weekly-v14','2026-11-25')`,
    [randomUUID(),randomUUID(),user.id]),{code:'23505'});
});

integration('daily allowance is concurrent-safe, identical for VIP and free users, and each turn is credited once',async()=>{
  at('2026-11-23T12:00:00Z');
  const [free,vip]=players;
  await pool.query("UPDATE public.users SET vip_until='2027-01-01',balance=50000 WHERE id=$1",[vip.id]);
  const key=randomUUID();
  const starts=await Promise.all([start(free,{request_key:key}),start(free,{request_key:key}),start(free),start(free)]);
  assert.ok(starts.every(run=>run.id===starts[0].id));
  const run=starts[0],paid=await start(vip);
  const resumedKey=randomUUID();
  assert.equal((await start(free,{request_key:resumedKey})).id,run.id);
  assert.equal(run.mode,'ranked');assert.equal(run.policy_version,'daily-v16');
  assert.deepEqual([...run.board.tiles].sort(),[...paid.board.tiles].sort());
  assert.equal(run.board.target,paid.board.target);
  const answers=await Promise.all([answer(free,run),answer(free,run),answer(free,run)]);
  assert.ok(answers.every(result=>result.run.score===1));
  assert.equal(answers.filter(result=>result.correct===true).length,1);
  assert.equal((await race.end(free,{id:run.id,score:999})).run.live,true);
  assert.equal((await start(free)).id,run.id);
  for(let slot=2;slot<=3;slot++){
    now+=46000;
    assert.equal((await start(free)).slot,slot);
    assert.equal((await start(vip)).slot,slot);
  }
  now+=46000;
  for(const user of [free,vip])await assert.rejects(()=>start(user),{code:'RUNS_USED'});
  assert.equal((await start(free,{request_key:key})).id,run.id);
  assert.equal((await start(free,{request_key:resumedKey})).id,run.id);
  assert.equal((await race.end(free,{id:run.id})).run.score,1);
  assert.deepEqual(await race.end(free,{id:run.id}),await race.end(free,{id:run.id}));
  const decorated=await race.dress([free,vip]);
  assert.equal(decorated[0].vip_active,false);
  assert.equal(decorated[1].vip_active,true);assert.equal(decorated[1].vip_coin,false);
  assert.equal(decorated[1].rank_finish,'rank-2');assert.equal(decorated[1].finish,'rank-2');
  at('2026-11-24T12:00:00Z');
  assert.equal((await race.standings(free,{})).runs_left,3);
  assert.equal((await start(free)).slot,1);
  assert.equal((await race.standings(free,{})).best,1);
});

integration('a midnight-crossing run keeps its start-date slot and resumes before today’s fresh allowance',async()=>{
  const user=players[2];
  at('2026-11-24T23:59:50Z');
  const run=await start(user);
  at('2026-11-25T00:00:01Z');
  const state=await race.standings(user,{});
  assert.equal(state.allowance_day,'2026-11-25');assert.equal(state.runs_left,3);
  assert.equal(state.run.allowance_day,'2026-11-24');assert.equal(state.run.live,true);
  assert.equal((await start(user)).id,run.id);
  assert.equal((await answer(user,run)).run.score,1);
  at('2026-11-25T00:00:35Z');
  assert.equal((await race.end(user,{id:run.id})).run.live,false);
  const fresh=await start(user);
  assert.equal(fresh.slot,1);assert.equal(fresh.allowance_day,'2026-11-25');
  const state2=await race.standings(user,{});
  assert.equal(state2.runs_left,2);assert.equal(state2.best,1);
});

integration('daily result cards use the latest completed date and freeze VIP and rank independently of the selected coin',async()=>{
  const [me,rival]=players.slice(6,8);
  at('2026-11-24T15:00:00Z');
  await pool.query("UPDATE public.users SET vip_until='2027-01-01',balance=50000 WHERE id=$1",[me.id]);
  let other=await start(rival);
  other=(await answer(rival,other)).run;
  await answer(rival,other);
  for(let count=1;count<=3;count++){
    let mine=await start(me);
    for(let score=0;score<count;score++)mine=(await answer(me,mine)).run;
    now+=46000;
  }
  const code=(await race.standings(rival,{})).share_code;
  const original=(await race.standings(me,{rival:code})).result;
  const oldMe=original.players.find(player=>player.me);
  assert.equal(oldMe.score,3);assert.equal(oldMe.slot,3);
  assert.equal(oldMe.finish,'rank-2');assert.equal(oldMe.rank_finish,'rank-2');assert.equal(oldMe.vip_active,true);
  await pool.query('UPDATE public.users SET vip_until=NULL,balance=150000 WHERE id=$1',[me.id]);
  at('2026-11-25T01:00:00Z');
  const next=await start(me);
  await answer(me,next);
  now+=46000;
  const rematch=(await race.standings(me,{rival:code})).result;
  const newMe=rematch.players.find(player=>player.me);
  assert.equal(newMe.score,1);assert.equal(newMe.slot,1);assert.equal(newMe.allowance_day,'2026-11-25');
  assert.equal(newMe.rank_finish,'rank-3');assert.equal(newMe.vip_active,false);
  assert.notEqual(rematch.code,original.code);
  assert.deepEqual((await race.standings(me,{card:original.code})).result,original);
});

integration('unlimited practice stays separate, reuses live requests and stores only the latest run',async()=>{
  const user=players[3];
  at('2026-11-25T12:00:00Z');
  const ranked=await start(user),key=randomUUID();
  const starts=await Promise.all([race.practiceStart(user,{request_key:key}),race.practiceStart(user,{request_key:key}),race.practiceStart(user,{request_key:randomUUID()})]);
  let run=starts[0].run;
  assert.ok(starts.every(result=>result.run.id===run.id));
  assert.equal(run.mode,'practice');assert.equal(run.slot,null);
  const resumedKey=randomUUID();
  assert.equal((await race.practiceStart(user,{request_key:resumedKey})).run.id,run.id);
  assert.ok(run.board.tiles.every(Number.isInteger));assert.equal(run.board.tiles.length,6);
  await assert.rejects(()=>answer(user,run),{code:'RUN_UNAVAILABLE'});
  await assert.rejects(()=>race.practiceAnswer(user,{id:ranked.id,turn:ranked.turn,picks:picks(ranked)}),{code:'RUN_UNAVAILABLE'});
  const move={id:run.id,turn:run.turn,picks:picks(run),score:999,mode:'ranked'};
  const answers=await Promise.all([race.practiceAnswer(user,move),race.practiceAnswer(user,move)]);
  assert.ok(answers.every(result=>result.run.score===1));
  assert.equal((await race.standings(user,{})).practice_run.id,run.id);
  now+=46000;
  assert.equal((await race.practiceStart(user,{request_key:key})).run.id,run.id);
  assert.equal((await race.practiceStart(user,{request_key:resumedKey})).run.id,run.id);
  assert.deepEqual(await race.practiceEnd(user,{id:run.id}),await race.practiceEnd(user,{id:run.id}));
  assert.equal((await race.practiceStart(user,{request_key:resumedKey.toUpperCase()})).run.id,run.id);
  const seeds=new Set();
  for(let i=0;i<8;i++){
    run=(await race.practiceStart(user,{request_key:randomUUID()})).run;
    const data=(await pool.query('SELECT seed FROM jigcoin_internal.weekly_practice_runs_v16 WHERE user_id=$1',[user.id])).rows[0];
    seeds.add(data.seed);
    await race.practiceAnswer(user,{id:run.id,turn:run.turn,picks:picks(run)});
    now+=46000;
  }
  assert.equal(seeds.size,8);
  const state=await race.standings(user,{});
  assert.equal(state.best,0);assert.equal(state.place,null);assert.equal(state.runs_left,2);
  assert.equal(state.leaders.some(row=>row.me),false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM jigcoin_internal.weekly_practice_runs_v16 WHERE user_id=$1',[user.id])).rows[0].n,1);
  assert.equal((await pool.query('SELECT balance FROM public.users WHERE id=$1',[user.id])).rows[0].balance,'17800');
});

integration('the week closing window blocks starts but practice stays available',async()=>{
  at('2026-11-29T23:59:14Z');
  const run=await start(players[4]);
  assert.equal(new Date(run.ends_at).toISOString(),'2026-11-29T23:59:59.000Z');
  at('2026-11-29T23:59:16Z');
  await assert.rejects(()=>start(players[5]),{code:'WEEK_CLOSING'});
  const state=await race.standings(players[5],{});
  assert.equal(state.can_start,false);assert.equal(state.runs_left,3);
  assert.equal(new Date(state.starts_blocked_until).toISOString(),'2026-11-30T00:00:00.000Z');
  assert.equal((await race.practiceStart(players[5],{request_key:randomUUID()})).run.mode,'practice');
});

integration('new instances correctly answer a legacy-instance puzzle after the daily-policy cutover',async()=>{
  at('2026-11-26T23:59:51Z');
  const user=players[19];
  const run=(await pool.query(`SELECT *,week::text AS week_key FROM jigcoin_internal.weekly_runs_v14
    WHERE user_id=$1 AND week='2026-11-23'`,[user.id])).rows[0];
  assert.equal(run.policy_version,'daily-v16');assert.equal(run.puzzle_version,'weekly-v14');
  for(let turn=0;turn<12;turn++){
    // Exactly the fields used by v14's board generator, with no new policy data.
    const legacy={id:run.id,turn,board:board({week_key:run.week_key,slot:run.slot,seed:run.seed,turn})};
    const result=await answer(user,legacy);
    assert.equal(result.correct,true);assert.equal(result.run.score,turn+1);
  }
});

integration('Global and Friends use the same eligible players while Friends is the actual referral group',async()=>{
  at('2026-11-30T12:00:00Z');
  for(const [i,score] of [5,4,3,99,98,0,8].entries())await seedScore(players[i],'2026-11-30',score);
  await pool.query("UPDATE public.users SET banned_until='2027-01-01' WHERE id=$1",[players[3].id]);
  await pool.query('UPDATE public.users SET is_system_user=true WHERE id=$1',[players[4].id]);
  await pool.query('INSERT INTO public.referrals(inviter_id,invited_id) VALUES($1,$2),($2,$3),($2,$4),($2,$5)',
    [players[1].telegram_id,players[0].telegram_id,players[2].telegram_id,players[3].telegram_id,players[4].telegram_id]);
  const global=await race.standings(players[0],{scope:'global'});
  const friends=await race.standings(players[0],{scope:'friends'});
  assert.equal(global.scope,'global');assert.equal(global.total,4);assert.equal(global.place,2);
  assert.deepEqual(global.leaders.map(row=>row.score),[8,5,4,3]);
  assert.equal(friends.scope,'friends');assert.equal(friends.total,3);assert.equal(friends.place,1);assert.equal(friends.global_place,2);
  assert.deepEqual(friends.leaders.map(row=>row.score),[5,4,3]);
  assert.ok(friends.leaders.find(row=>row.score===4).vip_active);
  assert.equal(friends.leaders.find(row=>row.score===4).rank_finish,'rank-2');
  const bannedCode=(await pool.query('SELECT share_code FROM jigcoin_internal.weekly_racers_v14 WHERE week=$1 AND user_id=$2',['2026-11-30',players[3].id])).rows[0].share_code;
  assert.equal((await race.standings(players[0],{rival:bannedCode})).rival,null);
  await assert.rejects(()=>start(players[3]),{code:'PLAYER_UNAVAILABLE'});
  await assert.rejects(()=>race.practiceStart(players[4],{request_key:randomUUID()}),{code:'PLAYER_UNAVAILABLE'});
  await assert.rejects(()=>race.standings(players[0],{scope:'fake'}),{code:'INVALID_SCOPE'});
});

integration('weekly medals freeze every positive top-score tie and cannot be rewritten by later balances or eligibility',async()=>{
  at('2026-12-07T12:00:00Z');
  const [one,two]=players.slice(8,10);
  await pool.query("UPDATE public.users SET vip_until='2027-01-01',balance=50000 WHERE id=$1",[one.id]);
  for(const user of [one,two]){
    let run=await start(user);
    run=(await answer(user,run)).run;
    await answer(user,run);
  }
  await seedScore(players[3],'2026-12-07',99);
  await seedScore(players[4],'2026-12-07',98);
  await seedScore(players[10],'2026-12-07',0);
  at('2026-12-14T00:00:00Z');
  const other=make();
  await Promise.all([race.finalizeDue({force:true}),race.finalizeDue({force:true}),other.finalizeDue({force:true})]);
  const saved=(await pool.query("SELECT * FROM jigcoin_internal.weekly_awards_v16 WHERE week='2026-12-07' ORDER BY user_id")).rows;
  assert.deepEqual(saved.map(row=>[row.user_id,row.score,row.place]),[[one.id,2,1],[two.id,2,1]]);
  assert.equal(saved[0].vip_active,true);assert.equal(saved[0].rank_finish_key,'rank-2');
  await pool.query("UPDATE public.users SET balance=0,username='Changed',vip_until=NULL WHERE id=$1",[one.id]);
  await pool.query("UPDATE jigcoin_internal.weekly_racers_v14 SET best=100 WHERE week='2026-12-07' AND user_id=$1",[players[10].id]);
  await pool.query('UPDATE public.users SET banned_until=NULL,is_system_user=false WHERE id=ANY($1::bigint[])',[[players[3].id,players[4].id]]);
  await race.finalizeDue({force:true});
  assert.deepEqual((await pool.query("SELECT * FROM jigcoin_internal.weekly_awards_v16 WHERE week='2026-12-07' ORDER BY user_id")).rows,saved);
  const profile=await race.profile(one);
  assert.equal(profile.weekly_awards[0].score,2);assert.equal(profile.weekly_awards[0].vip_active,true);
  const state=await race.standings(one,{});
  assert.equal(state.last_award.week,'2026-12-07');assert.equal(state.finalized_through_week,'2026-12-07');
});

integration('a single eligible positive scorer still wins and an empty week awards nothing',async()=>{
  await seedScore(players[12],'2026-12-14',1);
  at('2026-12-21T00:00:00Z');
  await race.finalizeDue({force:true});
  assert.equal((await race.profile(players[12])).medals[0].week,'2026-12-14');
  at('2026-12-28T00:00:00Z');
  await race.finalizeDue({force:true});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM jigcoin_internal.weekly_awards_v16 WHERE week='2026-12-21'")).rows[0].n,0);
  assert.equal((await pool.query("SELECT participants,winning_score FROM jigcoin_internal.weekly_finalizations_v16 WHERE week='2026-12-21'")).rows[0].participants,0);
});

integration('a last valid answer commits before the exclusive weekly final snapshot',async()=>{
  at('2027-01-03T23:59:14Z');
  const user=players[15],run=await start(user);
  at('2027-01-03T23:59:58Z');
  let unblock,entered;
  const gate=new Promise(resolve=>{unblock=resolve;});
  const inside=new Promise(resolve=>{entered=resolve;});
  const pendingRace=make({withTransaction:fn=>transaction(async c=>{const result=await fn(c);entered();await gate;return result;})});
  const pendingAnswer=pendingRace.answer(user,{id:run.id,turn:run.turn,picks:picks(run)});
  await inside;
  at('2027-01-04T00:00:00Z');
  const pendingFinal=race.finalizeDue({force:true});
  let waiting=false;
  for(let tries=0;tries<100;tries++){
    const {rows}=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'");
    if(rows.length){waiting=true;break;}
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  unblock();
  await Promise.all([pendingAnswer,pendingFinal]);
  assert.equal(waiting,true);
  assert.deepEqual((await race.profile(user)).medals[0],{week:'2026-12-28',score:1});
  assert.equal((await race.end(user,{id:run.id})).run.score,1);
});

integration('a late answer waits for finalization before locking its player, avoiding a foreign-key deadlock',async()=>{
  at('2027-01-10T23:59:14Z');
  const user=players[16],run=await start(user);
  at('2027-01-11T00:00:00Z');
  const finalizer=await pool.connect(),probe=await pool.connect();
  await finalizer.query('BEGIN');
  await finalizer.query('SELECT pg_advisory_xact_lock($1::int,$2::int)',[1612026,Math.floor(Date.parse('2027-01-04T00:00:00Z')/86400000)]);
  const pending=race.answer(user,{id:run.id,turn:run.turn,picks:picks(run)});
  let waiting=false;
  try {
    for(let tries=0;tries<100;tries++){
      const {rows}=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'");
      if(rows.length){waiting=true;break;}
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(waiting,true);
    await probe.query('BEGIN');
    await probe.query('SELECT id FROM public.users WHERE id=$1 FOR UPDATE NOWAIT',[user.id]);
    await probe.query('ROLLBACK');
  } finally {
    await probe.query('ROLLBACK');probe.release();
    await finalizer.query('ROLLBACK');finalizer.release();
  }
  const result=await pending;
  assert.equal(result.run.live,false);assert.equal(result.run.score,0);
});
