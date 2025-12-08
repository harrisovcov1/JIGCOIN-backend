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
const REFERRAL_REWARD = 800;

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

// ----------------- Helpers -----------------

function todayDate() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

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
    if (!userStr) return null;

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
        "telegramAuthMiddleware: initData present but parsing failed – using DEV user"
      );
    }
  }

  if (!tgUser) {
    // DEV fallback user
    tgUser = {
      id: 999999,
      is_bot: false,
      first_name: "DEV",
      username: "dev_user",
      language_code: "en",
    };
  }

  req.tgUser = tgUser;

  // Extract referral code from initData (?start=ref_123)
  let refCode = null;
  try {
    if (params) {
      // Sometimes Telegram sends "start" param, sometimes "start_param"
      const startParam =
        params.get("start") || params.get("start_param") || null;
      if (startParam && typeof startParam === "string") {
        refCode = startParam.trim();
        if (refCode.startsWith("ref_")) {
          refCode = refCode.slice(4); // keep only the numeric part
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

  // Referrals table for friends leaderboard / referral graph
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      referrer_telegram_id BIGINT NOT NULL,
      referred_telegram_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (referrer_telegram_id, referred_telegram_id)
    );
  `);

  console.log("✅ DB init complete");
}

// ----------------- Core User Logic -----------------

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

        // Track referral edge for friends leaderboard
        await pool.query(
          `
            INSERT INTO referrals (referrer_telegram_id, referred_telegram_id)
            VALUES ($1, $2)
            ON CONFLICT (referrer_telegram_id, referred_telegram_id) DO NOTHING;
          `,
          [refTelegramId, telegramId]
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
  let lastReset = user.last_reset;

  if (lastReset !== today) {
    console.log(
      "Daily reset for user",
      user.telegram_id,
      "prev last_reset=",
      lastReset,
      "new last_reset=",
      today
    );
    energy = 50;
    todayFarmed = 0;
    tapsToday = 0;
    lastReset = today;
    needsUpdate = true;
  }

  if (needsUpdate) {
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
      [energy, todayFarmed, tapsToday, lastReset, user.id]
    );
    return upd.rows[0];
  }

  return user;
}

// Apply a tap – naive anti-bot (daily tap cap)
async function applyTap(user, perTap) {
  const maxDailyTaps = 5000;
  const tapsToday = Number(user.taps_today || 0);

  if (tapsToday >= maxDailyTaps) {
    console.log(
      "User",
      user.telegram_id,
      "reached daily tap cap:",
      maxDailyTaps
    );
    return user;
  }

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
      refCode = payload.slice(4);
    } else {
      refCode = payload;
    }
  }

  console.log("Bot /start from", tgUser.id, "with refCode =", refCode);

  try {
    const dbUser = await getOrCreateUser(tgUser, refCode);

    await ctx.reply(
      "🔥 Welcome to Airdrop Empire!\n\nTap below to open the game 👇",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🚀 Open Airdrop Empire",
                web_app: {
                  url: "https://resilient-kheer-041b8c.netlify.app",
                },
              },
            ],
          ],
        },
      }
    );
  } catch (err) {
    console.error("/start error:", err);
    await ctx.reply("Something went wrong. Please try again later.");
  }
});

bot.command("referral", async (ctx) => {
  const tgUser = ctx.from;
  const telegramId = tgUser.id;
  const inviteLink = `https://t.me/${BOT_USERNAME}?start=ref_${telegramId}`;
  await ctx.reply(
    `🔗 Your referral link:\n${inviteLink}\n\nShare this with friends and earn +${REFERRAL_REWARD} when they join!`
  );
});

// ----------------- Express App -----------------

const app = express();
app.use(cors());
app.use(express.json());

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
app.post("/api/task", telegramAuthMiddleware, async (req, res) => {
  try {
    const tgUser = req.tgUser;
    const { code } = req.body || {};
    console.log("/api/task hit", code, "for user", tgUser && tgUser.id);

    let dbUser = await getOrCreateUser(tgUser);
    dbUser = await refreshDailyState(dbUser);

    // Simple task handling – extend later for more quests
    let reward = 0;
    if (code === "daily_checkin") {
      const today = todayDate();
      if (dbUser.last_daily === today) {
        console.log("User already claimed daily_checkin today", dbUser.id);
      } else {
        reward = 1000;
        const upd = await pool.query(
          `
            UPDATE users
            SET balance = balance + $1,
                last_daily = $2,
                updated_at = NOW()
            WHERE id = $3
            RETURNING *;
          `,
          [reward, today, dbUser.id]
        );
        dbUser = upd.rows[0];
        console.log(
          "daily_checkin rewarded",
          reward,
          "to user",
          dbUser.telegram_id
        );
      }
    }

    if (code === "instagram_follow") {
      reward = 500;
    }

    if (code === "invite_friend") {
      // Frontend just opens the Friends sheet; referrals are paid when new users sign up.
      console.log(
        "/api/task invite_friend hit – no direct reward, handled via referrals"
      );
    }

    // Only apply real balance boosts for non-referral tasks
    if (reward > 0 && code !== "invite_friend") {
      const newBalance = Number(dbUser.balance || 0) + reward;
      const upd = await pool.query(
        `
          UPDATE users
          SET balance = $1,
              updated_at = NOW()
          WHERE id = $2
          RETURNING *;
        `,
        [newBalance, dbUser.id]
      );
      dbUser = upd.rows[0];
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

// ---- /api/leaderboard ----
app.post("/api/leaderboard", telegramAuthMiddleware, async (req, res) => {
  try {
    const tgUser = req.tgUser;
    if (!tgUser || !tgUser.id) {
      return res.status(400).json({ ok: false, error: "NO_USER" });
    }
    const telegramId = tgUser.id;

    // Ensure user exists and daily state is up to date
    let dbUser = await getOrCreateUser(tgUser);
    dbUser = await refreshDailyState(dbUser);

    const myBalance = Number(dbUser.balance || 0);

    // Global top 100 by balance
    const globalRes = await pool.query(
      `
        SELECT telegram_id, username, balance
        FROM users
        WHERE balance IS NOT NULL
        ORDER BY balance DESC, id ASC
        LIMIT 100;
      `
    );

    const global = globalRes.rows.map((row, index) => ({
      telegram_id: Number(row.telegram_id),
      username: row.username,
      balance: Number(row.balance || 0),
      rank: index + 1,
      is_you: Number(row.telegram_id) === Number(telegramId),
    }));

    // Determine user's global rank
    let myRank = null;
    const inTop = global.find((r) => r.is_you);
    if (inTop) {
      myRank = inTop.rank;
    } else {
      const rankRes = await pool.query(
        `
          SELECT COUNT(*)::BIGINT AS higher
          FROM users
          WHERE balance > $1;
        `,
        [myBalance]
      );
      const higher = Number(
        (rankRes.rows[0] && rankRes.rows[0].higher) || 0
      );
      myRank = higher + 1;
    }

    // Friends leaderboard: users this player has referred
    let friends = [];
    try {
      const friendsRes = await pool.query(
        `
          SELECT u.telegram_id, u.username, u.balance
          FROM referrals r
          JOIN users u ON u.telegram_id = r.referred_telegram_id
          WHERE r.referrer_telegram_id = $1
          ORDER BY u.balance DESC, u.id ASC
          LIMIT 100;
        `,
        [telegramId]
      );

      friends = friendsRes.rows.map((row, index) => ({
        telegram_id: Number(row.telegram_id),
        username: row.username,
        balance: Number(row.balance || 0),
        rank: index + 1,
      }));
    } catch (err) {
      console.warn(
        "/api/leaderboard friends query failed (likely no referrals yet):",
        err.message
      );
    }

    return res.json({
      ok: true,
      me: {
        telegram_id: Number(dbUser.telegram_id),
        username: dbUser.username,
        balance: myBalance,
        rank: myRank,
      },
      global,
      friends,
    });
  } catch (err) {
    console.error("/api/leaderboard error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---- /api/withdraw/info ----
app.post("/api/withdraw/info", telegramAuthMiddleware, async (req, res) => {
  try {
    const tgUser = req.tgUser;

    let dbUser = await getOrCreateUser(tgUser);
    dbUser = await refreshDailyState(dbUser);

    return res.json({
      ok: true,
      balance: Number(dbUser.balance || 0),
      note: "Withdrawals not live yet; follow our Telegram channel.",
    });
  } catch (err) {
    console.error("/api/withdraw/info error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ----------------- Server Startup -----------------

async function start() {
  const PORT = process.env.PORT || 10000;

  app.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
  });

  await bot.launch();
  console.log("🤖 Telegram bot launched as @%s", BOT_USERNAME);

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  await initDb();
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
