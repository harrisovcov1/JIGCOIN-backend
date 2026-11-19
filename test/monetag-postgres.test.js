"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { createMonetagRewards, CODES, ALL_CODES, BOOST_CODES } = require("../lib/monetagRewards");
const { applyBalanceChangeTx } = require("../lib/ledger");
const { startIsolatedApp, signedInitData } = require("./helpers/httpApp.cjs");

// Opt-in, isolated PostgreSQL only: creates a NEW disposable database on loopback.
// Never reads DATABASE_URL, customer rows, a backup or provider credentials.
const port = Number(process.env.JIGCOIN_TEST_POSTGRES_PORT || 0);
const pgTest = port ? test : test.skip;
const database = `jigcoin_rewards_test_${process.pid}`;
let admin, pool, rewards, user, other;
const env = { MONETAG_ZONE_ID: "12257359", MONETAG_POSTBACK_SECRET: "a".repeat(64), MONETAG_REWARDS_ENABLED: "1" };
const transaction = async fn => {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
};
const service = (extra = {}) => createMonetagRewards({ pool, withTransaction: transaction, applyBalanceChangeTx, env, ...extra });
const event = (a, extra = {}) => ({ secret: env.MONETAG_POSTBACK_SECRET, ymid: a.ymid, zone_id: env.MONETAG_ZONE_ID,
  sub_zone_id: env.MONETAG_ZONE_ID, telegram_id: String(user.telegram_id), request_var: a.request_var,
  event_type: "impression", reward_event_type: "valued", estimated_price: "0.0037000", ...extra });
const counts = async () => (await pool.query(`SELECT
  (SELECT count(*)::int FROM public.user_balance_ledger) AS ledger,
  (SELECT balance::text FROM public.users WHERE id=$1) AS balance,
  (SELECT count(*)::int FROM jigcoin_internal.monetag_events) AS receipts`, [user.id])).rows[0];

