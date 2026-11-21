"use strict";

// All displayed rates come from the same policy used for actual new awards.
const {ACTIVATION_VERSION,ACTIVATION_TAPS,WELCOME_COINS,TIERS,currentTier,nextReward}=require("./referralPolicy");
const nonnegative = value => {
  const number = Number(value || 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("INVITE_DATA_INVALID");
  return number;
};

function createInvite({pool,botUsername}) {
  function identity(user) {
    if (!user?.id || !/^[1-9]\d{0,15}$/.test(String(user.telegram_id)) ||
        !Number.isSafeInteger(Number(user.telegram_id))) {
      throw Object.assign(new Error("INVITE_ACCOUNT_INVALID"), {status:401});
    }
    return String(user.telegram_id);
  }
  async function account(user) {
    const telegramId=identity(user);
    const saved=(await pool.query(`SELECT id,telegram_id,referrals_count,referrals_points
      FROM public.users WHERE id=$1 AND telegram_id=$2`,[user.id,telegramId])).rows[0];
    if(!saved)throw Object.assign(new Error("INVITE_ACCOUNT_INVALID"),{status:401});
    return saved;
  }
  async function progress(user) {
    // A single snapshot keeps joined/qualified/rewarded totals and the latest
    // friends and the incoming invitation consistent. Only relationships of
    // the authenticated account enter this query; private IDs stay server-side.
    const row=(await pool.query(`WITH source AS MATERIALIZED (
      SELECT r.id,r.inviter_id=$2 AS outgoing,r.invited_id=$2 AS incoming,
        CASE WHEN r.inviter_id=$2
          THEN LEFT(COALESCE(NULLIF(f.username,''),NULLIF(f.first_name,''),'Friend'),48)
          ELSE LEFT(COALESCE(NULLIF(i.username,''),NULLIF(i.first_name,''),'Friend'),48) END AS display_name,
        COALESCE(c16.registered_at,c10.registered_at,c9.registered_at,r.created_at AT TIME ZONE 'UTC') AS joined_at,
        COALESCE(c16.awarded_at,c10.awarded_at,c9.awarded_at,r.credited_at) AS rewarded_at,
        CASE WHEN c16.referral_id IS NOT NULL THEN c16.inviter_reward
          WHEN c10.referral_id IS NOT NULL THEN c10.inviter_reward
          WHEN c9.referral_id IS NOT NULL THEN c9.inviter_reward
          WHEN r.credited_at IS NOT NULL THEN r.inviter_reward_points END AS reward_coins,
        CASE WHEN c16.referral_id IS NOT NULL THEN c16.policy_version
          WHEN c10.referral_id IS NOT NULL THEN 'referrals_welcome_v10'
          WHEN c9.referral_id IS NOT NULL THEN 'referral_credit_v9' ELSE 'legacy_unknown' END AS policy_version,
        CASE WHEN c16.referral_id IS NOT NULL THEN 'cumulative_taps'
          WHEN c10.referral_id IS NOT NULL THEN CASE WHEN c10.activation_required THEN 'daily_taps_or_ad' ELSE 'join' END
          WHEN c9.referral_id IS NOT NULL THEN CASE WHEN c9.activation_required THEN 'daily_taps_or_ad' ELSE 'join' END
          ELSE 'legacy_unknown' END AS qualification_mode,
        CASE WHEN c16.referral_id IS NOT NULL THEN c16.min_taps
          WHEN c10.activation_required THEN c10.min_taps WHEN c9.activation_required THEN c9.min_taps END AS min_taps,
        CASE WHEN c16.referral_id IS NOT NULL THEN GREATEST(c16.verified_taps,verified.taps)
          WHEN c10.activation_required THEN LEAST(c10.min_taps,COALESCE(f.taps_today,0))
          WHEN c9.activation_required THEN LEAST(c9.min_taps,COALESCE(f.taps_today,0)) END AS verified_taps,
        CASE WHEN (c10.activation_required OR c9.activation_required) THEN EXISTS (
          SELECT 1 FROM jigcoin_internal.ad_attempts a WHERE a.user_id=f.id
            AND a.eligible_at IS NOT NULL AND a.claimed_at IS NOT NULL
            AND a.claimed_at>=COALESCE(c10.registered_at,c9.registered_at)) ELSE FALSE END AS legacy_ad_qualified,
        f.id IS NULL OR i.id IS NULL OR f.id=i.id
          OR COALESCE(f.is_system_user,FALSE) OR COALESCE(i.is_system_user,FALSE)
          OR f.banned_until>clock_timestamp() OR i.banned_until>clock_timestamp()
          OR (r.status IS DISTINCT FROM 'pending' AND r.credited_at IS NULL) AS held
      FROM public.referrals r
      LEFT JOIN public.users f ON f.telegram_id=r.invited_id
        AND (r.invitee_user_id IS NULL OR r.invitee_user_id=f.id)
      LEFT JOIN public.users i ON i.telegram_id=r.inviter_id
        AND (r.inviter_user_id IS NULL OR r.inviter_user_id=i.id)
      LEFT JOIN jigcoin_internal.referral_credits_v16 c16 ON c16.referral_id=r.id
        AND c16.inviter_user_id=i.id AND c16.invitee_user_id=f.id
      LEFT JOIN jigcoin_internal.referral_credits_v10 c10 ON c10.referral_id=r.id
        AND c10.inviter_user_id=i.id AND c10.invitee_user_id=f.id
      LEFT JOIN jigcoin_internal.referral_credits_v9 c9 ON c9.referral_id=r.id
        AND c9.inviter_user_id=i.id AND c9.invitee_user_id=f.id
      LEFT JOIN LATERAL (
        SELECT LEAST(100,COALESCE(SUM(applied),0))::integer AS taps
        FROM (SELECT applied FROM jigcoin_internal.tap_claims WHERE user_id=f.id
          AND applied>0 AND c16.referral_id IS NOT NULL AND c16.awarded_at IS NULL LIMIT 100) p
      ) verified ON TRUE
      WHERE (r.inviter_id=$2 AND (r.inviter_user_id=$1 OR r.inviter_user_id IS NULL))
        OR (r.invited_id=$2 AND (r.invitee_user_id=$1 OR r.invitee_user_id IS NULL))
    ), statuses AS MATERIALIZED (
      SELECT *,CASE
        -- A legacy timestamp alone is not a verified referral payment. Older
        -- rows with no attribution contract need reconciliation, not a grant.
        WHEN qualification_mode='legacy_unknown' THEN 'on_hold'
        WHEN rewarded_at IS NOT NULL THEN 'rewarded'
        WHEN held THEN 'on_hold'
        WHEN qualification_mode='join' OR verified_taps>=min_taps OR legacy_ad_qualified THEN 'qualified'
        WHEN verified_taps>0 THEN 'playing' ELSE 'joined' END AS status FROM source
    ) SELECT (SELECT COALESCE(referrals_count,0) FROM public.users WHERE id=$1 AND telegram_id=$2) AS rewarded_total,
      (SELECT COALESCE(referrals_points,0) FROM public.users WHERE id=$1 AND telegram_id=$2) AS coins_total,
      COUNT(*) FILTER(WHERE outgoing)::integer AS joined,
      COUNT(*) FILTER(WHERE outgoing AND status IN ('joined','playing'))::integer AS pending,
      COUNT(*) FILTER(WHERE outgoing AND status IN ('qualified','rewarded'))::integer AS qualified,
      COUNT(*) FILTER(WHERE outgoing AND status='rewarded')::integer AS rewarded,
      COUNT(*) FILTER(WHERE outgoing AND status='on_hold')::integer AS on_hold,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id::text,'display_name',display_name,
        'status',status,'policy_version',policy_version,'qualification_mode',qualification_mode,
        'verified_taps',verified_taps,'min_taps',min_taps,'joined_at',joined_at,
        'rewarded_at',CASE WHEN qualification_mode='legacy_unknown' THEN NULL ELSE rewarded_at END,
        'reward_coins',CASE WHEN qualification_mode='legacy_unknown' THEN NULL ELSE reward_coins END) ORDER BY joined_at DESC NULLS LAST,id DESC)
        FROM (SELECT * FROM statuses WHERE outgoing ORDER BY joined_at DESC NULLS LAST,id DESC LIMIT 20) recent),'[]'::jsonb) AS friends,
      (SELECT jsonb_build_object('display_name',display_name,'status',status,'policy_version',policy_version,
        'qualification_mode',qualification_mode,'verified_taps',verified_taps,'min_taps',min_taps,
        'joined_at',joined_at,'rewarded_at',CASE WHEN qualification_mode='legacy_unknown' THEN NULL ELSE rewarded_at END,
        'reward_coins',CASE WHEN qualification_mode='legacy_unknown' THEN NULL ELSE reward_coins END)
        FROM statuses WHERE incoming ORDER BY joined_at DESC NULLS LAST,id DESC LIMIT 1) AS incoming_referral
      FROM statuses`,[user.id,String(user.telegram_id)])).rows[0];
    if(row.rewarded_total===null || row.coins_total===null)throw Object.assign(new Error("INVITE_ACCOUNT_INVALID"),{status:401});
    return {rewardedCount:nonnegative(row.rewarded_total),coinsEarned:nonnegative(row.coins_total),
      friends_joined:nonnegative(row.joined),friends_pending:nonnegative(row.pending),
      friends_qualified:nonnegative(row.qualified),friends_on_hold:nonnegative(row.on_hold),
      friend_progress:row.friends,friend_progress_has_more:row.joined>20,incoming_referral:row.incoming_referral};
  }
  async function summary(user) {
    const saved=await account(user),telegramId=String(saved.telegram_id);
    const {rewardedCount:count,coinsEarned:coins,...friends}=await progress(saved);
    const tier = currentTier(count);
    const nextAt = TIERS.map(t=>t.at).find(value => value > count) ?? null;
    const previousAt = [...TIERS].reverse().find(t=>t.at<=count)?.at ?? 0;
    const username = String(botUsername || "").replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error("INVITE_CONFIG_INVALID");
    return {
      ok:true, telegram_id:telegramId, server_now:new Date().toISOString(),
      invite_link:`https://t.me/${username}?startapp=ref_${telegramId}`,
      policy_version:ACTIVATION_VERSION,welcome_coins:WELCOME_COINS,
      reward_coins:nextReward(count), friends_rewarded:count, coins_earned:coins,
      tier_name:tier.name, next_at:nextAt, previous_at:previousAt,
      next_reward_coins:nextAt === null ? null : nextReward(nextAt-1),
      next_tier_name:nextAt === null ? null : TIERS.find(t=>t.at===nextAt).name,
      qualification:{mode:"cumulative_taps",min_taps:ACTIVATION_TAPS,period:"lifetime",ad_qualifies:false,purchase_required:false},
      tiers:TIERS.map(t=>({...t})),...friends
    };
  }
  // Authenticated, bounded engagement signals. Referral qualification and
  // reward crediting remain exclusively in the existing server-side ledger.
  async function interaction(user,input={}) {
    await account(user);
    const event=input?.event;
    const allowed=new Set(['share_open','copy_link','card_open','card_download','friends_open','race_open']);
    if(typeof event!=='string'||!allowed.has(event))throw Object.assign(new Error('INVALID_INVITE_EVENT'),{status:400});
    if(user.is_system_user||new Date(user.banned_until).getTime()>Date.now())
      throw Object.assign(new Error('INVITE_UNAVAILABLE'),{status:403});
    await pool.query(`INSERT INTO jigcoin_internal.invite_interactions_v28
      (user_id,event_name,bucket_10m) VALUES($1,$2,$3)
      ON CONFLICT (user_id,event_name,bucket_10m) DO NOTHING`,
      [user.id,event,Math.floor(Date.now()/600000)]);
    return {ok:true};
  }
  async function history(user) {
    const saved=await account(user),telegramId=String(saved.telegram_id);
    // Actual balance credits, scoped to the authenticated internal user ID.
    // Older schemas may omit created_at: JSON extraction then yields null.
    const result = await pool.query(`SELECT id,delta,to_jsonb(l)->>'created_at' AS credited_at
      FROM public.user_balance_ledger l WHERE user_id=$1 AND reason='referral_reward'
      AND delta>0 ORDER BY id DESC LIMIT 10`, [saved.id]);
    return {ok:true,telegram_id:telegramId,credits:result.rows.map(row=>({
      id:String(row.id),coins:nonnegative(row.delta),
      credited_at:row.credited_at && Number.isFinite(Date.parse(row.credited_at)) ? new Date(row.credited_at).toISOString() : null
    }))};
  }
  return {summary,history,interaction};
}

module.exports = {createInvite};
