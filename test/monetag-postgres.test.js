"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { createMonetagRewards, CODES } = require("../lib/monetagRewards");
const { applyBalanceChangeTx } = require("../lib/ledger");

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
    CREATE TABLE public.users (id bigserial PRIMARY KEY, telegram_id bigint NOT NULL, balance bigint NOT NULL DEFAULT 0);
    CREATE TABLE public.missions (id serial PRIMARY KEY, code text NOT NULL UNIQUE, kind text, is_active boolean DEFAULT true,
      sponsor_claims_today integer DEFAULT 1,max_claims_per_day integer DEFAULT 1);
    CREATE TABLE public.user_missions (id serial PRIMARY KEY,user_id integer REFERENCES public.users(id),mission_id integer REFERENCES public.missions(id),
      status text,started_at timestamptz,completed_at timestamptz,verified_at timestamptz,claimed_at timestamptz,reward_applied boolean,
      UNIQUE(user_id,mission_id));
    CREATE TABLE public.user_balance_ledger (id bigserial PRIMARY KEY,user_id integer REFERENCES public.users(id),delta bigint,reason text,ref_type text,ref_id bigint,event_type text);
    DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
  `);
  const migration = fs.readFileSync(path.join(__dirname, "../sql/migrations/006_monetag_rewards.sql"), "utf8");
  await pool.query(migration);
  await pool.query(migration); // Restart-safe additive migration.
  await pool.query(`CREATE TRIGGER trg_enforce_daily_sponsor_cap BEFORE UPDATE OF claimed_at ON public.user_missions
    FOR EACH ROW EXECUTE FUNCTION public.enforce_daily_sponsor_cap()`);
});
beforeEach(async () => {
  if (!port) return;
  await pool.query("TRUNCATE jigcoin_internal.monetag_events,jigcoin_internal.ad_attempts,jigcoin_internal.reward_placements,public.user_missions,public.user_balance_ledger,public.users,public.missions RESTART IDENTITY CASCADE");
  for (const code of CODES) await pool.query("INSERT INTO public.missions(code,kind) VALUES($1,'sponsor')", [code]);
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

pgTest("parallel callbacks and claims credit exactly once and persist a real 24-hour cooldown", async () => {
  const a = await rewards.start(user, CODES[0]);
  await Promise.all(Array.from({ length: 12 }, (_, i) => rewards.postback(event(a, { event_type: i % 2 ? "click" : "impression" }))));
  const claims = await Promise.all(Array.from({ length: 12 }, () => rewards.claim(user, CODES[0], a.ymid)));
  assert.equal(claims.filter(c => !c.already_claimed).length, 1);
  assert.deepEqual(await counts(), { ledger: 1, balance: "200", receipts: 2 });
  const [m] = await service().decorateMissions(user, [{code: CODES[0],kind: "sponsor"}]);
  assert.equal(m.status, "cooldown");
  assert.ok(m.cooldown_remaining_seconds >= 86398 && m.cooldown_remaining_seconds <= 86400);
  await assert.rejects(rewards.start(user, CODES[0]), { code: "MISSION_COOLDOWN" });
  await rewards.start(user, CODES[1]); // Other quest has its own limit.
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
  await pool.query("INSERT INTO public.user_missions(user_id,mission_id,claimed_at) VALUES($1,1,now()-interval '1 hour')", [user.id]);
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
  await pool.query("UPDATE jigcoin_internal.reward_placements SET next_available_at=now()-interval '1 second'");
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
  const b = await rewards.start(user, CODES[1]);
  await pool.query("UPDATE jigcoin_internal.ad_attempts SET expires_at=now()-interval '1 second' WHERE ymid=$1", [b.ymid]);
  await rewards.postback(event(b));
  await assert.rejects(rewards.claim(user, CODES[1], b.ymid), { code: "AD_ATTEMPT_EXPIRED" });
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
  assert.equal(flags.length,3);
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
