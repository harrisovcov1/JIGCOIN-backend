"use strict";

// All displayed rates come from the same policy used for actual new awards.
const {VERSION,WELCOME_COINS,TIERS,currentTier,nextReward}=require("./referralPolicy");
const nonnegative = value => {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("INVITE_DATA_INVALID");
  return number;
};

function createInvite({pool,botUsername,strictActivation,minTaps}) {
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
    const tier = currentTier(count);
    const nextAt = TIERS.map(t=>t.at).find(value => value > count) ?? null;
    const previousAt = [...TIERS].reverse().find(t=>t.at<=count)?.at ?? 0;
    const username = String(botUsername || "").replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error("INVITE_CONFIG_INVALID");
    const taps = Number(minTaps);
    if (strictActivation && (!Number.isSafeInteger(taps) || taps < 1)) throw new Error("INVITE_CONFIG_INVALID");
    return {
      ok:true, telegram_id:telegramId, server_now:new Date().toISOString(),
      invite_link:`https://t.me/${username}?startapp=ref_${telegramId}`,
      policy_version:VERSION,welcome_coins:WELCOME_COINS,
      reward_coins:nextReward(count), friends_rewarded:count, coins_earned:coins,
      tier_name:tier.name, next_at:nextAt, previous_at:previousAt,
      next_reward_coins:nextAt === null ? null : nextReward(nextAt-1),
      next_tier_name:nextAt === null ? null : TIERS.find(t=>t.at===nextAt).name,
      qualification:{mode:strictActivation ? "activity" : "join", min_taps:strictActivation ? taps : null},
      tiers:TIERS.map(t=>({...t}))
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
