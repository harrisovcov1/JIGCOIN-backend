// index.js
// Airdrop Empire – Backend Engine (DEV-friendly auth)
// - Telegram bot (Telegraf)
// - Express API for mini app
// - Postgres (Supabase-style) via pg.Pool

// ----------------- Imports & Setup -----------------
const express = require("express");
const cors = require("cors");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

// ---- Environment ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_USERNAME = process.env.BOT_USERNAME || "airdrop_empire_bot";

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is missing");
  process.exit(1);
}

// ---- DB Pool ----
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Small helper
function todayDate() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// Referral reward per new friend (once, when they join)
const REFERRAL_REWARD = 800;

// ----------------- Telegram initData (DEV MODE, NO HASH CHECK) -----------------

/**
 * Parse Telegram WebApp initData WITHOUT verifying the HMAC hash.
 * This is OK for DEV but later we can re-enable full security.
 *
 * Returns { user, query } on success or null on failure.
 */
function getTelegramUserFromInitData(initData) {
  try {
    if (!initData || typeof initData !== "string") return null;

    const params = new URLSearchParams(initData);
    const userStr = params.get("user");
    if (!userStr) {
      console.warn("getTelegramUserFromInitData: no user field in initData");
      return null;
    }

    const user = JSON.parse(userStr);
    return { user, query: params };
  } catch (err) {
    console.error("getTelegramUserFromInitData parse error:", err);
    return null;
  }
}

// ----------------- Auth Middleware -----------------

/**
 * DEV version:
 *  1) Tries to parse real Telegram user from initData
 *  2) If it fails, falls back to a hardcoded dev user so DB still works
 */
function telegramAuthMiddleware(req, res, next) {
  const initData = req.body && req.body.initData;

  let tgUser = null;
  let params = null;

  if (!initData) {
    console.warn("telegramAuthMiddleware: missing initData – using DEV user");
  } else {
    const result = getTelegramUserFromInitData(initData);
    if (result && result.user) {
      tgUser = result.user;
      params = result.query;
      console.log(
        "telegramAuthMiddleware: parsed Telegram user",
        tgUser.id,
        tgUser.username
      );
    } else {
      console.warn(
        "telegramAuthMiddleware: could not parse initData – using DEV user"
      );
    }
  }

  if (!tgUser) {
    // Fallback dev user
    tgUser = {
      id: 999999999,
      username: "dev_user",
      first_name: "Dev",
      last_name: "User",
      language_code: "en",
    };
  }

  req.tgUser = tgUser;

  // Extract referral code from initData (?start=ref_123)
  let refCode = null;
  try {
    if (params) {
      // Sometimes Telegram sends "start" param, sometimes "start_param"
      const startParam = params.get("start_param") || params.get("start");
      if (startParam) {
        if (startParam.startsWith("ref_")) {
          refCode = startParam.substring(4);
        } else {
          refCode = startParam.trim();
        }
      }
    }
  } catch (e) {
    console.warn("Failed to parse start_param from initData:", e);
  }
  req.refCode = refCode;

  next();
}

// ----------------- DB Init -----------------

