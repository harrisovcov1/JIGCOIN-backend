"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const express = require("express");
const root = path.resolve(__dirname, "../..");
const quiet = { log() {}, warn() {}, error() {} };

// Execute the actual entrypoint with Express, but no credentials, database,
// Telegram connection, payment provider, or public listener.
async function startIsolatedApp(t, maintenance, options = {}) {
  const app = express();
  app.listen = () => {};
  let configReads = 0;
  const pool = options.pool || { async query() { return { rows: [{ c: 0, n: 0 }] }; } };
  const dependencies = {
    express: Object.assign(() => app, express),
    cors: require("cors"),
    telegraf: { Telegraf: class { start() {} command() {} } },
    "./lib/db": { pool, withTransaction: options.withTransaction || (async () => { throw Error("Unexpected transaction"); }) },
    "./lib/ledger": options.ledger || {},
    "./lib/jobs": {},
    "./lib/idempotency": options.idempotency || {},
    "./lib/powerups": options.powerups || {},
    "./lib/gameplay": require("../../lib/gameplay"),
    "./lib/monetagRewards": require("../../lib/monetagRewards"),
    "./lib/recoveryTestAccess": require("../../lib/recoveryTestAccess"),
    "./lib/starsShop": {createStarsShop:()=>options.starsService||({webhook:(_q,r)=>r.status(401).json({ok:false})}),telegramClient:()=>async()=>{throw Error("Unexpected Stars network");}},
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
        ...options.env,
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

function signedInitData(id = 10001, { age = 0, duplicate = false, token = "offline-test-placeholder" } = {}) {
  const crypto = require("node:crypto");
  const pairs = [["auth_date", String(Math.floor(Date.now()/1000)-age)], ["user", JSON.stringify({id,username:"synthetic"})]];
  if (duplicate) pairs.push(["user", JSON.stringify({id})]);
  pairs.sort((a,b)=>a[0].localeCompare(b[0]));
  const key=crypto.createHmac("sha256","WebAppData").update(token).digest();
  const hash=crypto.createHmac("sha256",key).update(pairs.map(([k,v])=>`${k}=${v}`).join("\n")).digest("hex");
  return new URLSearchParams([...pairs,["hash",hash]]).toString();
}
module.exports = { startIsolatedApp, signedInitData };
