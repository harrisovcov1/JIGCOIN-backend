"use strict";

const crypto = require("node:crypto");
const CODES = Object.freeze([
  "sp_visit_partner", "sp_watch_content", "sp_watch_earn", "sp_claim_reward", "sp_bonus_mission",
]);
const BOOST_CODES = Object.freeze(["sp_emergency_energy", "sp_double_points"]);
const ALL_CODES = Object.freeze([...CODES, ...BOOST_CODES]);
const rewardFor = code => CODES.includes(code)
  ? { kind: "coins", amount: 200, cooldown: 86400, label: "+200 coins" }
  : code === BOOST_CODES[0]
    ? { kind: "energy_refill", amount: 0, cooldown: 86400, label: "Full energy refill" }
    : { kind: "double_10m", amount: 0, cooldown: 86400, label: "Double points for 10 minutes" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const yes = value => /^(1|true)$/i.test(String(value || ""));
const fail = (code, status = 400, details = {}) => Object.assign(new Error(code), { code, status, details });
const remaining = (end, now) => end ? Math.max(0, Math.ceil((new Date(end).getTime() - now) / 1000)) : 0;

function createMonetagRewards({ pool, withTransaction, applyBalanceChangeTx, env = process.env, getEnergyCap = user => Number(user.max_energy || 50) }) {
  const zone = String(env.MONETAG_ZONE_ID || "");
  const secret = String(env.MONETAG_POSTBACK_SECRET || "");
  const configured = /^[1-9][0-9]{0,14}$/.test(zone) && /^[A-Za-z0-9]{32,128}$/.test(secret);
  const enabled = configured && yes(env.MONETAG_REWARDS_ENABLED) &&
    !yes(env.DISABLE_AD_REWARDS) && !yes(env.DISABLE_SPONSOR_MISSIONS);
  const manages = code => ALL_CODES.includes(code);
  const requireEnabled = () => { if (!enabled) throw fail("AD_REWARDS_UNAVAILABLE", 503); };

  async function mission(client, code) {
    if (!manages(code)) throw fail("INVALID_REWARD_PLACEMENT");
    const { rows } = await client.query(
      "SELECT id FROM public.missions WHERE code=$1 AND is_active=TRUE AND kind='sponsor'", [code]);
    if (!rows[0]) throw fail("MISSION_NOT_FOUND_OR_INACTIVE", 404);
    return rows[0];
  }

  // All starts/claims lock the same user, then placement, then attempt. The
  // callback only locks its attempt and never touches balances or placements.
  async function lockedPlacement(client, user, code, missionId) {
    const locked = await client.query("SELECT *, clock_timestamp() AS db_now FROM public.users WHERE id=$1 FOR UPDATE", [user.id]);
    if (!locked.rows[0]) throw fail("USER_NOT_FOUND", 404);
    await client.query(`
      INSERT INTO jigcoin_internal.reward_placements
        (user_id, code, cycle_id, claimed_at, next_available_at)
      SELECT $1,$2,$3,um.claimed_at,um.claimed_at + make_interval(secs=>$5)
      FROM (SELECT 1) AS seed
      LEFT JOIN public.user_missions um ON um.user_id=$1 AND um.mission_id=$4
      ON CONFLICT (user_id,code) DO NOTHING`, [user.id, code, crypto.randomUUID(), missionId, rewardFor(code).cooldown]);
    const { rows } = await client.query(`SELECT *, clock_timestamp() AS db_now
      FROM jigcoin_internal.reward_placements WHERE user_id=$1 AND code=$2 FOR UPDATE`, [user.id, code]);
    return { ...rows[0], user: locked.rows[0] };
  }

  async function start(user, code) {
    requireEnabled();
    return withTransaction(async client => {
      const m = await mission(client, code);
      let placement = await lockedPlacement(client, user, code, m.id);
      const now = new Date(placement.db_now).getTime();
      const reward = rewardFor(code);
      if (reward.kind === "energy_refill" && Number(placement.user.energy) >= getEnergyCap(placement.user)) throw fail("ENERGY_FULL", 409);
      if (reward.kind === "double_10m" && new Date(placement.user.double_boost_until).getTime() > now) throw fail("DOUBLE_ACTIVE", 409);
      const cooldown = remaining(placement.next_available_at, now);
      if (cooldown) throw fail("MISSION_COOLDOWN", 409, { cooldown_remaining_seconds: cooldown });
      if (placement.claimed_at) {
        const { rows } = await client.query(`UPDATE jigcoin_internal.reward_placements
          SET cycle_id=$3, claimed_at=NULL, next_available_at=NULL
          WHERE user_id=$1 AND code=$2 RETURNING *`, [user.id, code, crypto.randomUUID()]);
        placement = rows[0];
      }
      const existing = await client.query(`SELECT * FROM jigcoin_internal.ad_attempts
        WHERE user_id=$1 AND code=$2 AND cycle_id=$3 AND claimed_at IS NULL AND expires_at>clock_timestamp()
        ORDER BY (eligible_at IS NOT NULL) DESC, created_at DESC LIMIT 1`, [user.id, code, placement.cycle_id]);
      const previous = existing.rows[0];
      if (previous?.eligible_at) throw fail("REWARD_ALREADY_READY", 409);
      const retry = previous ? remaining(new Date(new Date(previous.created_at).getTime() + 60000), now) : 0;
      if (retry) throw fail("AD_RETRY_LATER", 429, { retry_after_seconds: retry });

      // Fresh ymid for EVERY display; never reuse a token after a timeout or retry.
      const ymid = crypto.randomUUID();
      await client.query(`INSERT INTO jigcoin_internal.ad_attempts
        (ymid,user_id,code,cycle_id,zone_id,telegram_id,reward_amount,cooldown_seconds,reward_kind,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+interval '48 hours')`,
      [ymid, user.id, code, placement.cycle_id, zone, String(user.telegram_id), reward.amount, reward.cooldown, reward.kind]);
      return { ok: true, provider: "monetag", zone_id: zone, ymid, request_var: code, payout_amount: reward.amount, payout_type: reward.kind, reward_label: reward.label };
    });
  }

  async function decorateMissions(user, missions) {
    const codes = missions.filter(m => manages(m.code)).map(m => m.code);
    let states = [];
    if (enabled && codes.length) {
      const result = await pool.query(`SELECT m.code, clock_timestamp() AS db_now,
        COALESCE(p.next_available_at,um.claimed_at+interval '24 hours') AS next_available_at,
        a.ymid,a.created_at AS attempt_created_at,a.eligible_at
        FROM public.missions m
        LEFT JOIN public.user_missions um ON um.user_id=$1 AND um.mission_id=m.id
        LEFT JOIN jigcoin_internal.reward_placements p ON p.user_id=$1 AND p.code=m.code
        LEFT JOIN LATERAL (
          SELECT ymid,created_at,eligible_at FROM jigcoin_internal.ad_attempts
          WHERE user_id=$1 AND code=m.code AND cycle_id=p.cycle_id
            AND claimed_at IS NULL AND expires_at>clock_timestamp()
          ORDER BY (eligible_at IS NOT NULL) DESC, created_at DESC LIMIT 1
        ) a ON p.claimed_at IS NULL
        WHERE m.code=ANY($2::text[])`, [user.id, codes]);
      states = result.rows;
    }
    return missions.map(m => {
      if (!manages(m.code)) {
        // Other sponsor/boost missions require their own verified adapter.
        if (m.kind === "sponsor" || String(m.code).startsWith("sp_")) {
          return { ...m, status: "unavailable", url: "", cooldown_remaining_seconds: 0, wait_remaining_seconds: 0 };
        }
        return m;
      }
      const s = states.find(row => row.code === m.code);
      const now = s ? new Date(s.db_now).getTime() : Date.now();
      const cooldown = remaining(s?.next_available_at, now);
      const retry = s?.attempt_created_at ? remaining(new Date(new Date(s.attempt_created_at).getTime() + 60000), now) : 0;
      let status = enabled ? "available" : "unavailable";
      if (enabled && cooldown) status = "cooldown";
      else if (enabled && s?.eligible_at) status = "claimable";
      else if (enabled && retry) status = "pending";
      const reward = rewardFor(m.code);
      return { ...m, title: reward.kind === "coins" ? `Daily ad bonus ${CODES.indexOf(m.code) + 1}` : reward.label,
        description: reward.kind === "coins" ? "View an eligible ad, then claim 200 coins. Available again 24 hours after claiming." : "View an eligible ad, then claim this boost. Available again 24 hours after claiming.",
        provider: "monetag", zone_id: zone, url: "", status, payout_amount: reward.amount, payout_type: reward.kind, reward_label: reward.label,
        cooldown_hours: reward.cooldown / 3600, cooldown_remaining_seconds: cooldown, wait_remaining_seconds: 0,
        retry_after_seconds: retry, attempt_id: status === "claimable" ? s.ymid : null };
    });
  }

  function validatePostback(q) {
    if (!configured) throw fail("MONETAG_NOT_CONFIGURED", 503);
    if (typeof q.secret !== "string" || !/^[A-Za-z0-9]{32,128}$/.test(q.secret) || q.secret.length !== secret.length ||
        !crypto.timingSafeEqual(Buffer.from(q.secret), Buffer.from(secret))) throw fail("FORBIDDEN", 403);
    const field = (name, pattern, optional = false) => {
      const value = q[name];
      if (optional && value === "") return value;
      if (typeof value !== "string" || !pattern.test(value)) throw fail("INVALID_POSTBACK", 400);
      return value;
    };
    const event = {
      ymid: field("ymid", UUID), zone: field("zone_id", /^[1-9][0-9]{0,14}$/),
      subZone: field("sub_zone_id", /^[1-9][0-9]{0,14}$/),
      telegramId: field("telegram_id", /^[1-9][0-9]{0,19}$/, true),
      code: field("request_var", /^[a-z0-9_]{1,64}$/),
      type: field("event_type", /^(impression|click)$/),
      reward: field("reward_event_type", /^(valued|non_valued)$/),
      price: field("estimated_price", /^\d{1,12}(?:\.\d{1,7})?$/),
    };
    // Only the intended rewarded-interstitial format can unlock these quests.
    if (event.zone !== zone || event.subZone !== zone || !manages(event.code)) throw fail("WRONG_AD_PLACEMENT", 400);
    return event;
  }

  async function postback(query) {
    const event = validatePostback(query);
    return withTransaction(async client => {
      const { rows } = await client.query(`SELECT *, clock_timestamp() AS db_now
        FROM jigcoin_internal.ad_attempts WHERE ymid=$1 FOR UPDATE`, [event.ymid]);
      const attempt = rows[0];
      if (!attempt) throw fail("UNKNOWN_AD_ATTEMPT", 404);
      if (attempt.code !== event.code || attempt.zone_id !== event.zone ||
          (event.telegramId && attempt.telegram_id !== event.telegramId)) throw fail("AD_OWNER_MISMATCH", 403);
      await client.query(`INSERT INTO jigcoin_internal.monetag_events
        (attempt_id,event_type,reward_event_type,sub_zone_id,estimated_price)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [attempt.id, event.type, event.reward, event.subZone, event.price]);
      if (event.reward === "valued" && new Date(attempt.expires_at) > new Date(attempt.db_now)) {
        await client.query(`UPDATE jigcoin_internal.ad_attempts
          SET eligible_at=COALESCE(eligible_at,clock_timestamp()) WHERE id=$1`, [attempt.id]);
      }
      return { ok: true }; // The transaction must COMMIT before HTTP 200.
    });
  }

  async function claim(user, code, ymid) {
    requireEnabled();
    if (typeof ymid !== "string" || !UUID.test(ymid)) throw fail("AD_ATTEMPT_REQUIRED");
    return withTransaction(async client => {
      const m = await mission(client, code);
      const p = await lockedPlacement(client, user, code, m.id);
      const { rows } = await client.query(`SELECT * FROM jigcoin_internal.ad_attempts
        WHERE ymid=$1 AND user_id=$2 AND code=$3 FOR UPDATE`, [ymid, user.id, code]);
      const a = rows[0];
      if (!a) throw fail("AD_ATTEMPT_NOT_FOUND", 404);
      if (a.claimed_at) return { ok: true, already_claimed: true, payout_amount: a.reward_amount, payout_type: a.reward_kind, reward_label: rewardFor(code).label };
      const now = new Date(p.db_now).getTime();
      const cooldown = remaining(p.next_available_at, now);
      if (cooldown) throw fail("MISSION_COOLDOWN", 409, { cooldown_remaining_seconds: cooldown });
      if (a.cycle_id !== p.cycle_id || p.claimed_at || remaining(a.expires_at, now) === 0) throw fail("AD_ATTEMPT_EXPIRED", 409);
      if (!a.eligible_at) throw fail("AD_CONFIRMATION_PENDING", 409);
      let ledgerId = null, fulfillment = null;
      if (a.reward_kind === "coins") {
        const credit = await applyBalanceChangeTx(client, {
          userId: user.id, delta: a.reward_amount, reason: "monetag_reward",
          refType: "monetag_attempt", refId: a.id, eventType: "mission_payout",
        });
        ledgerId = credit.ledgerId;
      } else if (a.reward_kind === "energy_refill") {
        const cap = getEnergyCap(p.user);
        if (!Number.isSafeInteger(cap) || cap < 1 || cap > 100000) throw fail("INVALID_ENERGY_CAP", 503);
        await client.query("UPDATE public.users SET energy=$2,last_energy_ts=clock_timestamp() WHERE id=$1", [user.id, cap]);
        fulfillment = { kind: a.reward_kind, energy: cap };
      } else if (a.reward_kind === "double_10m") {
        if (new Date(p.user.double_boost_until).getTime() > now) throw fail("DOUBLE_ACTIVE", 409);
        const boost = await client.query("UPDATE public.users SET double_boost_until=clock_timestamp()+interval '10 minutes' WHERE id=$1 RETURNING double_boost_until", [user.id]);
        fulfillment = { kind: a.reward_kind, until: boost.rows[0].double_boost_until };
      } else throw fail("INVALID_REWARD_PLACEMENT", 503);
      const recorded = await client.query(`UPDATE jigcoin_internal.ad_attempts
        SET claimed_at=clock_timestamp(),ledger_id=$2,fulfillment=$3::jsonb WHERE id=$1 RETURNING claimed_at::text AS claimed_at`,
        [a.id, ledgerId, fulfillment ? JSON.stringify(fulfillment) : null]);
      const claimedAt = recorded.rows[0].claimed_at;
      const saved = await client.query(`UPDATE jigcoin_internal.reward_placements
        SET claimed_at=$4,next_available_at=$4::timestamptz+make_interval(secs=>$3)
        WHERE user_id=$1 AND code=$2 RETURNING next_available_at`, [user.id, code, a.cooldown_seconds, claimedAt]);
      // Maintain existing quest/referral completion statistics without trusting
      // legacy timers. Failure here rolls back the credit and cooldown too.
      await client.query(`INSERT INTO public.user_missions
        (user_id,mission_id,status,started_at,completed_at,verified_at,claimed_at,reward_applied)
        VALUES ($1,$2,'completed',$3,$5,$4,$5,TRUE)
        ON CONFLICT (user_id,mission_id) DO UPDATE SET status='completed',started_at=EXCLUDED.started_at,
          completed_at=EXCLUDED.completed_at,verified_at=EXCLUDED.verified_at,
          claimed_at=EXCLUDED.claimed_at,reward_applied=TRUE`, [user.id, m.id, a.created_at, a.eligible_at, claimedAt]);
      return { ok: true, payout_amount: a.reward_amount, payout_type: a.reward_kind, reward_label: rewardFor(code).label, fulfillment, cooldown_remaining_seconds: a.cooldown_seconds,
        next_available_at: saved.rows[0].next_available_at };
    });
  }

  const handler = fn => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { const result = await fn(req); return res.headersSent ? undefined : res.json(result); }
    catch (error) {
      // Never print the query, secret, SQL bindings or raw database exceptions.
      const expected = Number.isInteger(error.status);
      if (!expected) console.error("Monetag operation failed", { code: error.code || "INTERNAL" });
      return res.status(expected ? error.status : 503).json({ ok: false,
        error: expected ? (error.code || (error.status === 401 ? "UNAUTHORIZED" : "INVALID_REQUEST")) : "REWARD_SERVICE_UNAVAILABLE", ...(expected ? error.details : {}) });
    }
  };
  return { manages, enabled, start, claim, postback, decorateMissions, handler };
}

module.exports = { createMonetagRewards, CODES, BOOST_CODES, ALL_CODES };