before(async () => {
  if (!port) return;
  const connection = { host: "127.0.0.1", port, user: process.env.USER || "agent", ssl: false };
  admin = new Pool({ ...connection, database: "postgres" });
  await admin.query(`CREATE DATABASE ${database}`);
  pool = new Pool({ ...connection, database, max: 16 });
  await pool.query(`
    CREATE TABLE public.users (id bigserial PRIMARY KEY, telegram_id bigint NOT NULL, balance bigint NOT NULL DEFAULT 0,
      energy integer DEFAULT 0,max_energy integer DEFAULT 50,last_energy_ts timestamptz DEFAULT now(),double_boost_until timestamptz,
      today_farmed integer DEFAULT 0,taps_today integer DEFAULT 0,last_reset date DEFAULT CURRENT_DATE,last_tap_at timestamptz,
      streak_count integer DEFAULT 0,vip_until timestamptz,banned_until timestamptz);
    CREATE TABLE public.tap_packets(packet_id text PRIMARY KEY,telegram_id bigint NOT NULL);
    CREATE TABLE public.missions (id serial PRIMARY KEY, code text NOT NULL UNIQUE, kind text, is_active boolean DEFAULT true,
      sponsor_claims_today integer DEFAULT 1,max_claims_per_day integer DEFAULT 1,cooldown_hours integer DEFAULT 24);
    CREATE TABLE public.user_missions (id serial PRIMARY KEY,user_id integer REFERENCES public.users(id),mission_id integer REFERENCES public.missions(id),
      status text,started_at timestamptz,completed_at timestamptz,verified_at timestamptz,claimed_at timestamptz,reward_applied boolean,
      UNIQUE(user_id,mission_id));
    CREATE TABLE public.user_balance_ledger (id bigserial PRIMARY KEY,user_id integer REFERENCES public.users(id),delta bigint,reason text,ref_type text,ref_id bigint,event_type text);
    CREATE TABLE public.event_log(id bigserial PRIMARY KEY,user_id bigint REFERENCES public.users(id),event text,meta jsonb,created_at timestamptz DEFAULT clock_timestamp());
    DO $$ BEGIN PERFORM pg_advisory_xact_lock(14142025); IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
  `);
  for (const code of ALL_CODES) await pool.query("INSERT INTO public.missions(code,kind) VALUES($1,'sponsor')",[code]);
  const migration = fs.readFileSync(path.join(__dirname, "../sql/migrations/006_monetag_rewards.sql"), "utf8");
  await pool.query(migration);
  await pool.query(migration); // Restart-safe additive migration.
  const expansion=fs.readFileSync(path.join(__dirname,"../sql/migrations/007_seven_verified_rewards.sql"),"utf8");
  await pool.query(expansion); await pool.query(expansion);
  // Model the deployed v11 tap and v13 cooldown data contract on this minimal database.
  await pool.query(`
    ALTER TABLE jigcoin_internal.tap_claims ADD COLUMN vip_bonus bigint DEFAULT 0;
    CREATE TABLE jigcoin_internal.tap_fraction(user_id bigint PRIMARY KEY REFERENCES public.users,units integer NOT NULL);
    CREATE TABLE jigcoin_internal.vip_tap_stats_v11(user_id bigint PRIMARY KEY REFERENCES public.users,bonus_coins bigint NOT NULL,fraction_units integer NOT NULL);
    ALTER TABLE jigcoin_internal.ad_attempts DROP CONSTRAINT ad_attempts_cooldown_seconds_check;
    ALTER TABLE jigcoin_internal.ad_attempts ADD CONSTRAINT ad_attempts_cooldown_policy CHECK(cooldown_seconds=86400
      OR (reward_kind IN ('energy_refill','double_10m') AND cooldown_seconds=3600)
      OR (reward_kind IN ('coins','energy_refill') AND cooldown_seconds=300)
      OR (reward_kind='double_10m' AND cooldown_seconds=1800));
    ALTER TABLE jigcoin_internal.vip_tap_stats_v11 ENABLE ROW LEVEL SECURITY;
    ALTER TABLE jigcoin_internal.tap_fraction ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.users ADD COLUMN is_system_user boolean DEFAULT false;
  `);
  await pool.query(`CREATE TRIGGER trg_enforce_daily_sponsor_cap BEFORE UPDATE OF claimed_at ON public.user_missions
    FOR EACH ROW EXECUTE FUNCTION public.enforce_daily_sponsor_cap()`);
  await pool.query(`
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;
    CREATE TABLE jigcoin_internal.acquisition_v13(user_id bigint PRIMARY KEY REFERENCES public.users(id),excluded boolean DEFAULT FALSE);
    CREATE TABLE jigcoin_internal.pilot_players_v14(user_id bigint PRIMARY KEY REFERENCES public.users(id),ad_group text NOT NULL);
    CREATE TABLE jigcoin_internal.purchase_receipts_v13(user_id bigint REFERENCES public.users(id),product text,stars integer,charge_id text,paid_at timestamptz,refunded_at timestamptz);
    ALTER TABLE jigcoin_internal.acquisition_v13 ENABLE ROW LEVEL SECURITY;
    ALTER TABLE jigcoin_internal.pilot_players_v14 ENABLE ROW LEVEL SECURITY;
    ALTER TABLE jigcoin_internal.purchase_receipts_v13 ENABLE ROW LEVEL SECURITY;
  `);
  const refillPolicy=fs.readFileSync(path.join(__dirname,'../sql/migrations/20261119152941_refill_policy_trial.sql'),'utf8');
  await pool.query(refillPolicy); await pool.query(refillPolicy);
});
beforeEach(async () => {
  if (!port) return;
  await pool.query("TRUNCATE jigcoin_internal.tap_claims,public.tap_packets,jigcoin_internal.monetag_events,jigcoin_internal.ad_attempts,jigcoin_internal.reward_placements,public.user_missions,public.user_balance_ledger,public.users,public.missions RESTART IDENTITY CASCADE");
  for (const code of ALL_CODES) await pool.query("INSERT INTO public.missions(code,kind) VALUES($1,'sponsor')", [code]);
  [user, other] = (await pool.query("INSERT INTO public.users(telegram_id) VALUES(10001),(10002) RETURNING *")).rows;
  rewards = service();
});
after(async () => {
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database}`); await admin.end(); }
});

pgTest("only server-owned placements can create attempts; no secret is exposed", async () => {
  await assert.rejects(rewards.start(user, "arbitrary"), { code: "INVALID_REWARD_PLACEMENT" });
  const a = await rewards.start(user, CODES[0]);
  assert.equal(a.payout_amount, 200);
  assert.ok(!JSON.stringify(a).includes(env.MONETAG_POSTBACK_SECRET));
  await assert.rejects(rewards.start(user, CODES[0]), { code: "AD_RETRY_LATER" });
  await assert.rejects(rewards.claim(user, CODES[0], a.ymid), { code: "AD_CONFIRMATION_PENDING" });
  assert.deepEqual(await counts(), { ledger: 0, balance: "0", receipts: 0 });
});

pgTest("a verified coin advert begun before retirement is still redeemable once through the signed recovery routes", async t => {
  const prior = await rewards.start(user, CODES[0]);
  const appEnv = { ...env, RECOVERY_TEST_ENABLED:"1", RECOVERY_TEST_TELEGRAM_ID:String(user.telegram_id),
    MONETAG_REWARDS_ENABLED:"0", DISABLE_AD_REWARDS:"1", DISABLE_SPONSOR_MISSIONS:"1", DISABLE_WITHDRAWALS:"1" };
  const options = {pool, withTransaction:transaction, ledger:{applyBalanceChangeTx}, env:appEnv};
  const app = await startIsolatedApp(t, true, options);
  const post = async (endpoint, body={}) => {
    const r = await fetch(app.url+endpoint, {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({initData:signedInitData(Number(user.telegram_id)),...body})});
    return {status:r.status,body:await r.json()};
  };
  const start = await post("/api/mission/start",{code:CODES[0]});
  assert.equal(start.status,409);
  assert.equal(start.body.error,"AD_PLACEMENT_CLOSED");
  const callback = await fetch(app.url+"/postback/monetag?"+new URLSearchParams(event(prior)));
  assert.equal(callback.status,200);
  const list = await post("/api/mission/list");
  assert.equal(list.body.missions.find(m=>m.code===CODES[0]).status,"claimable");
  const claims = await Promise.all(Array.from({length:4},()=>post("/api/mission/complete",{code:CODES[0],attempt_id:prior.ymid})));
  assert.ok(claims.every(c=>c.status===200));
  assert.equal(claims.filter(c=>!c.body.already_claimed).length,1);
  assert.deepEqual(await counts(),{ledger:1,balance:"200",receipts:1});
});

pgTest("bad/missing secrets, wrong zone, wrong owner and malformed macros cannot confirm", async () => {
  const a = await rewards.start(user, CODES[0]);
  for (const patch of [{ secret: "" }, { secret: "é".repeat(64) }, { secret: [env.MONETAG_POSTBACK_SECRET] },
    { zone_id: "123" }, { sub_zone_id: "123" }, { telegram_id: String(other.telegram_id) },
    { request_var: CODES[1] }, { estimated_price: "NaN" }, { event_type: "closed" }, { reward_event_type: "true" },
    { ymid: crypto.randomUUID() }]) {
    await assert.rejects(rewards.postback(event(a, patch)));
  }
  assert.equal((await counts()).receipts, 0);
  await assert.rejects(rewards.claim(user, CODES[0], a.ymid), { code: "AD_CONFIRMATION_PENDING" });
});

pgTest("non-valued events persist but cannot unlock Claim; valued upgrade can", async () => {
  const a = await rewards.start(user, CODES[0]);
  await rewards.postback(event(a, { reward_event_type: "non_valued", estimated_price: "0" }));
  await assert.rejects(rewards.claim(user, CODES[0], a.ymid), { code: "AD_CONFIRMATION_PENDING" });
  await rewards.postback(event(a, { telegram_id: "" }));
  await rewards.claim(user, CODES[0], a.ymid);
  assert.deepEqual(await counts(), { ledger: 1, balance: "200", receipts: 2 });
});

pgTest("parallel callbacks and claims credit exactly once and persist a shared five-minute cooldown", async () => {
  const a = await rewards.start(user, CODES[0]);
  await Promise.all(Array.from({ length: 12 }, (_, i) => rewards.postback(event(a, { event_type: i % 2 ? "click" : "impression" }))));
  const claims = await Promise.all(Array.from({ length: 12 }, () => rewards.claim(user, CODES[0], a.ymid)));
  assert.equal(claims.filter(c => !c.already_claimed).length, 1);
  assert.deepEqual(await counts(), { ledger: 1, balance: "200", receipts: 2 });
  const [m] = await service().decorateMissions(user, [{code: CODES[0],kind: "sponsor"}]);
  assert.equal(m.status, "cooldown");
  assert.ok(m.cooldown_remaining_seconds >= 298 && m.cooldown_remaining_seconds <= 300);
  await assert.rejects(rewards.start(user, CODES[0]), { code: "MISSION_COOLDOWN" });
  await assert.rejects(rewards.start(user, CODES[1]), { code: "REWARD_PLACEMENT_RETIRED" });
});

pgTest("a different user cannot claim an eligible attempt", async () => {
  const a = await rewards.start(user, CODES[0]);
  await rewards.postback(event(a));
  await assert.rejects(rewards.claim(other, CODES[0], a.ymid), { code: "AD_ATTEMPT_NOT_FOUND" });
  assert.equal((await counts()).ledger, 0);
});

pgTest("failed postback persistence does not acknowledge success or leave a claimable reward", async () => {
  const a=await rewards.start(user,CODES[0]);
  const failing=service({withTransaction: fn=>transaction(async client=>{
    await fn(client); throw Error("simulated failure before commit");
  })});
  await assert.rejects(failing.postback(event(a)));
  assert.equal((await counts()).receipts,0);
  await assert.rejects(rewards.claim(user,CODES[0],a.ymid),{code:"AD_CONFIRMATION_PENDING"});
  await rewards.postback(event(a));
  await rewards.claim(user,CODES[0],a.ymid);
  assert.equal((await counts()).ledger,1);
});

pgTest("a transaction failure rolls back the ledger, balance and cooldown; retry succeeds once", async () => {
  const a = await rewards.start(user, CODES[0]);
  await rewards.postback(event(a));
  const failing = service({ applyBalanceChangeTx: async (client, args) => {
    await applyBalanceChangeTx(client, args); throw Error("simulated crash after credit");
  } });
  await assert.rejects(failing.claim(user, CODES[0], a.ymid));
  assert.deepEqual(await counts(), { ledger: 0, balance: "0", receipts: 1 });
  await rewards.claim(user, CODES[0], a.ymid);
  assert.equal((await counts()).balance, "200");
});

pgTest("legacy claim dates survive cutover, but legacy timer starts never become claimable", async () => {
  await pool.query("INSERT INTO public.user_missions(user_id,mission_id,claimed_at) VALUES($1,1,now()-interval '1 minute')", [user.id]);
  const [m] = await rewards.decorateMissions(user, [{code: CODES[0],kind:"sponsor"}]);
  assert.equal(m.status, "cooldown");
  await assert.rejects(rewards.start(user, CODES[0]), { code: "MISSION_COOLDOWN" });
  await assert.rejects(pool.query("UPDATE public.user_missions SET claimed_at=now()"), {code:"P0001"});
  await pool.query("DELETE FROM public.user_missions");
  await pool.query("INSERT INTO public.user_missions(user_id,mission_id,started_at) VALUES($1,1,now()-interval '1 hour')", [user.id]);
  const [fresh] = await rewards.decorateMissions(user, [{code: CODES[0],kind:"sponsor",status:"claimable"}]);
  assert.equal(fresh.status, "available");
  await assert.rejects(rewards.claim(user, CODES[0], undefined), { code: "AD_ATTEMPT_REQUIRED" });
});

pgTest("no-fill retry uses a new ymid; multiple eligible attempts cannot be banked across cycles", async () => {
  const a = await rewards.start(user, CODES[0]);
  await pool.query("UPDATE jigcoin_internal.ad_attempts SET created_at=now()-interval '61 seconds'");
  const b = await rewards.start(user, CODES[0]);
  assert.notEqual(a.ymid, b.ymid);
  await rewards.postback(event(a));
  await rewards.postback(event(b));
  await rewards.claim(user, CODES[0], b.ymid);
  await pool.query("ALTER TABLE public.user_missions DISABLE TRIGGER trg_enforce_daily_sponsor_cap");
  await pool.query("UPDATE public.user_missions SET claimed_at=now()-interval '6 minutes'");
  await pool.query("ALTER TABLE public.user_missions ENABLE TRIGGER trg_enforce_daily_sponsor_cap");
  await pool.query("UPDATE jigcoin_internal.reward_placements SET claimed_at=now()-interval '6 minutes',next_available_at=now()-interval '1 second'");
  const c = await rewards.start(user, CODES[0]);
  await assert.rejects(rewards.claim(user, CODES[0], a.ymid), { code: "AD_ATTEMPT_EXPIRED" });
  await rewards.postback(event(c));
  await rewards.claim(user, CODES[0], c.ymid);
  assert.equal((await counts()).balance, "400");
});

pgTest("delayed confirmation survives restart and kill switch; expired attempts do not unlock", async () => {
  const a = await rewards.start(user, CODES[0]);
  await pool.query("UPDATE jigcoin_internal.ad_attempts SET created_at=now()-interval '31 hours'");
  const disabled = service({ env: { ...env, DISABLE_AD_REWARDS: "1" } });
  await disabled.postback(event(a));
  await assert.rejects(disabled.claim(user, CODES[0], a.ymid), { code: "AD_REWARDS_UNAVAILABLE" });
  const [m] = await service().decorateMissions(user, [{code: CODES[0],kind:"sponsor"}]);
  assert.equal(m.status, "claimable");
  const b = await rewards.start(user, BOOST_CODES[0]);
  await pool.query("UPDATE jigcoin_internal.ad_attempts SET expires_at=now()-interval '1 second' WHERE ymid=$1", [b.ymid]);
  await rewards.postback(event(b));
  await assert.rejects(rewards.claim(user, BOOST_CODES[0], b.ymid), { code: "AD_ATTEMPT_EXPIRED" });
});

pgTest("browser Supabase roles cannot read or write reward receipts", async () => {
  const client = await pool.connect();
  try {
    for (const role of ["anon", "authenticated"]) {
      await client.query(`SET ROLE ${role}`);
      await assert.rejects(client.query("SELECT * FROM jigcoin_internal.ad_attempts"), { code: "42501" });
      await assert.rejects(client.query("INSERT INTO jigcoin_internal.reward_placements(user_id,code,cycle_id) VALUES(1,'x',gen_random_uuid())"), { code:"42501" });
      await client.query("RESET ROLE");
    }
  } finally { await client.query("RESET ROLE"); client.release(); }
});

pgTest("RLS blocks browser access even if schema and table grants are accidentally restored", async () => {
  await rewards.start(user, CODES[0]);
  const flags = (await pool.query(`SELECT relrowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='jigcoin_internal' AND c.relkind='r'`)).rows;
  assert.equal(flags.length,12);
  assert.ok(flags.every(r=>r.relrowsecurity));
  const client=await pool.connect();
  try {
    for(const role of ["anon","authenticated"]) {
      await client.query("BEGIN");
      await client.query(`GRANT USAGE ON SCHEMA jigcoin_internal TO ${role}`);
      await client.query(`GRANT SELECT ON jigcoin_internal.ad_attempts TO ${role}`);
      await client.query(`GRANT INSERT ON jigcoin_internal.reward_placements TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      assert.equal((await client.query("SELECT * FROM jigcoin_internal.ad_attempts")).rowCount,0);
      await assert.rejects(client.query(`INSERT INTO jigcoin_internal.reward_placements
        (user_id,code,cycle_id) VALUES($1,'untrusted',gen_random_uuid())`,[user.id]),
        e=>e.code==='42501' && /row-level security/.test(e.message));
      await client.query("ROLLBACK"); // Restores both original grants and role.
    }
  } finally { await client.query("ROLLBACK"); client.release(); }
});

