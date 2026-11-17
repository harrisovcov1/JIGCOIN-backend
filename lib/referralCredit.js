"use strict";

// Only verified Telegram identities may call register(). No HTTP request body
// referral fields are accepted. Attribution is fixed at first registration.
const {VERSION,legacyTier,tierForOrdinal,nextReward}=require("./referralPolicy");
const {createReferralCredit:createLegacyCredit}=require("./referralCreditLegacy");
const id = value => {
  const s = String(value ?? "");
  return /^[1-9]\d{0,15}$/.test(s) && Number.isSafeInteger(Number(s)) ? s : null;
};
const inviterFrom = payload => {
  if (typeof payload !== "string" || !/^ref_[1-9]\d{0,15}$/.test(payload)) return null;
  return id(payload.slice(4));
};
const fail = code => Object.assign(new Error(code), {code, status:503});

function createReferralCredit({pool, withTransaction,
  strictActivation = false, minTaps = 150, logger = console}) {
  if ( !Number.isSafeInteger(minTaps) || minTaps < 1 || minTaps > 1000000) {
    throw fail("REFERRAL_CONFIG_INVALID");
  }

  const legacy=createLegacyCredit({pool,withTransaction,getReferralTier:legacyTier,
    baseReward:800,strictActivation,minTaps,logger});
  async function assertReady() {
    await legacy.assertReady();
    const result = await pool.query(`SELECT EXISTS (
      SELECT 1 FROM jigcoin_internal.referral_migrations WHERE version=$1
    ) AS installed, EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgrelid='public.users'::regclass
      AND tgname='users_award_welcome_v10' AND tgenabled='O' AND tgtype=5
      AND tgfoid=to_regprocedure('jigcoin_internal.award_welcome_v10()')
    ) AS welcome_ready, NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'D'
      AND (tgname=ANY($2::text[]) OR tgname='users_award_early_access')
      AND tgrelid IN ('public.users'::regclass,'public.referrals'::regclass)
    ) AS retired`, [VERSION, ["trg_credit_referral_rewards", "trg_credit_referral_rewards_on_insert",
      "trg_process_referral_on_insert", "trg_try_credit_referral_on_referral_insert",
      "trg_auto_approve_and_credit_on_user_insert", "trg_process_pending_referrals_for_new_user",
      "trg_try_credit_referral_on_user_insert"]]);
    if (!result.rows[0]?.installed || !result.rows[0]?.retired || !result.rows[0]?.welcome_ready) throw fail("REFERRAL_MIGRATION_REQUIRED");
  }

  async function register(telegramUser, signedStartParam) {
    const telegramId = id(telegramUser?.id);
    if (!telegramId) throw Object.assign(new Error("INVALID_TELEGRAM_USER"), {status:401});
    // Keep existing-account reads inexpensive. Never reattribute an old account.
    const existing = await pool.query("SELECT * FROM public.users WHERE telegram_id=$1::bigint", [telegramId]);
    if (existing.rows[0]) return existing.rows[0];
    return withTransaction(async client => {
      const created = await client.query(`INSERT INTO public.users
        (telegram_id,username,first_name,last_name,language_code)
        VALUES ($1::bigint,$2,$3,$4,$5) ON CONFLICT (telegram_id) DO NOTHING RETURNING id`,
      [telegramId, telegramUser.username || null, telegramUser.first_name || null,
        telegramUser.last_name || null, telegramUser.language_code || null]);
      // Concurrent first registration: only the INSERT winner may bind an inviter.
      const user = (await client.query("SELECT * FROM public.users WHERE telegram_id=$1::bigint", [telegramId])).rows[0];
      if (!created.rows[0]) return user;
      const welcome=(await client.query("SELECT amount FROM jigcoin_internal.welcome_credits_v10 WHERE user_id=$1 AND telegram_id=$2",[user.id,telegramId])).rows[0];
      if (welcome?.amount!==1000) throw fail("WELCOME_MIGRATION_REQUIRED");
      user.welcome_bonus_awarded=welcome.amount;
      const inviterId = inviterFrom(signedStartParam);
      if (!inviterId || inviterId === telegramId) return user;
      const inviter = (await client.query(`SELECT id FROM public.users
        WHERE telegram_id=$1::bigint AND is_system_user=FALSE
        AND (banned_until IS NULL OR banned_until<=clock_timestamp())`, [inviterId])).rows[0];
      if (!inviter || user.is_system_user) return user;
      const ref = await client.query(`INSERT INTO public.referrals
        (inviter_id,invited_id,inviter_user_id,invitee_user_id,status)
        VALUES ($1,$2,$3,$4,'pending') ON CONFLICT (invited_id) DO NOTHING RETURNING id`,
      [inviterId, telegramId, inviter.id, user.id]);
      // A legacy binding is not proof of an unpaid referral: leave it for review.
      if (!ref.rows[0]) return user;
      await client.query(`INSERT INTO jigcoin_internal.referral_credits_v10
        (referral_id,inviter_user_id,invitee_user_id,activation_required,min_taps)
        VALUES ($1,$2,$3,$4,$5)`, [ref.rows[0].id, inviter.id, user.id, strictActivation, minTaps]);
      await client.query("UPDATE public.users SET referred_by=$2 WHERE id=$1", [user.id, inviterId]);
      return {...user, referred_by:inviterId};
    });
  }

  async function activate(user) {
    // This version only credits explicitly enrolled new registrations. It never
    // guesses whether a legacy referral with a missing ledger was paid already.
    const pending = (await pool.query(`SELECT referral_id FROM jigcoin_internal.referral_credits_v10
      WHERE invitee_user_id=$1 AND awarded_at IS NULL`, [user.id])).rows[0];
    if (!pending) return legacy.activate(user);
    return withTransaction(async client => {
      const claim = (await client.query(`SELECT * FROM jigcoin_internal.referral_credits_v10
        WHERE referral_id=$1 FOR UPDATE`, [pending.referral_id])).rows[0];
      if (!claim) throw fail("REFERRAL_RECORD_MISSING");
      // Lock users in the same order for all awards. The inviter count and tier
      // decision remain locked through the credit and audit writes.
      const users = (await client.query(`SELECT * FROM public.users
        WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
      [[claim.inviter_user_id, claim.invitee_user_id]])).rows;
      const inviter = users.find(u => String(u.id) === String(claim.inviter_user_id));
      const invitee = users.find(u => String(u.id) === String(claim.invitee_user_id));
      if (!inviter || !invitee) throw fail("REFERRAL_ACCOUNT_MISSING");
      if (claim.awarded_at) return invitee;
      if ([inviter, invitee].some(u => u.is_system_user || (u.banned_until && new Date(u.banned_until)>new Date()))) return invitee;
      const ref = (await client.query("SELECT * FROM public.referrals WHERE id=$1 FOR UPDATE", [claim.referral_id])).rows[0];
      if (!ref || String(ref.inviter_id)!==String(inviter.telegram_id) ||
          String(ref.invited_id)!==String(invitee.telegram_id) || ref.credited_at || ref.status!=="pending") {
        throw fail("REFERRAL_STATE_CONFLICT");
      }
      let source = "join";
      if (claim.activation_required) {
        if (Number(invitee.taps_today || 0) >= claim.min_taps) source = "taps";
        else {
          // Provider-confirmed AND claimed ads only. Client action names, a
          // started advert, and an unconfirmed callback cannot qualify a user.
          const ad = await client.query(`SELECT 1 FROM jigcoin_internal.ad_attempts
            WHERE user_id=$1 AND eligible_at IS NOT NULL AND claimed_at IS NOT NULL
            AND claimed_at >= $2 LIMIT 1`, [invitee.id, claim.registered_at]);
          if (!ad.rows[0]) return invitee;
          source = "confirmed_ad";
        }
      }
      const count = Number(inviter.referrals_count || 0);
      if (!Number.isSafeInteger(count) || count<0) throw fail("REFERRAL_COUNTER_INVALID");
      const ordinal=count+1;
      const tier=tierForOrdinal(ordinal);
      const reward=nextReward(count);
      const credit = async (accountId, amount, reason) => {
        const ledger = await client.query(`INSERT INTO public.user_balance_ledger
          (user_id,delta,reason,ref_type,ref_id,event_type)
          VALUES ($1,$2,$3,'referral_v10',$4,$3) RETURNING id`, [accountId,amount,reason,claim.referral_id]);
        const updated = await client.query(`UPDATE public.users SET balance=COALESCE(balance,0)+$2
          WHERE id=$1 RETURNING *`, [accountId,amount]);
        return {ledgerId:ledger.rows[0].id, user:updated.rows[0]};
      };
      const inviterCredit = await credit(inviter.id,reward,"referral_reward");
      await client.query(`UPDATE public.users SET referrals_count=COALESCE(referrals_count,0)+1,
        referrals=COALESCE(referrals,0)+1, referrals_points=COALESCE(referrals_points,0)+$2
        WHERE id=$1`, [inviter.id,reward]);
      await client.query(`UPDATE public.referrals SET status='approved',tier=$2,
        inviter_reward_points=$3,invitee_reward_points=0,credited_at=clock_timestamp()
        WHERE id=$1`, [claim.referral_id,[1,5,20,50,200].indexOf(tier.at)+1,reward]);
      await client.query(`INSERT INTO public.referral_streaks (user_id,streak_count,last_referral_at,updated_at)
        VALUES ($1,1,clock_timestamp(),clock_timestamp()) ON CONFLICT (user_id) DO UPDATE
        SET streak_count=public.referral_streaks.streak_count+1,last_referral_at=EXCLUDED.last_referral_at,
        updated_at=EXCLUDED.updated_at`, [inviter.id]);
      const audit = JSON.stringify({version:VERSION,referral_id:claim.referral_id,
        inviter_id:String(inviter.telegram_id),invited_id:String(invitee.telegram_id),source,reward,referral_ordinal:ordinal,friend_reward:0,welcome_coins:1000});
      await client.query(`INSERT INTO public.sponsor_ledger (user_id,event,amount,meta)
        VALUES ($1,'referral_reward',$2,$3::jsonb)`, [inviter.id,reward,audit]);
      await client.query(`INSERT INTO public.event_log (user_id,event,meta)
        VALUES ($1,'referral_activated',$2::jsonb)`, [invitee.id,audit]);
      await client.query(`UPDATE jigcoin_internal.referral_credits_v10 SET awarded_at=clock_timestamp(),
        inviter_reward=$2,inviter_ledger_id=$3,qualification=$4,referral_ordinal=$5
        WHERE referral_id=$1`, [claim.referral_id,reward,inviterCredit.ledgerId,source,ordinal]);
      return invitee;
    });
  }

  // Tap/ad fulfillment has already committed by this point. Do not turn an
  // award failure into a failed tap/ad response that could provoke a replay.
  // The enrolled pending record is retried on the next authenticated request.
  async function settle(user) {
    try { return await activate(user); }
    catch (error) {
      logger.error("Referral settlement pending", {code:error.code || "REFERRAL_SETTLEMENT_FAILED"});
      return user;
    }
  }
  return {register,activate,settle,assertReady};
}
module.exports = {createReferralCredit,inviterFrom,VERSION};
