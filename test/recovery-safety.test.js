"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const express = require("express");

const root = path.resolve(__dirname, "..");
const quiet = { log() {}, warn() {}, error() {} };

// Execute the actual entrypoint with Express, but no credentials, database,
// Telegram connection, payment provider, or public listener.
async function startIsolatedApp(t, maintenance) {
  const app = express();
  app.listen = () => {};
  let configReads = 0;
  const pool = { async query() { return { rows: [{ c: 0, n: 0 }] }; } };
  const dependencies = {
    express: Object.assign(() => app, express),
    cors: require("cors"),
    telegraf: { Telegraf: class { start() {} command() {} } },
    "./lib/db": { pool, withTransaction: async () => { throw Error("Unexpected transaction"); } },
    "./lib/ledger": {},
    "./lib/jobs": {},
    "./lib/idempotency": {},
    "./lib/powerups": {},
    "./lib/monetagRewards": require("../lib/monetagRewards"),
    "./lib/config": { async loadConfig() { configReads++; return {}; } },
    crypto: require("node:crypto"),
    stripe: class { constructor() { throw Error("Unexpected payment client"); } },
    "node-fetch": async () => { throw Error("Unexpected external request"); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "index.js"), "utf8"), {
    require(name) {
      if (!Object.hasOwn(dependencies, name)) throw Error(`Unexpected import: ${name}`);
      return dependencies[name];
    },
    process: {
      env: {
        BOT_TOKEN: "offline-test-placeholder", DATABASE_URL: "offline-test-placeholder",
        MAINTENANCE_MODE: maintenance ? "1" : "0", AUTO_MIGRATE: "0",
        RUN_MODE: "api", DISABLE_BOT_POLLING: "1",
      },
      exit() { throw Error("Unexpected process exit"); },
    },
    console: quiet, Buffer, URL, URLSearchParams, setTimeout, clearTimeout,
  }, { filename: "index.js", timeout: 2000 });
  await new Promise(resolve => setImmediate(resolve));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    configReads: () => configReads,
    middlewareCount: () => app._router.stack.length,
  };
}

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
