"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const quiet = { log() {}, warn() {}, error() {} };

const { startIsolatedApp, signedInitData } = require("./helpers/httpApp.cjs");

test("maintenance blocks app, checkout, payout and callback handlers before they execute", async t => {
  const app = await startIsolatedApp(t, true);
  const count = app.middlewareCount();
  for (const [method, endpoint] of [
    ["POST", "/api/config"], ["POST", "/api/payments/create-checkout"],
    ["POST", "/api/withdraw/request"], ["POST", "/api/admin/withdraw/update"],
    ["GET", "/postback/ogads"],
  ]) {
    const response = await fetch(app.url + endpoint, { method });
    assert.equal(response.status, 503, endpoint);
    assert.equal((await response.json()).error, "MAINTENANCE_MODE", endpoint);
  }
  assert.equal(app.configReads(), 0, "blocked configuration handler must not execute");
  assert.equal(app.middlewareCount(), count, "requests must not register extra middleware");
});

test("maintenance keeps health and season status available", async t => {
  const app = await startIsolatedApp(t, true);
  for (const [method, endpoint] of [["GET", "/"], ["GET", "/health"], ["POST", "/api/season/status"]]) {
    const response = await fetch(app.url + endpoint, { method });
    assert.equal(response.status, 200, endpoint);
    await response.text();
  }
});

test("normal mode allows the configuration handler and does not grow middleware", async t => {
  const app = await startIsolatedApp(t, false);
  const count = app.middlewareCount();
  const response = await fetch(app.url + "/api/config", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(app.configReads(), 1);
  assert.equal(app.middlewareCount(), count);
});

test("new reward routes require Telegram authentication and legacy ad bypasses stay closed", async t => {
  const app = await startIsolatedApp(t, false);
  for (const action of ["start", "complete"]) {
    const response = await fetch(app.url + `/api/mission/${action}`, {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({code:"sp_watch_content",reward_amount:999999,verified:true}),
    });
    assert.equal(response.status,401);
    assert.equal((await response.json()).error,"UNAUTHORIZED");
  }
  for (const endpoint of ["/api/boost/requestAd","/api/boost/completeAd","/api/boost/double","/api/boost/energy"]) {
    const response=await fetch(app.url+endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({method:"action",reward_amount:999999})});
    assert.equal(response.status,503,endpoint);
  }
});

test("Monetag receiver stays reachable during app maintenance but requires its private configuration", async t => {
  const app=await startIsolatedApp(t,true);
  const response=await fetch(app.url+"/postback/monetag?secret=not-configured");
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,"MONETAG_NOT_CONFIGURED");
  assert.equal(response.headers.get("cache-control"),"no-store");
});

// All identities and tokens in these tests are synthetic. Exercise the actual
// entrypoint's HMAC verifier rather than substituting a successful login.
const testEnv = {
  RECOVERY_TEST_ENABLED: "1", RECOVERY_TEST_TELEGRAM_ID: "10001",
  MONETAG_ZONE_ID: "12257359", MONETAG_POSTBACK_SECRET: "a".repeat(64),
  MONETAG_REWARDS_ENABLED: "0", DISABLE_AD_REWARDS: "1", DISABLE_SPONSOR_MISSIONS: "1",
  DISABLE_WITHDRAWALS: "1",
};

