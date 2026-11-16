"use strict";

const { createMonetagRewards, CODES, ALL_CODES } = require("./monetagRewards");
const yes = value => /^(1|true)$/i.test(String(value || ""));
const PATHS = new Set([
  "/api/progression", "/api/progression/claim",
  "/api/stars/catalog", "/api/stars/invoice", "/api/stars/status",
  "/api/shop/coin-packs", "/api/shop/momentum-shields", "/api/task", "/api/config", "/api/state", "/api/mission/list",
  "/api/mission/start", "/api/mission/complete", "/api/tapPacket", "/api/leaderboard/global", "/api/leaderboard/window",
]);

// An explicit, single-account exception while the ordinary app remains closed.
// No account identifier or provider credential is compiled into this module.
function createRecoveryTestAccess({ env, pool, withTransaction, applyBalanceChangeTx,
  verifyTelegramInitData, buildClientState, loadConfig, getEnergyCap, gameplay, dailyCheckin, starsShop, progression, streakRewards }) {
  const telegramId = String(env.RECOVERY_TEST_TELEGRAM_ID || "");
  const active = yes(env.MAINTENANCE_MODE) && yes(env.RECOVERY_TEST_ENABLED) &&
    /^[1-9][0-9]{0,15}$/.test(telegramId) && BigInt(telegramId) <= BigInt(Number.MAX_SAFE_INTEGER);
  if (!active) return (_req, _res, next) => next();

  // This service is reachable only through the verified-account gate below.
  // The public service and its kill switches are left unchanged.
  const rewards = createMonetagRewards({ pool, withTransaction, applyBalanceChangeTx, getEnergyCap,
    env: { ...env, MONETAG_REWARDS_ENABLED: "1", DISABLE_AD_REWARDS: "0", DISABLE_SPONSOR_MISSIONS: "0" } });

  function isTester(req) {
    try {
      const raw = req.body?.initData || req.headers["x-telegram-initdata"];
      if (typeof raw !== "string" || raw.length > 16384) return false;
      const params = new URLSearchParams(raw);
      const keys = [...params.keys()];
      if (new Set(keys).size !== keys.length) return false;
      const token = String(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || "").trim();
      if (!verifyTelegramInitData(raw, token).ok) return false;
      // Recovery access has a fixed one-hour session limit, independent of any
      // permissive legacy setting. Reject future dates and ambiguous payloads.
      const date = params.get("auth_date");
      if (!/^[1-9][0-9]{0,11}$/.test(date || "")) return false;
      const age = Math.floor(Date.now() / 1000) - Number(date);
      if (age < -30 || age > 3600) return false;
      const user = JSON.parse(params.get("user"));
      return Number.isSafeInteger(user?.id) && user.id > 0 && String(user.id) === telegramId;
    } catch (_) { return false; }
  }

  return (req, res, next) => {
    if (req.method !== "POST" || !PATHS.has(req.path) || !isTester(req)) return next();
    if (req.path === "/api/task" &&
        (!dailyCheckin || !["daily", "daily_checkin", "daily-checkin", "daily_check_in", "checkin", "check_in"].includes(String(req.body?.taskName || "").trim().toLowerCase()) ||
         !["", "daily_checkin", "start_new"].includes(String(req.body?.action || "").trim().toLowerCase()))) return next();
    return rewards.handler(async () => {
      const { rows } = await pool.query(
        "SELECT * FROM public.users WHERE telegram_id=$1::bigint LIMIT 1", [telegramId]);
      const user = rows[0];
      if (!user || String(user.telegram_id) !== telegramId || user.is_system_user) {
        throw Object.assign(new Error("RECOVERY_TEST_ACCOUNT_MISSING"),
          { code: "RECOVERY_TEST_ACCOUNT_MISSING", status: 403 });
      }
      if (req.path === '/api/progression' || req.path === '/api/progression/claim') {
        if(!progression)throw Object.assign(new Error('PROGRESSION_UNAVAILABLE'),{code:'PROGRESSION_UNAVAILABLE',status:503});
        return req.path.endsWith('/claim')?progression.claim(user,req.body):progression.status(user);
      }
      if (req.path.startsWith("/api/stars/")) {
        if (!starsShop) throw Object.assign(new Error("SHOP_NOT_READY"),{code:"SHOP_NOT_READY",status:503});
        if (req.path === "/api/stars/catalog") return starsShop.catalog(user);
        if (req.path === "/api/stars/invoice") return starsShop.invoice(user,req.body.sku);
        return starsShop.status(user,req.body.order_id);
      }
      if (req.path === "/api/shop/coin-packs" || req.path === "/api/shop/momentum-shields") {
        const coin = req.path === "/api/shop/coin-packs";
        const result = await pool.query(`SELECT pack_sku,title,coins_granted
          FROM public.payment_products WHERE provider='coinbase' AND active=TRUE
          AND starts_with(upper(pack_sku),$1) ORDER BY amount_minor ASC NULLS LAST,pack_sku ASC`,
          [coin ? "COIN_" : "MOMENTUM_SHIELD_"]);
        return {ok:true,recovery_test:true,purchases_enabled:false,packs:result.rows.map(row=>({
          sku:row.pack_sku,title:row.title,coins:Number(row.coins_granted || 0),bonus_coins:0
        }))};
      }
      if (req.path === "/api/task") return dailyCheckin(req, res, user);
      if (req.path === "/api/config") return { ok: true, config: await loadConfig() };
      if (req.path === "/api/state") {
        // Let the tester reach the quest without running onboarding's unrelated
        // taps/check-in/purchase steps. Do not mark onboarding complete in SQL.
        return { ...await buildClientState(gameplay.project(user), { readOnly: true }),
          onboarding_required: false, recovery_test: true, recovery_gameplay: true };
      }
      if (req.path === "/api/tapPacket") {
        const result = await gameplay.tap(user, req.body);
        return { ...await buildClientState(result.user, {readOnly:true}), ...result.response,
          onboarding_required:false, recovery_test:true, recovery_gameplay:true };
      }
      if (req.path === "/api/leaderboard/window") {
        // Same ordinal ordering as the global leaderboard, in one read-only
        // snapshot. The existing signed-owner gate above remains mandatory.
        const {rows}=await pool.query(`WITH ranked AS (
          SELECT telegram_id,balance,ROW_NUMBER() OVER (ORDER BY balance DESC,telegram_id ASC) AS rn,
            COUNT(*) OVER () AS total FROM public.users
        ), me AS (SELECT * FROM ranked WHERE telegram_id=$1::bigint)
        SELECT r.telegram_id,r.balance,r.rn,me.rn AS me_rn,me.balance AS me_balance,me.total
        FROM ranked r CROSS JOIN me WHERE r.rn BETWEEN me.rn-3 AND me.rn+3 ORDER BY r.rn`,[telegramId]);
        if(!rows.length)return {ok:true,me:null,window:[]};
        return {ok:true,recovery_test:true,
          me:{telegram_id:Number(telegramId),balance:Number(rows[0].me_balance),global_rank:Number(rows[0].me_rn),global_total:Number(rows[0].total)},
          window:await streakRewards.decorate(rows.map(row=>({telegram_id:Number(row.telegram_id),balance:Number(row.balance),global_rank:Number(row.rn)})))};
      }
      if (req.path === "/api/leaderboard/global") {
        const rows = (await pool.query(`SELECT telegram_id,username,first_name,last_name,balance,
          ROW_NUMBER() OVER (ORDER BY balance DESC,telegram_id ASC) AS global_rank
          FROM public.users ORDER BY balance DESC,telegram_id ASC LIMIT 100`)).rows;
        const state = await buildClientState(user, {readOnly:true});
        return {ok:true, global:await streakRewards.decorate(rows.map(row=>({...row,telegram_id:Number(row.telegram_id),balance:Number(row.balance),global_rank:Number(row.global_rank)}))),
          me:{telegram_id:Number(user.telegram_id),balance:Number(user.balance),global_rank:state.global_rank,global_total:state.global_total}};
      }
      if (req.path === "/api/mission/list") {
        const result = await pool.query(
          "SELECT code,kind FROM public.missions WHERE code=ANY($1::text[]) AND kind='sponsor' AND is_active=TRUE ORDER BY array_position($1::text[],code)", [ALL_CODES]);
        return { ok: true, recovery_test: true, missions: await rewards.decorateMissions(user, result.rows) };
      }
      if (!ALL_CODES.includes(req.body?.code)) {
        throw Object.assign(new Error("AD_REWARDS_UNAVAILABLE"),
          { code: "AD_REWARDS_UNAVAILABLE", status: 503 });
      }
      if (req.path === "/api/mission/start") return rewards.start(user, req.body.code);
      return rewards.claim(user, req.body.code, req.body.attempt_id);
    })(req, res);
  };
}

module.exports = { createRecoveryTestAccess };