pgTest("all three placements fulfill exactly once; boost receipts never add coin ledger entries", async () => {
  const {createGameplay}=require("../lib/gameplay");
  const gameplay=createGameplay({pool,withTransaction:transaction,applyBalanceChangeTx,getEnergyCap:()=>50});
  for (const code of [CODES[0],...BOOST_CODES]) {
    const a=await rewards.start(user,code);
    await assert.rejects(rewards.claim(user,code,a.ymid),{code:"AD_CONFIRMATION_PENDING"});
    await Promise.all(Array.from({length:5},()=>rewards.postback(event(a))));
    const claims=await Promise.all(Array.from({length:8},()=>rewards.claim(user,code,a.ymid)));
    assert.equal(claims.filter(c=>!c.already_claimed).length,1,code);
  }
  const c=await counts();assert.equal(c.balance,"200");assert.equal(c.ledger,1);assert.equal(c.receipts,3);
  const fresh=(await pool.query("SELECT *,clock_timestamp() AS db_now FROM public.users WHERE id=$1",[user.id])).rows[0];
  assert.equal(fresh.energy,50);
  const seconds=(new Date(fresh.double_boost_until)-new Date(fresh.db_now))/1000;
  assert.ok(seconds>595 && seconds<=600);
  const packet={packet_id:crypto.randomUUID(),count:3};
  const taps=await Promise.all(Array.from({length:6},()=>gameplay.tap(user,packet)));
  assert.equal(taps.filter(t=>!t.response.duplicate).length,1);
  assert.equal(taps[0].response.gained,6);
  const after=(await pool.query("SELECT balance,energy FROM public.users WHERE id=$1",[user.id])).rows[0];
  assert.equal(after.balance,"206");assert.equal(after.energy,47);
  assert.ok((await rewards.decorateMissions(user,ALL_CODES.map(code=>({code,kind:"sponsor"})))).every(m=>m.status==="cooldown"));
});
pgTest("boost rollback does not consume its receipt or apply a partial boost",async()=>{
  for (const code of BOOST_CODES) {
    const a=await rewards.start(user,code);await rewards.postback(event(a));
    const broken=service({withTransaction:fn=>transaction(async client=>{await fn(client);throw Error("rollback");})});
    await assert.rejects(broken.claim(user,code,a.ymid));
    assert.equal((await pool.query("SELECT claimed_at FROM jigcoin_internal.ad_attempts WHERE ymid=$1",[a.ymid])).rows[0].claimed_at,null);
    assert.equal((await pool.query("SELECT energy FROM public.users WHERE id=$1",[user.id])).rows[0].energy,0);
    await rewards.claim(user,code,a.ymid);
    if(code===BOOST_CODES[0])await pool.query("UPDATE public.users SET energy=0 WHERE id=$1",[user.id]);
  }
});
pgTest("tap failure retries safely, concurrent packets cannot spend the same energy, and expired x2 is ignored",async()=>{
  const {createGameplay}=require("../lib/gameplay");
  const settings={pool,withTransaction:transaction,applyBalanceChangeTx,getEnergyCap:()=>50};
  const gameplay=createGameplay(settings);
  await pool.query("UPDATE public.users SET energy=5,last_energy_ts=now(),double_boost_until=now()-interval '1 second' WHERE id=$1",[user.id]);
  const packet={packet_id:crypto.randomUUID(),count:4};
  const broken=createGameplay({...settings,applyBalanceChangeTx:async(c,a)=>{await applyBalanceChangeTx(c,a);throw Error("fail");}});
  await assert.rejects(broken.tap(user,packet));assert.equal((await counts()).balance,"0");
  const results=await Promise.all([gameplay.tap(user,packet),gameplay.tap(user,{packet_id:crypto.randomUUID(),count:4})]);
  assert.equal(results.reduce((n,r)=>n+r.response.applied,0),5);
  assert.equal((await counts()).balance,"5");
  await assert.rejects(gameplay.tap(user,{...packet,count:1}),{code:"PACKET_CONTENT_MISMATCH"});
  assert.equal((await pool.query("SELECT energy FROM public.users WHERE id=$1",[user.id])).rows[0].energy,0);
});
pgTest("full energy and an active double boost do not start unnecessary ads",async()=>{
 await pool.query("UPDATE public.users SET energy=50,double_boost_until=now()+interval '10 minutes' WHERE id=$1",[user.id]);
 await assert.rejects(rewards.start(user,BOOST_CODES[0]),{code:"ENERGY_FULL"});
 await assert.rejects(rewards.start(user,BOOST_CODES[1]),{code:"DOUBLE_ACTIVE"});
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM jigcoin_internal.ad_attempts")).rows[0].n,0);
});

