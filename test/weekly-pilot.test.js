'use strict';

const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {Pool} = require('pg');
const {createWeeklyRace} = require('../lib/weeklyRace');
const {createMonetagRewards} = require('../lib/monetagRewards');

const port = Number(process.env.JIGCOIN_TEST_POSTGRES_PORT);
const integration = port ? test : test.skip;
const dbName = 'jigcoin_pilot_test_' + process.pid;
const options = {host:'127.0.0.1', port, user:process.env.USER || 'agent', ssl:false};
let admin, pool, pilot, players, now;
const clock = () => now;
const env = {JIGCOIN_INSTALL_PILOT_SCHEMA:'1'};
async function transaction(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const value = await fn(c);
    await c.query('COMMIT');
    return value;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally { c.release(); }
}
function makePilot(settings=env) {
  return createWeeklyRace({pool, withTransaction:transaction, env:settings, clock});
}
function match(turn, want=true) {
  for (let i=0; i<6; i++) {
    for (let j=i+1; j<6; j++) {
      if ((turn.board.tiles[i]+turn.board.tiles[j]===turn.board.target)===want) return [i,j];
    }
  }
  throw Error('No matching pair');
}
const play = (u,r,picks) => pilot.answer(u,{id:r.id, turn:r.turn, picks:picks || match(r)});

before(async () => {
  if (!port) return;
  now = Date.parse('2026-11-18T19:00:00Z');
  admin = new Pool({...options, database:'postgres'});
  await admin.query('CREATE DATABASE '+dbName);
  pool = new Pool({...options, database:dbName});
  await pool.query(`
    DO $$ BEGIN
      PERFORM pg_advisory_xact_lock(14142025);
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    CREATE SCHEMA jigcoin_internal;
    CREATE TABLE public.users(id bigint PRIMARY KEY, telegram_id bigint, username text, first_name text,
      balance bigint DEFAULT 17800, vip_until timestamptz, banned_until timestamptz, is_system_user boolean DEFAULT false);
    CREATE TABLE jigcoin_internal.acquisition_v13(user_id bigint PRIMARY KEY, excluded boolean DEFAULT false);
    CREATE TABLE jigcoin_internal.purchase_receipts_v13(user_id bigint, product text, stars int,
      charge_id text, paid_at timestamptz, refunded_at timestamptz);
    INSERT INTO public.users(id,telegram_id,username) SELECT n,n+1000,'Player '||n FROM generate_series(1,14) n;
    INSERT INTO jigcoin_internal.acquisition_v13 SELECT id,id>10 FROM public.users;
  `);
  players = (await pool.query('SELECT * FROM public.users ORDER BY id')).rows;
  pilot = makePilot();
});
after(async () => {
  if (pool) await pool.end();
  if (admin) {await admin.query('DROP DATABASE IF EXISTS '+dbName); await admin.end();}
});

