"use strict";

// Read-only Invite view. Reward writes and existing tier economics are unchanged.
const TARGETS = [0, 1, 5, 20, 50, 200];
const NAMES = ["Starter", "Bronze", "Silver", "Gold", "Platinum", "Diamond"];
const nonnegative = value => {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("INVITE_DATA_INVALID");
  return number;
};

function createInvite({pool, getReferralTier, baseReward, botUsername,
  strictActivation, minTaps}) {
  function rate(count) {
    const value = Math.round(baseReward * getReferralTier(count).multiplier);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("INVITE_CONFIG_INVALID");
    return value;
  }
  function identity(user) {
    if (!user?.id || !/^[1-9]\d{0,15}$/.test(String(user.telegram_id)) ||
        !Number.isSafeInteger(Number(user.telegram_id))) {
      throw Object.assign(new Error("INVITE_ACCOUNT_INVALID"), {status:401});
    }
    return String(user.telegram_id);
  }
  async function summary(user) {
    const telegramId = identity(user);
    const count = nonnegative(user.referrals_count);
    const coins = nonnegative(user.referrals_points);
    const tier = getReferralTier(count).tier;
    const nextAt = TARGETS.find(value => value > count) ?? null;
    const previousAt = [...TARGETS].reverse().find(value => value <= count);
    const username = String(botUsername || "").replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error("INVITE_CONFIG_INVALID");
    const taps = Number(minTaps);
    if (strictActivation && (!Number.isSafeInteger(taps) || taps < 1)) throw new Error("INVITE_CONFIG_INVALID");
    return {
      ok:true, telegram_id:telegramId, server_now:new Date().toISOString(),
      invite_link:`https://t.me/${username}?startapp=ref_${telegramId}`,
      reward_coins:rate(count), friends_rewarded:count, coins_earned:coins,
      tier_name:NAMES[tier], next_at:nextAt, previous_at:previousAt,
      next_reward_coins:nextAt === null ? null : rate(nextAt),
      qualification:{mode:strictActivation ? "activity" : "join", min_taps:strictActivation ? taps : null},
      tiers:TARGETS.map((at, index)=>({at, name:NAMES[index], reward_coins:rate(at)}))
    };
  }
  async function history(user) {
    const telegramId = identity(user);
    // Actual balance credits, scoped to the authenticated internal user ID.
    // Older schemas may omit created_at: JSON extraction then yields null.
    const result = await pool.query(`SELECT id,delta,to_jsonb(l)->>'created_at' AS credited_at
      FROM public.user_balance_ledger l WHERE user_id=$1 AND reason='referral_reward'
      AND delta>0 ORDER BY id DESC LIMIT 10`, [user.id]);
    return {ok:true,telegram_id:telegramId,credits:result.rows.map(row=>({
      id:String(row.id),coins:nonnegative(row.delta),
      credited_at:row.credited_at && Number.isFinite(Date.parse(row.credited_at)) ? new Date(row.credited_at).toISOString() : null
    }))};
  }
  return {summary,history};
}

module.exports = {createInvite};