const refillCode = BOOST_CODES[0];
const refillVersion = 'refill-v15-20261119';
async function assigned(player, seconds) {
  await pool.query(`INSERT INTO jigcoin_internal.refill_cohorts_v15
    (user_id,policy_version,cohort,cooldown_seconds)
    VALUES($1,$2,$3,$4)`, [player.id,refillVersion,seconds===120?'treatment_120':'control_300',seconds]);
}
const refillMission = player => service().decorateMissions(player,[{code:refillCode,kind:'sponsor'}]).then(rows=>rows[0]);

pgTest('startup readiness requires the installed refill schema',async()=>{
  await service().assertReady();
  await pool.query('ALTER TABLE jigcoin_internal.refill_finance_v15 RENAME TO refill_finance_missing');
  try{await assert.rejects(service().assertReady(),{code:'INSTALL_REFILL_V15_MIGRATION',status:503});}
  finally{await pool.query('ALTER TABLE jigcoin_internal.refill_finance_missing RENAME TO refill_finance_v15');}
});

pgTest('refill trial assignments persist without changing previous pilot groups; QA is excluded', async()=>{
  const {createRefillPolicy}=require('../lib/refillPolicy');
  const policy=createRefillPolicy({pool,env:{}});
  await pool.query("INSERT INTO jigcoin_internal.pilot_players_v14 VALUES($1,'holdout'),($2,'refill')",[user.id,other.id]);
  const players=[user,other,...(await pool.query('INSERT INTO public.users(telegram_id) SELECT n FROM generate_series(11000,11011) n RETURNING *')).rows];
  const first=await Promise.all(players.map(p=>policy.enroll(p)));
  assert.deepEqual([...new Set(first.map(p=>p.cooldown_seconds))].sort(),[120,300]);
  const restarted=createRefillPolicy({pool,env:{}});
  assert.deepEqual(await Promise.all(players.map(p=>restarted.enroll(p))),first);
  assert.deepEqual((await pool.query('SELECT ad_group FROM jigcoin_internal.pilot_players_v14 ORDER BY user_id')).rows.map(r=>r.ad_group),['holdout','refill']);
  const qa=(await pool.query('INSERT INTO public.users(telegram_id) VALUES(12000) RETURNING *')).rows[0];
  await pool.query('INSERT INTO jigcoin_internal.acquisition_v13 VALUES($1,TRUE)',[qa.id]);
  assert.equal((await policy.enroll(qa)).group,'qa_120');
  assert.equal((await policy.peek(qa.id)).excluded,true);
  const before=first[0];
  await pool.query('INSERT INTO jigcoin_internal.acquisition_v13 VALUES($1,TRUE)',[user.id]);
  assert.deepEqual(await policy.enroll(user),before,'later exclusion must not reassign');
  assert.equal((await policy.peek(user.id)).excluded,true);
  const held=service({pilot:{refillAvailable:async()=>false}});
  await assert.rejects(held.start(user,refillCode),{code:'AD_PLACEMENT_CLOSED'});
});