async function post(app, endpoint, body) {
  const response = await fetch(app.url+endpoint, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  return { status:response.status, cache:response.headers.get("cache-control"), body:await response.json() };
}
function readOnlyTestPool({ missing = false, system = false } = {}) {
  const queries=[];
  return {queries, async query(sql, args) {
    queries.push({sql,args});
    assert.match(sql.trim(),/^SELECT/i,"state and mission listing must not write");
    if (/telegram_id\s*=\s*\$1/i.test(sql)) return { rows:missing?[]:[{
      id:23,telegram_id:"10001",balance:"1234",energy:12,streak_count:4,
      last_checkin_at:"2020-01-01T00:00:00Z",is_system_user:system,has_completed_onboarding:false,
    }] };
    if (/SELECT code,kind/.test(sql)) return {rows:[{code:"sp_visit_partner",kind:"sponsor"}]};
    if (/SELECT ranked.position/.test(sql)) return {rows:[{position:"1",total:"1"}]};
    if (/COUNT\(\*\)/i.test(sql)) return {rows:[{count:"1"}]};
    return {rows:[]};
  }};
}

test("recovery access requires its explicit switch, a valid numeric ID, and maintenance", async t => {
  for (const patch of [{RECOVERY_TEST_ENABLED:"0"},{RECOVERY_TEST_TELEGRAM_ID:""},
    {RECOVERY_TEST_TELEGRAM_ID:"10001,10002"},{RECOVERY_TEST_TELEGRAM_ID:"9007199254740992"}]) {
    const app=await startIsolatedApp(t,true,{env:{...testEnv,...patch}});
    const r=await post(app,"/api/state",{initData:signedInitData()});
    assert.equal(r.status,503); assert.equal(r.body.error,"MAINTENANCE_MODE");
  }
  const pool=readOnlyTestPool();
  const app=await startIsolatedApp(t,false,{pool,env:testEnv});
  const r=await post(app,"/api/mission/start",{initData:signedInitData(),code:"sp_visit_partner"});
  assert.equal(r.body.error,"AD_REWARDS_UNAVAILABLE","test exception must vanish when maintenance is off");
});

test("forged, wrong-account, expired, future and duplicate Telegram data cannot enter recovery", async t => {
  const pool=readOnlyTestPool();
  const app=await startIsolatedApp(t,true,{pool,env:testEnv});
  for (const initData of ["",signedInitData(10002),signedInitData(10001,{token:"wrong"}),
    signedInitData(10001,{age:3605}),signedInitData(10001,{age:-120}),signedInitData(10001,{duplicate:true})]) {
    const r=await post(app,"/api/state",{initData,telegram_id:10001,user:{id:10001},verified:true});
    assert.equal(r.status,503); assert.equal(r.body.error,"MAINTENANCE_MODE");
  }
  assert.equal(pool.queries.length,0,"unverified identities cannot query or create a user");
});

test("authorized recovery state and mission listing are read-only with public rewards disabled", async t => {
  const pool=readOnlyTestPool();
  const app=await startIsolatedApp(t,true,{pool,env:testEnv,powerups:{getActivePowerupsForUser:async()=>[]}});
  const auth={initData:signedInitData()};
  const state=await post(app,"/api/state",auth);
  assert.equal(state.status,200); assert.equal(state.body.balance,1234);
  assert.equal(state.body.streak_count,4); assert.equal(state.body.recovery_test,true);
  assert.equal(state.body.onboarding_required,false,"test UI skips onboarding without persisting completion");
  assert.equal(state.cache,"no-store");
  const list=await post(app,"/api/mission/list",{...auth,kind:"anything",include_boost_sponsor_missions:true});
  assert.equal(list.status,200); assert.equal(list.body.missions.length,1);
  assert.equal(list.body.missions[0].code,"sp_visit_partner");
  assert.equal(list.body.missions[0].status,"available");
  assert.equal(list.body.missions[0].payout_amount,200);
  assert.ok(!JSON.stringify(list.body).includes(testEnv.MONETAG_POSTBACK_SECRET));
  assert.ok(pool.queries.every(q=>/^SELECT/i.test(q.sql.trim())));
});

test("recovery does not create missing accounts or permit system accounts", async t => {
  for (const flags of [{missing:true},{system:true}]) {
    const pool=readOnlyTestPool(flags);
    const app=await startIsolatedApp(t,true,{pool,env:testEnv});
    const r=await post(app,"/api/mission/start",{initData:signedInitData(),code:"sp_visit_partner"});
    assert.equal(r.status,403); assert.equal(r.body.error,"RECOVERY_TEST_ACCOUNT_MISSING");
    assert.equal(pool.queries.length,1);
  }
});

test("even the tester cannot access payments, withdrawals, legacy taps, admin or legacy ads", async t => {
  const pool=readOnlyTestPool();
  const app=await startIsolatedApp(t,true,{pool,env:testEnv});
  const auth={initData:signedInitData(),telegram_id:10001};
  for (const endpoint of ["/api/tap","/api/task","/api/onboarding/complete",
    "/api/payments/create-checkout","/api/vip/buy","/api/withdraw/request","/api/admin/withdraw/update",
    "/api/boost/requestAd","/api/boost/completeAd","/api/boost/double","/api/boost/energy"]) {
    const r=await post(app,endpoint,{...auth,method:"points"});
    assert.equal(r.status,503,endpoint); assert.equal(r.body.error,"MAINTENANCE_MODE",endpoint);
  }
  assert.equal(pool.queries.length,0);
  for (const code of ["unknown_ad","daily","sp_visit_partner "]) {
    const r=await post(app,"/api/mission/start",{...auth,code});
    assert.equal(r.status,503); assert.equal(r.body.error,"AD_REWARDS_UNAVAILABLE");
  }
  const get=await fetch(app.url+"/api/state?initData="+encodeURIComponent(auth.initData));
  assert.equal(get.status,503,"query-string authentication cannot bypass maintenance");
});

test("recovery database failures return a sanitized error instead of secret-bearing details", async t => {
  const pool={async query(){throw Object.assign(new Error("private connection value must not appear"),{code:"08006"});}};
  const app=await startIsolatedApp(t,true,{pool,env:testEnv});
  const r=await post(app,"/api/state",{initData:signedInitData()});
  assert.equal(r.status,503); assert.equal(r.body.error,"REWARD_SERVICE_UNAVAILABLE");
  assert.ok(!JSON.stringify(r).includes("private connection"));
});

test("an unimplemented payout provider never returns a success identifier", async () => {
  for (const provider of [undefined, "manual", "ton", "unknown"]) {
    const exported = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, "lib/payoutProvider.js"), "utf8"), {
      module: exported, process: { env: provider ? { WITHDRAW_PROVIDER: provider } : {} }, console: quiet,
    });
    await assert.rejects(exported.exports.sendPayout({ id: 17, user_id: 23, amount: 1000, wallet: "offline-test" }),
      error => error.code === "PAYOUT_PROVIDER_NOT_CONFIGURED" && error.permanent === true);
  }
});

