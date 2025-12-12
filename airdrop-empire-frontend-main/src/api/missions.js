// src/api/missions.js
// Small helper for talking to your Render backend from React (Vite)

export const API_BASE =
  import.meta.env.VITE_API_BASE ||
  "https://airdrop-empire-bot.onrender.com";

// Build request body that works both in Telegram Mini App and in browser dev
export function buildRequestBody(extra = {}) {
  const params = new URLSearchParams(window.location.search);

  // 1) URL params (dev / debug)
  const telegramIdParam = params.get("telegram_id");
  const initDataParam = params.get("tgWebAppData");

  // 2) Telegram WebApp object (real mini app)
  const tg =
    window.Telegram && window.Telegram.WebApp
      ? window.Telegram.WebApp
      : null;

  let telegramId = telegramIdParam ? Number(telegramIdParam) : null;

  // Raw signed payload for backend to verify
  const initData =
    initDataParam ||
    (tg && typeof tg.initData === "string" ? tg.initData : "");

  // ⭐ NEW: get real Telegram user id from WebApp.initDataUnsafe
  if (!telegramId && tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
    try {
      telegramId = Number(tg.initDataUnsafe.user.id);
    } catch (e) {
      console.warn("Could not parse Telegram user id from initDataUnsafe:", e);
    }
  }

  const base = {};
  if (telegramId) base.telegram_id = telegramId;
  if (initData) base.initData = initData;

  // Optional: small debug log if absolutely nothing present
  if (!base.telegram_id && !base.initData) {
    console.warn(
      "[AirdropEmpire] No Telegram auth data found in buildRequestBody",
      window.location.search
    );
  }

  return { ...base, ...extra };
}

async function post(path, body = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildRequestBody(body)),
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("Bad JSON from", path, text);
    return { ok: false, error: "BAD_JSON" };
  }
}

// ---- Public API functions for MissionsPanel ----

export function apiListMissions(kind = null) {
  const body = {};
  if (kind) body.kind = kind;
  return post("/api/mission/list", body);
}

export function apiStartMission(code) {
  return post("/api/mission/start", { code });
}

export function apiCompleteMission(code) {
  return post("/api/mission/complete", { code });
}

export function apiRequestAd(rewardType, rewardAmount = 0, network = null) {
  return post("/api/boost/requestAd", {
    reward_type: rewardType,
    reward_amount: rewardAmount,
    network,
  });
}

export function apiCompleteAd(adSessionId) {
  return post("/api/boost/completeAd", {
    ad_session_id: adSessionId,
  });
}

// Extra: for App.jsx to get basic user state
export function apiFetchState() {
  return post("/api/state");
}