async function initDb() {
  // Main users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      language_code TEXT,
      balance BIGINT DEFAULT 0,
      energy INT DEFAULT 50,
      today_farmed BIGINT DEFAULT 0,
      last_daily DATE,
      last_reset DATE,
      taps_today INT DEFAULT 0,
      last_tap_at TIMESTAMPTZ,
      referrals_count INT DEFAULT 0,
      referrals_points BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Ensure new columns exist for older deployments
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS referrals_count INT DEFAULT 0,
      ADD COLUMN IF NOT EXISTS referrals_points BIGINT DEFAULT 0;
  `);

  console.log("✅ DB init complete");
}

// ----------------- Core User Logic -----------------

// Get or create a user record based on Telegram user object
async function getOrCreateUser(tgUser, refCode = null) {
  const telegramId = tgUser.id;

  const existing = await pool.query(
    "SELECT * FROM users WHERE telegram_id = $1",
    [telegramId]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const languageCode = tgUser.language_code || null;
  const username = tgUser.username || null;
  const firstName = tgUser.first_name || null;
  const lastName = tgUser.last_name || null;

  const insert = await pool.query(
    `
      INSERT INTO users (
        telegram_id,
        username,
        first_name,
        last_name,
        language_code,
        balance,
        energy,
        today_farmed,
        last_reset,
        taps_today
      )
      VALUES ($1, $2, $3, $4, $5, 0, 50, 0, $6, 0)
      RETURNING *;
    `,
    [telegramId, username, firstName, lastName, languageCode, todayDate()]
  );

  const newUser = insert.rows[0];
  console.log("Created new user", telegramId, "with id", newUser.id);

  // Apply referral reward once, when a new user is created with a valid refCode
  if (refCode) {
    const refTelegramId = Number(refCode);
    if (!Number.isNaN(refTelegramId) && refTelegramId !== telegramId) {
      try {
        const refUpdate = await pool.query(
          `
            UPDATE users
            SET balance = balance + $1,
                referrals_count = COALESCE(referrals_count, 0) + 1,
                referrals_points = COALESCE(referrals_points, 0) + $1,
                updated_at = NOW()
            WHERE telegram_id = $2
            RETURNING id, telegram_id, balance, referrals_count, referrals_points;
          `,
          [REFERRAL_REWARD, refTelegramId]
        );

        if (refUpdate.rows.length > 0) {
          const r = refUpdate.rows[0];
          console.log(
            "Referral reward",
            REFERRAL_REWARD,
            "to",
            r.telegram_id,
            "new referrals_count=",
            r.referrals_count,
            "referrals_points=",
            r.referrals_points,
            "from new user",
            telegramId
          );
        } else {
          console.log(
            "RefCode provided but no referrer found for telegram_id",
            refTelegramId
          );
        }
      } catch (err) {
        console.error(
          "Error applying referral reward for refCode",
          refCode,
          err
        );
      }
    }
  }

  return newUser;
}

// Ensure daily reset has run for this user
async function refreshDailyState(user) {
  const today = todayDate();
  let needsUpdate = false;
  let energy = user.energy;
  let todayFarmed = user.today_farmed;
  let tapsToday = user.taps_today;

  if (!user.last_reset || user.last_reset.toISOString().slice(0, 10) !== today) {
    // New day: reset daily counters and refill energy
    energy = 50;
    todayFarmed = 0;
    tapsToday = 0;
    needsUpdate = true;
  }

  if (!needsUpdate) return user;

  const upd = await pool.query(
    `
      UPDATE users
      SET energy = $1,
          today_farmed = $2,
          taps_today = $3,
          last_reset = $4,
          updated_at = NOW()
      WHERE id = $5
      RETURNING *;
    `,
    [energy, todayFarmed, tapsToday, today, user.id]
  );

  return upd.rows[0];
}

// Apply one tap: decrement energy and add to balance/today
async function applyTap(user, perTap = 1) {
  if (user.energy <= 0) {
    return user;
  }

  const newEnergy = user.energy - 1;
  const newBalance = Number(user.balance || 0) + perTap;
  const newToday = Number(user.today_farmed || 0) + perTap;
  const newTapsToday = Number(user.taps_today || 0) + 1;

  const upd = await pool.query(
    `
      UPDATE users
      SET balance = $1,
          energy = $2,
          today_farmed = $3,
          taps_today = $4,
          last_tap_at = NOW(),
          updated_at = NOW()
      WHERE id = $5
      RETURNING *;
    `,
    [newBalance, newEnergy, newToday, newTapsToday, user.id]
  );

  return upd.rows[0];
}

// Build state object sent back to frontend
function buildClientState(user) {
  const inviteLink = `https://t.me/${BOT_USERNAME}?start=ref_${user.telegram_id}`;
  return {
    ok: true,
    balance: Number(user.balance || 0),
    energy: Number(user.energy || 0),
    today: Number(user.today_farmed || 0),
    invite_link: inviteLink,
    referrals_count: Number(user.referrals_count || 0),
    referrals_points: Number(user.referrals_points || 0),
  };
}

// ----------------- Telegram Bot Logic -----------------

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const tgUser = ctx.from;
  const payload = (ctx.startPayload || "").trim(); // referral code if any

  // Strip "ref_" prefix if present
  let refCode = null;
  if (payload) {
    if (payload.startsWith("ref_")) {
      refCode = payload.substring(4);
    } else {
      refCode = payload;
    }
  }

  try {
    let user = await getOrCreateUser(tgUser, refCode || null);
    user = await refreshDailyState(user);

    const webAppUrl = "https://resilient-kheer-041b8c.netlify.app";

    await ctx.reply(
      "🔥 Welcome to Airdrop Empire!\nTap below to open the game 👇",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🚀 Open Airdrop Empire",
                web_app: { url: webAppUrl },
              },
            ],
          ],
        },
      }
    );
  } catch (err) {
    console.error("Error in /start:", err);
    await ctx.reply("Something went wrong. Please try again in a moment.");
  }
});