test("a payout job cannot mark a withdrawal paid when no provider is configured", async () => {
  const { runJobHandler } = require("../lib/jobHandlers");
  const queries = [];
  const client = { async query(sql) {
    queries.push(sql);
    if (/SELECT/.test(sql)) return { rows: [{ id: 17, user_id: 23, status: "approved", amount: 1000, wallet: "offline-test" }] };
    return { rows: [] };
  } };
  await assert.rejects(runJobHandler(client, { type: "withdraw_payout", payload_json: { withdraw_id: 17 } }),
    error => error.code === "PAYOUT_PROVIDER_NOT_CONFIGURED");
  assert.equal(queries.length, 1, "no payment-status update may follow the provider error");
});

test("sync_user preserves disputed balances until reconciliation is reviewed", async () => {
  const { runJobHandler } = require("../lib/jobHandlers");
  for (const [stored, ledger] of [["100", "0"], ["100", "120"], ["9007199254740993", "9007199254740992"]]) {
    const queries = [];
    const client = { async query(sql) {
      queries.push(sql);
      if (/FROM public\.users/.test(sql)) return { rows: [{ id: 23, balance: stored }] };
      if (/FROM public\.user_balance_ledger/.test(sql)) return { rows: [{ balance_from_ledger: ledger }] };
      throw Error("A balance mismatch must not issue a write");
    } };
    await assert.rejects(runJobHandler(client, { type: "sync_user", payload_json: { user_id: 23 } }),
      error => error.code === "BALANCE_RECONCILIATION_REQUIRED" && error.permanent === true);
    assert.equal(queries.length, 2, "only the two balance reads are permitted");
  }
});

test("sync_user accepts matching bigint balances without writing them", async () => {
  const { runJobHandler } = require("../lib/jobHandlers");
  for (const balance of ["0", "100", "9007199254740993"]) {
    const queries = [];
    const client = { async query(sql) {
      queries.push(sql);
      if (/FROM public\.users/.test(sql)) return { rows: [{ id: 23, balance }] };
      if (/FROM public\.user_balance_ledger/.test(sql)) return { rows: [{ balance_from_ledger: balance }] };
      throw Error("No writes expected");
    } };
    await runJobHandler(client, { type: "sync_user", payload_json: { user_id: 23 } });
    assert.equal(queries.length, 2);
  }
});