pgTest('refill preparation works below full energy for caps55 and110 without an attempt retry gate',async()=>{
  for(const cap of [55,110]) {
    const player=(await pool.query('INSERT INTO public.users(telegram_id,energy,max_energy,last_energy_ts) VALUES($1,$2,$3,clock_timestamp()) RETURNING *',[13000+cap,cap,cap])).rows[0];
    let mission=await refillMission(player);
    assert.equal(mission.status,'available'); assert.equal(mission.prepare_available,false);
    assert.equal(mission.refill_policy.offer_threshold_pct,30);
    assert.equal(mission.refill_policy.prepare_threshold_pct,100);
    assert.equal(mission.refill_policy.ready_ttl_ms,300000);
    assert.equal(mission.refill_policy.retry_seconds,0);
    await assert.rejects(service().start(player,refillCode),{code:'ENERGY_FULL'});
    const low=(await pool.query('UPDATE public.users SET energy=$2,last_energy_ts=clock_timestamp() WHERE id=$1 RETURNING *',[player.id,cap-1])).rows[0];
    mission=await refillMission(low);
    assert.equal(mission.prepare_available,true);
    const attempt=await service().start(low,refillCode);
    assert.deepEqual(attempt.refill_policy,mission.refill_policy);
    const saved=(await pool.query('SELECT refill_start_energy,refill_start_cap FROM jigcoin_internal.ad_attempts WHERE ymid=$1',[attempt.ymid])).rows[0];
    assert.deepEqual(saved,{refill_start_energy:cap-1,refill_start_cap:cap});
    mission=await refillMission(low);
    assert.equal(mission.status,'available');
    assert.equal(mission.prepare_available,true,'an unconfirmed attempt does not impose a retry delay');
    assert.equal(mission.retry_after_seconds,0);
  }
});

