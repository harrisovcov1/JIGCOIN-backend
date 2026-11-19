'use strict';

const {readFile} = require('node:fs/promises');
const path = require('node:path');
const {DAY, dayOf, dailyReward} = require('./streakPolicy');

const REMINDERS = 'jigcoin_internal.daily_streak_reminders';
const GRANTS = 'jigcoin_internal.telegram_write_grants';
const MAX_LATENESS = 30 * 60000;
const fail = (code, status) => Object.assign(new Error(code), {code, status});
const lastClaim = user => dayOf(user.last_checkin_at || user.last_checkin_date);
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const response = row => ({ok:true, reminder:row ? {
  due_at:row.due_at.toISOString(), target_day:row.target_day, time_zone:row.time_zone, local_time:row.local_time
} : null});

function createStreakReminder({pool, withTransaction, callTelegram, clock=()=>new Date(), botUsername='JIGCOINBOT', mayDeliver=()=>true}) {
  let prepared, preparing, dispatching;
  const now = () => new Date(clock());
  async function prepare() {
    if (prepared) return;
    if (!preparing) preparing = (async () => {
      const client = await pool.connect();
      try {
        const check = await client.query('SELECT to_regclass($1) AS queue,to_regclass($2) AS grants',[REMINDERS,GRANTS]);
        if (!check.rows[0].queue || !check.rows[0].grants) {
          const sql = await readFile(path.join(__dirname,'../sql/migrations/026_daily_streak_reminders.sql'),'utf8');
          await client.query(sql);
        }
        prepared = true;
      } catch (error) {
        await client.query('ROLLBACK').catch(()=>{});
        throw error;
      } finally { client.release(); }
    })().finally(()=>{ preparing=null; });
    return preparing;
  }

  // Telegram's signed webhook (or authenticated bot polling), never client-supplied proof.
  async function recordWriteAccess(message) {
    const id = message?.from?.id;
    if (!message?.write_access_allowed || !Number.isSafeInteger(id) || id<=0 || message.from.is_bot ||
        message.chat?.type!=='private' || message.chat.id!==id) return false;
    await prepare();
    await pool.query(`INSERT INTO ${GRANTS}(telegram_id) VALUES ($1)
      ON CONFLICT (telegram_id) DO UPDATE SET confirmed_at=now()`,[id]);
    return true;
  }

  async function status(user) {
    await prepare();
    const result = await pool.query(`SELECT r.due_at,r.target_day::text,r.local_time,r.time_zone FROM ${REMINDERS} r
      JOIN public.users u ON u.id=r.user_id
      WHERE r.user_id=$1 AND r.state='scheduled' AND r.target_day>=($2::timestamptz AT TIME ZONE 'UTC')::date
        AND r.due_at >= $2::timestamptz-interval '30 minutes'
        AND COALESCE((u.last_checkin_at AT TIME ZONE 'UTC')::date,u.last_checkin_date)<r.target_day
      ORDER BY r.target_day DESC LIMIT 1`,[user.id,now()]);
    return response(result.rows[0]);
  }

  async function set(user, options, verifiedWriteAccess=false) {
    if (typeof options?.enabled!=='boolean') throw fail('REMINDER_INVALID_SETTING',400);
    if (options.enabled) {
      if (options.consent!==true) throw fail('REMINDER_CONSENT_REQUIRED',400);
      if (typeof options.local_time!=='string' || !timePattern.test(options.local_time)) throw fail('REMINDER_INVALID_TIME',400);
      if (typeof options.time_zone!=='string' || !options.time_zone || options.time_zone.length>64)
        throw fail('REMINDER_INVALID_TIME_ZONE',400);
      try { new Intl.DateTimeFormat('en',{timeZone:options.time_zone}); }
      catch { throw fail('REMINDER_INVALID_TIME_ZONE',400); }
    }
    await prepare();
    return withTransaction(async client=>{
      const player=(await client.query('SELECT * FROM public.users WHERE id=$1 FOR UPDATE',[user.id])).rows[0];
      if (!player || String(player.telegram_id)!==String(user.telegram_id)) throw fail('REMINDER_PLAYER_UNAVAILABLE',403);
      if (!options.enabled) {
        await client.query(`UPDATE ${REMINDERS} SET state='cancelled' WHERE user_id=$1 AND state IN ('scheduled','reserved')`,[user.id]);
        return response(null);
      }
      const at=now();
      if (player.is_system_user || new Date(player.banned_until)>at || !mayDeliver(player.telegram_id))
        throw fail('REMINDER_PLAYER_UNAVAILABLE',403);
      if (lastClaim(player)!==dayOf(at)) throw fail('REMINDER_CLAIM_FIRST',409);
      if (verifiedWriteAccess!==true && !(await client.query(`SELECT 1 FROM ${GRANTS} WHERE telegram_id=$1`,[player.telegram_id])).rowCount)
        throw fail('REMINDER_WRITE_PERMISSION',403);

      // Use Postgres's IANA rules for tomorrow in the chosen zone, including DST.
      const {local_time, time_zone}=options;
      let result;
      try {
        result=await client.query(`WITH requested AS (
          SELECT (($1::timestamptz AT TIME ZONE $2)::date + 1) + $3::time AS wall
        ) SELECT wall AT TIME ZONE $2 AS due_at,
          (wall AT TIME ZONE $2 AT TIME ZONE $2)=wall AS valid_wall_time FROM requested`,[at,time_zone,local_time]);
      } catch (error) {
        if (error.code==='22023') throw fail('REMINDER_INVALID_TIME_ZONE',400);
        throw error;
      }
      const {due_at,valid_wall_time}=result.rows[0];
      const target=dayOf(+at + DAY);
      if (!valid_wall_time || dayOf(due_at)!==target || +due_at<=+at) throw fail('REMINDER_TIME_OUTSIDE_REWARD_DAY',400);
      const {rows}=await client.query(`INSERT INTO ${REMINDERS} AS r
        (user_id,target_day,due_at,local_time,time_zone,opted_at,next_attempt_at,state)
        VALUES($1,$2,$3,$4,$5,$6,$3,'scheduled') ON CONFLICT(user_id,target_day) DO UPDATE
        SET due_at=excluded.due_at,local_time=excluded.local_time,time_zone=excluded.time_zone,
          opted_at=excluded.opted_at,next_attempt_at=excluded.next_attempt_at,state='scheduled'
        WHERE r.state IN ('scheduled','cancelled')
        RETURNING due_at,target_day::text,local_time,time_zone`,[user.id,target,due_at,local_time,time_zone,at]);
      if (!rows.length) throw fail('REMINDER_ALREADY_PROCESSED',409);
      return response(rows[0]);
    });
  }

  async function dispatchOne() {
    // Record the reservation durably before making a non-idempotent sendMessage.
    // If a process dies after sending, a successor cannot send the same reminder twice.
    const {rows:[job]}=await pool.query(`WITH candidate AS (
      SELECT user_id,target_day FROM ${REMINDERS} WHERE state='scheduled' AND next_attempt_at<=$1
      ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE ${REMINDERS} r SET state='reserved',attempted_at=$1 FROM candidate c
      WHERE (r.user_id,r.target_day)=(c.user_id,c.target_day) RETURNING r.user_id,r.target_day::text`,[now()]);
    if (!job) return false;

    await withTransaction(async client=>{
      // Take locks in the same order as a check-in, cancellation or reschedule.
      const user=(await client.query('SELECT * FROM public.users WHERE id=$1 FOR UPDATE',[job.user_id])).rows[0];
      const key=[job.user_id,job.target_day];
      const row=(await client.query(`SELECT due_at,state FROM ${REMINDERS} WHERE user_id=$1 AND target_day=$2 FOR UPDATE`,key)).rows[0];
      if (row?.state!=='reserved') return;
      const at=now();
      const active=user && !user.is_system_user && !(new Date(user.banned_until)>at) && mayDeliver(user.telegram_id);
      if (!active || dayOf(at)!==job.target_day || +at-row.due_at.getTime()>MAX_LATENESS ||
          lastClaim(user)!==dayOf(+at-DAY)) {
        await client.query(`UPDATE ${REMINDERS} SET state='skipped' WHERE user_id=$1 AND target_day=$2`,key);
        return;
      }
      let state='sent', retryAt=null;
      try {
        const amount=dailyReward(Number(user.streak_count)+1).toLocaleString('en-GB');
        await callTelegram('sendMessage',{chat_id:user.telegram_id,
          text:`Your daily streak reward is ready. Open JigCoin to collect ${amount} in-game coins.`,
          reply_markup:{inline_keyboard:[[{text:'Open Rewards',url:`https://t.me/${botUsername}?startapp=daily_rewards`}]]}});
      } catch (error) {
        // Telegram explicitly rejecting a request for flood control is safe to retry.
        // A timeout or lost reply could mean successful delivery. Never send a second copy.
        if (error.telegramStatus===429) {
          const delay=Math.max(1,Number(error.retryAfter)||60);
          retryAt=new Date(+at+delay*1000);
          state=retryAt-row.due_at<=MAX_LATENESS && dayOf(retryAt)===job.target_day ? 'scheduled' : 'undelivered';
        } else state='undelivered';
      }
      await client.query(`UPDATE ${REMINDERS} SET state=$3, next_attempt_at=COALESCE($4::timestamptz,next_attempt_at),
        delivered_at=CASE WHEN $3='sent' THEN $5::timestamptz ELSE NULL END WHERE user_id=$1 AND target_day=$2`,
        [...key,state,retryAt,at]);
    });
    return true;
  }

  async function dispatch() {
    if (!dispatching) dispatching=(async()=>{
      await prepare();
      for (let i=0;i<30;i++) if (!await dispatchOne()) break;
    })().finally(()=>{dispatching=null;});
    return dispatching;
  }
  return {prepare,recordWriteAccess,status,set,dispatch};
}

module.exports={createStreakReminder};
