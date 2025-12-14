// index.js
// Airdrop Empire – Backend Engine (FIXED + STABLE)

const express = require("express");
const cors = require("cors");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_USERNAME = process.env.BOT_USERNAME || "AirdropEmpireAppBot";
const DISABLE_BOT_POLLING = String(process.env.DISABLE_BOT_POLLING || "") === "1";

if (!BOT_TOKEN || !DATABASE_URL) {
  console.error("❌ Missing env vars");
  process.exit(1);
}

// ================= DB =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================= BOT =================
const bot = new Telegraf(BOT_TOKEN);
if (!DISABLE_BOT_POLLING) bot.launch();

// ================= SCHEMA (RUN ONCE) =================
let schemaReady = false;

async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        points BIGINT DEFAULT 0,
        energy INT DEFAULT 50,
        last_tap TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS missions (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        reward_type TEXT NOT NULL,
        reward_amount INT NOT NULL,
        url TEXT,
        mission_type TEXT DEFAULT 'generic',
        active BOOLEAN DEFAULT true,
        cooldown_seconds INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE missions
      DROP CONSTRAINT IF EXISTS missions_active_requires_reward_fields;
    `);

    // seed ONE safe mission
    await client.query(`
      INSERT INTO missions (code, title, description, reward_type, reward_amount)
      VALUES ('tap_basic', 'Tap to earn', 'Earn points by tapping', 'points', 1)
      ON CONFLICT (code) DO NOTHING;
    `);

    schemaReady = true;
    console.log("✅ Schema ready");
  } finally {
    client.release();
  }
}

async function ensureSchemaOnce() {
  if (!schemaReady) {
    await ensureSchema();
  }
}

// ================= HELPERS =================
async function getOrCreateUser(userId) {
  const { rows } = await pool.query(
    `INSERT INTO users (id)
     VALUES ($1)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING *`,
    [userId]
  );
  return rows[0];
}

// ================= API =================
app.get("/api/health", async (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/state", async (req, res) => {
  try {
    await ensureSchemaOnce();
    const userId = Number(req.body.userId);
    const user = await getOrCreateUser(userId);
    res.json({ user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "state_failed" });
  }
});

app.post("/api/tap", async (req, res) => {
  try {
    await ensureSchemaOnce();
    const userId = Number(req.body.userId);

    const user = await getOrCreateUser(userId);

    if (user.energy <= 0) {
      return res.json({ ok: false, reason: "no_energy" });
    }

    const updated = await pool.query(
      `
      UPDATE users
      SET
        points = points + 1,
        energy = energy - 1,
        last_tap = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [userId]
    );

    res.json({ ok: true, user: updated.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "tap_failed" });
  }
});

app.get("/api/leaderboard", async (_req, res) => {
  try {
    await ensureSchemaOnce();
    const { rows } = await pool.query(
      `SELECT id, points FROM users ORDER BY points DESC LIMIT 50`
    );
    res.json({ leaderboard: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "leaderboard_failed" });
  }
});

// ================= START =================
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  await ensureSchemaOnce();
  console.log("🚀 Server running on", PORT);
});