pgTest('cohort cooldown is atomic and stable: control300 never shortens to treatment120',async()=>{
  for(const [player,seconds] of [[user,300],[other,120]]) {
    await assigned(player,seconds);
    const attempt=await service().start(player,refillCode);
    await service().postback(event(attempt,{telegram_id:String(player.telegram_id)}));
    const claims=await Promise.all(Array.from({length:4},()=>service().claim(player,refillCode,attempt.ymid)));
    assert.equal(claims.filter(c=>!c.already_claimed).length,1);
    assert.equal(claims.find(c=>!c.already_claimed).cooldown_remaining_seconds,seconds);
    await pool.query('UPDATE public.users SET energy=0,last_energy_ts=clock_timestamp() WHERE id=$1',[player.id]);
    await pool.query(`UPDATE jigcoin_internal.reward_placements
      SET claimed_at=clock_timestamp()-interval '130 seconds',
        next_available_at=clock_timestamp()+make_interval(secs=>$2-130) WHERE user_id=$1`,[player.id,seconds]);
    const mission=await refillMission(player);
    assert.equal(mission.cooldown_seconds,seconds);
    if(seconds===300){
      assert.equal(mission.status,'cooldown'); assert.ok(mission.cooldown_remaining_seconds>=169);
      await assert.rejects(service().start(player,refillCode),{code:'MISSION_COOLDOWN'});
    }else{
      assert.equal(mission.status,'available'); assert.equal(mission.prepare_available,true);
      assert.ok((await service().start(player,refillCode)).ymid);
    }
  }
});

pgTest('legacy300/3600/86400 refill receipts remain redeemable with their assigned shorter wait',async()=>{
  for(const [i,legacy] of [300,3600,86400].entries()) {
    const player=(await pool.query('INSERT INTO public.users(telegram_id) VALUES($1) RETURNING *',[14000+i])).rows[0];
    await assigned(player,i===1?300:120);
    const attempt=await service().start(player,refillCode);
    await pool.query(`UPDATE jigcoin_internal.ad_attempts SET cooldown_seconds=$2,refill_policy_version=NULL,
      refill_group=NULL,refill_start_energy=NULL,refill_start_cap=NULL WHERE ymid=$1`,[attempt.ymid,legacy]);
    await service().postback(event(attempt,{telegram_id:String(player.telegram_id)}));
    const result=await service().claim(player,refillCode,attempt.ymid);
    assert.equal(result.cooldown_remaining_seconds,i===1?300:120);
    assert.equal((await pool.query('SELECT cooldown_seconds FROM jigcoin_internal.ad_attempts WHERE ymid=$1',[attempt.ymid])).rows[0].cooldown_seconds,legacy);
    assert.equal((await service().claim(player,refillCode,attempt.ymid)).already_claimed,true);
  }
});

pgTest('migration rejects partial policy snapshots and120-second nonenergy rewards',async()=>{
  const attempt=await service().start(user,refillCode);
  for(const field of ['refill_policy_version','refill_group','refill_start_energy','refill_start_cap'])
    await assert.rejects(pool.query(`UPDATE jigcoin_internal.ad_attempts SET ${field}=NULL WHERE ymid=$1`,[attempt.ymid]),{code:'23514'});
  const coin=await service().start(user,CODES[0]);
  await assert.rejects(pool.query('UPDATE jigcoin_internal.ad_attempts SET cooldown_seconds=120 WHERE ymid=$1',[coin.ymid]),{code:'23514'});
  const double=await service().start(user,BOOST_CODES[1]);
  await pool.query('UPDATE jigcoin_internal.ad_attempts SET cooldown_seconds=3600 WHERE ymid=$1',[double.ymid]);
  await assert.rejects(pool.query('UPDATE jigcoin_internal.ad_attempts SET cooldown_seconds=120 WHERE ymid=$1',[double.ymid]),{code:'23514'});
});

