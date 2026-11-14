"use strict";

const { createMonetagRewards, CODES } = require("./monetagRewards");
const yes = value => /^(1|true)$/i.test(String(value || ""));
const TEST_CODE = CODES[0];
const PATHS = new Set([
  "/api/config", "/api/state", "/api/mission/list",
  "/api/mission/start", "/api/mission/complete",
]);

// An explicit, single-account exception while the ordinary app remains closed.
// No account identifier or provider credential is compiled into this module.
function createRecoveryTestAccess({ env, pool, withTransaction, applyBalanceChangeTx,
  verifyTelegramInitData, buildClientState, loadConfig }) {
  const telegramId = String(env.RECOVERY_TEST_TELEGRAM_ID || "");
  const active = yes(env.MAINTENANCE_MODE) && yes(env.RECOVERY_TEST_ENABLED) &&
    /^[1-9][0-9]{0,15}$/.test(telegramId) && BigInt(telegramId) <= BigInt(Number.MAX_SAFE_INTEGER);
  if (!active) return (_req, _res, next) => next();

  // This service is reachable only through the verified-account gate below.
  // The public service and its kill switches are left unchanged.
  const rewards = createMonetagRewards({ pool, withTransaction, applyBalanceChangeTx,
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
    return rewards.handler(async () => {
      const { rows } = await pool.query(
        "SELECT * FROM public.users WHERE telegram_id=$1::bigint LIMIT 1", [telegramId]);
      const user = rows[0];
      if (!user || String(user.telegram_id) !== telegramId || user.is_system_user) {
        throw Object.assign(new Error("RECOVERY_TEST_ACCOUNT_MISSING"),
          { code: "RECOVERY_TEST_ACCOUNT_MISSING", status: 403 });
      }
      if (req.path === "/api/config") return { ok: true, config: await loadConfig() };
      if (req.path === "/api/state") {
        // Let the tester reach the quest without running onboarding's unrelated
        // taps/check-in/purchase steps. Do not mark onboarding complete in SQL.
        return { ...await buildClientState(user, { readOnly: true }),
          onboarding_required: false, recovery_test: true };
      }
      if (req.path === "/api/mission/list") {
        const result = await pool.query(
          "SELECT code,kind FROM public.missions WHERE code=$1 AND kind='sponsor' AND is_active=TRUE", [TEST_CODE]);
        return { ok: true, recovery_test: true, missions: await rewards.decorateMissions(user, result.rows) };
      }
      if (req.body?.code !== TEST_CODE) {
        throw Object.assign(new Error("AD_REWARDS_UNAVAILABLE"),
          { code: "AD_REWARDS_UNAVAILABLE", status: 503 });
      }
      if (req.path === "/api/mission/start") return rewards.start(user, TEST_CODE);
      return rewards.claim(user, TEST_CODE, req.body.attempt_id);
    })(req, res);
  };
}

module.exports = { createRecoveryTestAccess };