// Simple /help
bot.help((ctx) => ctx.reply("Just hit /start to open the mini app."));

// Launch the bot
bot.launch().then(() => {
  console.log("🤖 Telegram bot launched");
});

// ----------------- Express API for Mini App -----------------

const app = express();
app.use(cors());
app.use(express.json());

// Basic health check
app.get("/", (req, res) => {
  res.send("Airdrop Empire backend is live");
});

// ---- /api/state ----
app.post("/api/state", telegramAuthMiddleware, async (req, res) => {
  try {
    const tgUser = req.tgUser;
    console.log("/api/state hit for user", tgUser && tgUser.id);

    let dbUser = await getOrCreateUser(tgUser, req.refCode || null);
    dbUser = await refreshDailyState(dbUser);

    const clientState = buildClientState(dbUser);
    return res.json(clientState);
  } catch (err) {
    console.error("/api/state error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---- /api/tap ----
app.post("/api/tap", telegramAuthMiddleware, async (req, res) => {
  try {
    const tgUser = req.tgUser;

    let dbUser = await getOrCreateUser(tgUser);
    dbUser = await refreshDailyState(dbUser);

    if (dbUser.energy <= 0) {
      console.log("/api/tap: no energy for user", dbUser.telegram_id);
      const clientState = buildClientState(dbUser);
      return res.json(clientState);
    }

    dbUser = await applyTap(dbUser, 1);
    const clientState = buildClientState(dbUser);
    return res.json(clientState);
  } catch (err) {
    console.error("/api/tap error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---- /api/task ----
const TASK_REWARDS = {
  daily: 500,
  join_tg: 1000,
  invite_friend: 1500, // we now pay referrals via REFERRAL_REWARD when friends join
};

app.post("/api/task", telegramAuthMiddleware, async (req, res) => {
  try {
    const tgUser = req.tgUser;
    const code = (req.body && req.body.code) || "unknown";
    const reward = TASK_REWARDS[code] || 0;

    let dbUser = await getOrCreateUser(tgUser);
    dbUser = await refreshDailyState(dbUser);

    // Only apply real balance boosts for non-referral tasks
    if (reward > 0 && code !== "invite_friend") {
      const newBalance = Number(dbUser.balance || 0) + reward;
      const newToday = Number(dbUser.today_farmed || 0) + reward;

      const upd = await pool.query(
        `
          UPDATE users
          SET balance = $1,
              today_farmed = $2,
              updated_at = NOW()
          WHERE id = $3
          RETURNING *;
        `,
        [newBalance, newToday, dbUser.id]
      );

      dbUser = upd.rows[0];
      console.log(
        "/api/task",
        code,
        "reward",
        reward,
        "user",
        dbUser.telegram_id
      );
    } else if (code === "invite_friend") {
      // Frontend just opens the Friends sheet; referrals are paid when new users sign up.
      console.log("/api/task invite_friend hit – no direct reward, handled via referrals");
    }

    const clientState = buildClientState(dbUser);
    return res.json(clientState);
  } catch (err) {
    console.error("/api/task error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---- /api/friends ----
app.post("/api/friends", telegramAuthMiddleware, async (req, res) => {
  try {
    const tgUser = req.tgUser;

    let dbUser = await getOrCreateUser(tgUser);
    dbUser = await refreshDailyState(dbUser);

    const clientState = buildClientState(dbUser);
    return res.json(clientState);
  } catch (err) {
    console.error("/api/friends error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---- /api/withdraw/info ----
app.post("/api/withdraw/info", telegramAuthMiddleware, async (req, res) => {
  try {
    const tgUser = req.tgUser;

    let dbUser = await getOrCreateUser(tgUser);
    dbUser = await refreshDailyState(dbUser);

    const clientState = buildClientState(dbUser);
    return res.json(clientState);
  } catch (err) {
    console.error("/api/withdraw/info error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ----------------- Server Start -----------------

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

// Graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// Initialize DB on startup
initDb().catch((err) => {
  console.error("Failed to init DB:", err);
  process.exit(1);
});