pgTest('a no-fill refill retries immediately with a fresh id and grants no reward or cooldown',async()=>{
  await assigned(user,120);
  const s=service({allowClientOutcome:()=>true,logger:{info(){}}});
  const attempt=await s.start(user,refillCode);
  await s.reportOutcome(user,{code:refillCode,attempt_id:attempt.ymid,stage:'preload',error_code:'NO_FILL',elapsed_ms:1400});
  await assert.rejects(s.claim(user,refillCode,attempt.ymid),{code:'AD_CONFIRMATION_PENDING'});
  const placement=(await pool.query('SELECT claimed_at,next_available_at FROM jigcoin_internal.reward_placements WHERE user_id=$1',[user.id])).rows[0];
  assert.deepEqual(placement,{claimed_at:null,next_available_at:null});
  const mission=await refillMission(user);
  assert.equal(mission.status,'available');
  assert.equal(mission.prepare_available,true);
  assert.equal(mission.retry_after_seconds,0);
  assert.equal(mission.cooldown_remaining_seconds,0);
  const retry=await s.start(user,refillCode);
  assert.notEqual(retry.ymid,attempt.ymid);
  await assert.rejects(s.claim(user,refillCode,retry.ymid),{code:'AD_CONFIRMATION_PENDING'});
  const attempts=(await pool.query('SELECT ymid,cycle_id,eligible_at,claimed_at FROM jigcoin_internal.ad_attempts WHERE user_id=$1 ORDER BY created_at',[user.id])).rows;
  assert.equal(attempts.length,2);
  assert.equal(attempts[0].cycle_id,attempts[1].cycle_id);
  assert.ok(attempts.every(a=>a.eligible_at===null&&a.claimed_at===null));
  assert.equal((await pool.query('SELECT energy FROM public.users WHERE id=$1',[user.id])).rows[0].energy,0);
  assert.deepEqual(await counts(),{ledger:0,balance:'0',receipts:0});
});