integration('a missing schema closes new placements; explicit additive installation is repeatable', async () => {
  const manual = makePilot({});
  assert.equal(await manual.refillAvailable(players[0]),false);
  await assert.rejects(() => manual.profile(players[0]),{status:503});
  await Promise.all([pilot.prepare(),pilot.prepare()]);
  await pool.query(readFileSync(path.join(__dirname,'../sql/migrations/024_revenue_pilot.sql'),'utf8'));
  const privileges = await pool.query("SELECT has_table_privilege('anon','jigcoin_internal.weekly_runs_v14','SELECT') AS exposed");
  assert.equal(privileges.rows[0].exposed,false);
  assert.equal((await pilot.profile(players[0])).refill,true);
});
integration('three timed runs share one score per turn and resume safely after a retry', async () => {
  const [me, rival] = players;
  const key = randomUUID();
  const start = req => pilot.start(me,{request_key:req});
  const results = await Promise.all([start(key),start(key),start(randomUUID())]);
  const run = results[0].run;
  assert.ok(results.every(r => r.run.id === run.id));
  assert.equal(run.slot,1);
  const answered = await Promise.all([play(me,run),play(me,run)]);
  assert.ok(answered.every(r => r.run.score===1));
  assert.equal(answered.filter(r=>r.correct===true).length,1);
  const advanced = await play(me,answered[0].run,match(answered[0].run,false));
  assert.equal(advanced.correct,false); assert.equal(advanced.run.turn,2);
  await assert.rejects(() => play(rival,run),{code:'RUN_UNAVAILABLE'});
  const competing = (await pilot.start(rival,{request_key:randomUUID()})).run;
  assert.deepEqual([...competing.board.tiles].sort(),[...run.board.tiles].sort());
  assert.equal(competing.board.target,run.board.target);
  await play(rival,competing);
  const meStanding = await pilot.standings(me,{});
  const standings = await pilot.standings(rival,{rival:meStanding.share_code});
  assert.equal(standings.rival.score,1); assert.equal(standings.rival.me,false);
  assert.deepEqual(standings.leaders.map(r=>r.place),[1,1]);
  now += 46000;
  assert.equal((await play(me,advanced.run)).run.live,false);
  assert.equal((await start(key)).run.slot,1);
  assert.equal((await start(randomUUID())).run.slot,2);
  now += 46000;
  assert.equal((await start(randomUUID())).run.slot,3);
  now += 46000;
  await assert.rejects(() => start(randomUUID()),{code:'RUNS_USED'});
  now=Date.parse('2026-11-22T23:59:45Z');
  await assert.rejects(() => pilot.start(players[2],{request_key:randomUUID()}),{code:'WEEK_CLOSING'});
  now=Date.parse('2026-11-23T00:00:02Z');
  const next=await pilot.standings(me,{rival:meStanding.share_code});
  assert.equal(next.runs_left,3);assert.equal(next.rival.week,'2026-11-16');
  assert.deepEqual((await pilot.profile(me)).medals,[{week:'2026-11-16',score:1}]);
  assert.deepEqual((await pilot.profile(rival)).medals,[{week:'2026-11-16',score:1}]);
  assert.equal((await start(randomUUID())).run.slot,1);
  assert.equal((await pool.query('SELECT min(balance) AS balance FROM public.users')).rows[0].balance,'17800');
});
integration('VIP artwork requires active entitlement and disappears on expiry or refund', async () => {
  const u=players[2];
  await assert.rejects(() => pilot.profile(u,true),{code:'VIP_REQUIRED'});
  const paid=(await pool.query("UPDATE public.users SET vip_until=clock_timestamp()+interval '400 days' WHERE id=$1 RETURNING *",[u.id])).rows[0];
  assert.equal((await pilot.profile(paid,true)).vip_coin,true);
  assert.equal((await pilot.dress([u]))[0].vip_coin,true);
  const refunded=(await pool.query('UPDATE public.users SET vip_until=NULL WHERE id=$1 RETURNING *',[u.id])).rows[0];
  assert.equal((await pilot.profile(refunded)).vip_coin,false);
  assert.equal((await pilot.dress([u]))[0].vip_coin,false);
});
integration('new enrolments split only when enabled; existing assignments and payouts persist', async () => {
  const arms=makePilot({...env,JIGCOIN_REFILL_TEST:'1'});
  assert.equal((await arms.enroll(players[0])).ad_group,'baseline');
  const rows=await Promise.all(players.slice(3).map(u=>arms.enroll(u)));
  assert.deepEqual([...new Set(rows.map(r=>r.ad_group))].sort(),['holdout','refill']);
  const held=players[3+rows.findIndex(r=>r.ad_group==='holdout')];
  assert.equal(await pilot.refillAvailable(held),false);
  const rewards=createMonetagRewards({pool,withTransaction:transaction,pilot:arms,
    env:{MONETAG_REWARDS_ENABLED:'1',MONETAG_ZONE_ID:'123',MONETAG_POSTBACK_SECRET:'a'.repeat(32)}});
  for(const code of ['sp_double_points','sp_visit_partner','sp_emergency_energy'])
    await assert.rejects(()=>rewards.start(held,code),{code:'AD_PLACEMENT_CLOSED'});
});
integration('scorecard excludes owner accounts and only values evidenced, complete cohorts', async () => {
  await pool.query("UPDATE jigcoin_internal.pilot_players_v14 SET enrolled_at=now()-interval '32 days' WHERE user_id=1");
  await pool.query("INSERT INTO jigcoin_internal.purchase_receipts_v13 VALUES (1,'vip',500,'test',now()-interval '30 days',NULL)");
  const query=readFileSync(path.join(__dirname,'../sql/pilot_scorecard_v14.sql'),'utf8');
  const [before]=await pool.query(query);
  const complete=before.rows.find(r=>r.window_complete);
  assert.equal(complete.vip_purchases,'1');
  assert.equal(complete.contribution_after_acquisition_per_player_gbp,null);
  assert.equal(before.rows.reduce((n,r)=>n+Number(r.players),0),10);
  await pool.query(`INSERT INTO jigcoin_internal.pilot_finance_v14
    SELECT (enrolled_at AT TIME ZONE 'UTC')::date,ad_group,4,0.2,0.3,1,'fixture only'
    FROM jigcoin_internal.pilot_players_v14 WHERE user_id=1`);
  const [after,events]=await pool.query(query);
  assert.equal(after.rows.find(r=>r.window_complete).contribution_after_acquisition_per_player_gbp,'2.9000');
  assert.ok(events.rows.some(r=>r.entrants==='2' && r.returned_next_week==='1'));
});
integration('verified v13 coin awards survive retirement; low-energy refill credits only once', async () => {
  const {ALL_CODES} = require('../lib/monetagRewards');
  const {applyBalanceChangeTx} = require('../lib/ledger');
  const dir=path.join(__dirname,'../sql/migrations');
  await pool.query(`ALTER TABLE public.users ADD energy integer DEFAULT 0, ADD max_energy integer DEFAULT 50,
      ADD last_energy_ts timestamptz, ADD double_boost_until timestamptz;
    CREATE TABLE public.missions(id serial PRIMARY KEY, code text UNIQUE, kind text, is_active boolean DEFAULT true);
    CREATE TABLE public.user_missions(user_id bigint,mission_id integer,status text,started_at timestamptz,
      completed_at timestamptz,verified_at timestamptz,claimed_at timestamptz,reward_applied boolean,UNIQUE(user_id,mission_id));
    CREATE TABLE public.user_balance_ledger(id bigserial PRIMARY KEY,user_id bigint,delta bigint,reason text,
      ref_type text,ref_id bigint,event_type text);`);
  for (const code of ALL_CODES) await pool.query("INSERT INTO public.missions(code,kind) VALUES($1,'sponsor')",[code]);
  for (const name of ['006_monetag_rewards.sql','007_seven_verified_rewards.sql'])
    await pool.query(readFileSync(path.join(dir,name),'utf8'));
  // Apply the actual cooldown compatibility block from the accepted v13 migration.
  const previous = readFileSync(path.join(dir,'023_release_readiness_v13.sql'),'utf8');
  const from = previous.indexOf('DO $$ DECLARE definition text;');
  await pool.query(previous.slice(from,previous.indexOf('END $$;',from)+7));
  const mockSettings = {MONETAG_REWARDS_ENABLED:'1',MONETAG_ZONE_ID:'123',MONETAG_POSTBACK_SECRET:'a'.repeat(32)};
  const oldService = createMonetagRewards({pool,withTransaction:transaction,applyBalanceChangeTx,env:mockSettings});
  const current = createMonetagRewards({pool,withTransaction:transaction,applyBalanceChangeTx,env:mockSettings,pilot});
  const user=players[0], coin='sp_visit_partner', refill='sp_emergency_energy';
  const old = await oldService.start(user,coin);
  const confirm = attempt => current.postback({secret:mockSettings.MONETAG_POSTBACK_SECRET,
    ymid:attempt.ymid,zone_id:'123',sub_zone_id:'123',telegram_id:String(user.telegram_id),
    request_var:attempt.request_var,event_type:'impression',reward_event_type:'valued',estimated_price:'0.003'});
  await assert.rejects(()=>current.start(user,coin),{code:'AD_PLACEMENT_CLOSED'});
  await confirm(old);
  const cards=await current.decorateMissions(user,[{code:coin,kind:'sponsor'},{code:refill,kind:'sponsor'}]);
  assert.equal(cards[0].status,'claimable');
  const credits=await Promise.all([current.claim(user,coin,old.ymid),current.claim(user,coin,old.ymid)]);
  assert.equal(credits.filter(x=>x.already_claimed).length,1);
  await pool.query('UPDATE public.users SET energy=11 WHERE id=$1',[user.id]);
  await assert.rejects(()=>current.start(user,refill),{code:'ENERGY_ABOVE_REFILL_THRESHOLD'});
  await pool.query('UPDATE public.users SET energy=10 WHERE id=$1',[user.id]);
  const attempt=await current.start(user,refill);
  await assert.rejects(()=>current.claim(user,refill,attempt.ymid),{code:'AD_CONFIRMATION_PENDING'});
  await confirm(attempt);
  const refills=await Promise.all([current.claim(user,refill,attempt.ymid),current.claim(user,refill,attempt.ymid)]);
  assert.equal(refills.filter(x=>x.already_claimed).length,1);
  const saved=(await pool.query('SELECT balance,energy FROM public.users WHERE id=$1',[user.id])).rows[0];
  assert.equal(saved.balance,'18000'); assert.equal(saved.energy,50);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.user_balance_ledger')).rows[0].n,1);
});