pgTest('immediate refill retries and late receipts can fulfil each reward cycle only once',async()=>{
  await assigned(user,120);
  const [first,retry,late]=await Promise.all(Array.from({length:3},()=>rewards.start(user,refillCode)));
  assert.equal(new Set([first.ymid,retry.ymid,late.ymid]).size,3);
  await Promise.all([rewards.postback(event(first)),rewards.postback(event(retry))]);
  await assert.rejects(rewards.start(user,refillCode),{code:'REWARD_ALREADY_READY'});
  const claims=await Promise.allSettled([first,retry,first,retry].map(a=>rewards.claim(user,refillCode,a.ymid)));
  const credited=claims.filter(result=>result.status==='fulfilled'&&!result.value.already_claimed);
  assert.equal(credited.length,1);
  assert.equal(credited[0].value.cooldown_remaining_seconds,120);
  assert.ok(claims.filter(result=>result.status==='rejected').every(result=>result.reason.code==='MISSION_COOLDOWN'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM jigcoin_internal.ad_attempts WHERE claimed_at IS NOT NULL')).rows[0].n,1);
  assert.equal((await pool.query('SELECT energy FROM public.users WHERE id=$1',[user.id])).rows[0].energy,50);

  // Advance only the isolated successful-claim clock, then start a new cycle.
  await pool.query('UPDATE public.users SET energy=0,last_energy_ts=clock_timestamp() WHERE id=$1',[user.id]);
  await pool.query(`UPDATE jigcoin_internal.reward_placements
    SET claimed_at=clock_timestamp()-interval '121 seconds',next_available_at=clock_timestamp()-interval '1 second'
    WHERE user_id=$1 AND code=$2`,[user.id,refillCode]);
  const next=await rewards.start(user,refillCode);
  await rewards.postback(event(late));
  await assert.rejects(rewards.claim(user,refillCode,late.ymid),{code:'AD_ATTEMPT_EXPIRED'});
  const mission=await refillMission(user);
  assert.equal(mission.status,'available','a receipt from the previous cycle cannot unlock the next refill');
  assert.equal(mission.attempt_id,null);
  await assert.rejects(rewards.claim(user,refillCode,next.ymid),{code:'AD_CONFIRMATION_PENDING'});
  assert.equal((await pool.query('SELECT energy FROM public.users WHERE id=$1',[user.id])).rows[0].energy,0);
  await rewards.postback(event(next));
  const nextClaims=await Promise.all(Array.from({length:4},()=>rewards.claim(user,refillCode,next.ymid)));
  assert.equal(nextClaims.filter(result=>!result.already_claimed).length,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM jigcoin_internal.ad_attempts WHERE claimed_at IS NOT NULL')).rows[0].n,2);
  assert.deepEqual(await counts(),{ledger:0,balance:'0',receipts:4});
});

pgTest('lifecycle observations derive policy, deduplicate, enforce ownership and cannot grant rewards',async()=>{
  await assigned(user,300);
  const s=service({allowClientLifecycle:()=>true,allowClientOutcome:()=>true,logger:{info(){}}});
  const attempt=await s.start(user,refillCode);
  const base={code:refillCode,attempt_id:attempt.ymid,stage:'preload',elapsed_ms:200,
    refill_policy:{version:'fake',group:'qa_120',cooldown_seconds:120},user_id:other.id,verified:true};
  for(const errorCode of ['PREPARED','PREPARED_EXPIRED']){
    assert.equal((await s.reportOutcome(user,{...base,error_code:errorCode})).duplicate,false);
    assert.equal((await s.reportOutcome(user,{...base,error_code:errorCode})).duplicate,true);
  }
  const prompt={...base,stage:'offer',error_code:'PROMPT_SHOWN',attempt_id:null};
  await s.reportOutcome(user,prompt); await s.reportOutcome(user,prompt);
  const rows=(await pool.query('SELECT user_id,policy_version,cohort,event FROM jigcoin_internal.refill_events_v15 ORDER BY id')).rows;
  assert.equal(rows.length,3);
  assert.ok(rows.every(r=>String(r.user_id)===String(user.id)&&r.policy_version===refillVersion&&r.cohort==='control_300'));
  await assert.rejects(s.reportOutcome(other,{...base,error_code:'PREPARED'}),{code:'AD_ATTEMPT_NOT_FOUND'});
  for(const elapsed_ms of [-1,300001,0.5,'10',null,true])
    await assert.rejects(s.reportOutcome(user,{...base,error_code:'PREPARED',elapsed_ms}),{code:'INVALID_AD_OUTCOME'});
  await assert.rejects(s.reportOutcome(user,{...prompt,attempt_id:attempt.ymid}),{code:'INVALID_AD_OUTCOME'});
  await assert.rejects(s.reportOutcome(user,{...base,error_code:'PREPARED',attempt_id:null}),{code:'AD_ATTEMPT_REQUIRED'});
  await s.reportOutcome(user,{...base,error_code:'SDK_TIMEOUT'});
  const meta=(await pool.query('SELECT meta FROM public.event_log')).rows[0].meta;
  assert.deepEqual(meta.refill_policy,{version:refillVersion,group:'control_300',cooldown_seconds:300});
  assert.equal((await pool.query('SELECT eligible_at,claimed_at FROM jigcoin_internal.ad_attempts WHERE ymid=$1',[attempt.ymid])).rows[0].eligible_at,null);
  assert.deepEqual(await counts(),{ledger:0,balance:'0',receipts:0});
});

pgTest('HTTP lifecycle budget does not consume the separate failure-diagnostic budget',async t=>{
  const attempt=await service().start(user,refillCode);
  const app=await startIsolatedApp(t,false,{pool,withTransaction:transaction,ledger:{applyBalanceChangeTx},env});
  const post=body=>fetch(app.url+'/api/mission/outcome',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({initData:signedInitData(Number(user.telegram_id)),code:refillCode,...body})});
  for(let n=0;n<40;n++)assert.equal((await post({stage:'offer',error_code:'PROMPT_SHOWN',attempt_id:null})).status,200);
  assert.equal((await post({stage:'offer',error_code:'PROMPT_SHOWN',attempt_id:null})).status,429);
  assert.equal((await post({stage:'preload',error_code:'SDK_TIMEOUT',attempt_id:attempt.ymid})).status,200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM jigcoin_internal.refill_events_v15')).rows[0].n,1);
});

pgTest('v15 scorecard excludes QA/holdout and reports unknown settled revenue asNULL',async()=>{
  await assigned(user,300); await assigned(other,120);
  await pool.query("UPDATE jigcoin_internal.refill_cohorts_v15 SET assigned_at=clock_timestamp()-interval '32 days',returned_day7_at=clock_timestamp()-interval '25 days'");
  await pool.query("INSERT INTO jigcoin_internal.purchase_receipts_v13 VALUES($1,'vip',500,'fixture',clock_timestamp()-interval '30 days',NULL)",[user.id]);
  const query=fs.readFileSync(path.join(__dirname,'../sql/refill_scorecard_v15.sql'),'utf8');
  let [report]=await pool.query(query);
  assert.equal(report.rows.length,2);
  assert.ok(report.rows.every(r=>r.ads_net_30d_gbp===null&&r.contribution_after_acquisition_per_player_gbp===null));
  assert.equal(report.rows.find(r=>r.cohort==='control_300').vip_purchases,'1');
  await pool.query(`INSERT INTO jigcoin_internal.refill_finance_v15
    (policy_version,cohort_day,cohort,ads_net_gbp,stars_net_gbp,delivery_cost_gbp,acquisition_cost_gbp,coverage_complete,evidence_ref,allocation_method)
    SELECT policy_version,(assigned_at AT TIME ZONE 'UTC')::date,cohort,0.20,4,0.30,1,TRUE,'fixture evidence only','fixture exact allocation'
    FROM jigcoin_internal.refill_cohorts_v15 WHERE user_id=$1`,[user.id]);
  [report]=await pool.query(query);
  assert.equal(report.rows.find(r=>r.cohort==='control_300').contribution_after_acquisition_per_player_gbp,'2.9000');
  await pool.query('INSERT INTO jigcoin_internal.acquisition_v13 VALUES($1,TRUE)',[user.id]);
  await pool.query("INSERT INTO jigcoin_internal.pilot_players_v14 VALUES($1,'holdout')",[other.id]);
  [report]=await pool.query(query); assert.equal(report.rows.length,0);
});

pgTest('new cohort, observation and finance tables deny browser roles even with accidentalSELECT grants',async()=>{
  await service().start(user,refillCode);
  const client=await pool.connect();
  try{
    for(const role of ['anon','authenticated']){
      await client.query('BEGIN');
      await client.query(`GRANT USAGE ON SCHEMA jigcoin_internal TO ${role}`);
      await client.query(`GRANT SELECT ON jigcoin_internal.refill_cohorts_v15,jigcoin_internal.refill_events_v15,jigcoin_internal.refill_finance_v15 TO ${role}`);
      await client.query(`SET LOCAL ROLE ${role}`);
      for(const table of ['refill_cohorts_v15','refill_events_v15','refill_finance_v15'])
        assert.equal((await client.query('SELECT * FROM jigcoin_internal.'+table)).rowCount,0);
      await client.query('ROLLBACK');
    }
  }finally{await client.query('ROLLBACK');client.release();}
});
