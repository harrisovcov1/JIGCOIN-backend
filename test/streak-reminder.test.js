'use strict';

const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {Pool} = require('pg');
const {readFile} = require('node:fs/promises');
const path = require('node:path');
const {createStreakReminder} = require('../lib/streakReminder');

const port = Number(process.env.JIGCOIN_TEST_POSTGRES_PORT || 0);
const integration = port ? test : test.skip;
const initialDate = '2026-11-19T14:00:00.000Z';
const schedule = {enabled: true, consent: true, local_time: '17:15', time_zone: 'Europe/London'};
const database = 'jigcoin_reminder_test_' + process.pid;
let admin, db, reminder, now, deliveries;

async function transaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function clock(value) { now = new Date(value); }
function service(overrides = {}) {
  return createStreakReminder({
    pool: db, withTransaction: transaction, clock: () => now,
    callTelegram: async (method, payload) => {
      deliveries.push({method, payload});
      return {message_id: 1};
    },
    ...overrides
  });
}

async function player(telegramId, lastClaim = now) {
  const result = await db.query(`INSERT INTO public.users
    (telegram_id, last_checkin_at, last_checkin_date)
    VALUES ($1, $2::timestamptz, ($2::timestamptz AT TIME ZONE 'UTC')::date) RETURNING *`,
  [telegramId, lastClaim]);
  return result.rows[0];
}

function permissionEvent(telegramId) {
  const id = Number(telegramId);
  return {from: {id}, chat: {id, type: 'private'}, write_access_allowed: {from_request: true}};
}

before(async () => {
  if (!port) return;
  const connection = {host:'127.0.0.1', port, user:process.env.USER || 'agent', ssl:false};
  admin = new Pool({...connection, database:'postgres'});
  await admin.query('CREATE DATABASE ' + database);
  db = new Pool({...connection, database});
  await db.query(`
    DO $$ BEGIN
      PERFORM pg_advisory_xact_lock(14142025);
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
    END $$;
    CREATE SCHEMA jigcoin_internal;
    CREATE TABLE public.users (
      id bigserial PRIMARY KEY, telegram_id bigint NOT NULL UNIQUE, username text, first_name text,
      last_checkin_at timestamptz, last_checkin_date date, streak_count int NOT NULL DEFAULT 1,
      banned_until timestamptz, is_system_user boolean NOT NULL DEFAULT false
    );
  `);
  clock(initialDate);
  deliveries = [];
  reminder = service();
  await reminder.prepare();
});
after(async () => {
  if (db) {
    await db.end();
    await admin.query('DROP DATABASE ' + database);
  }
  if (admin) await admin.end();
});

integration('the player must claim today, consent and grant Telegram permission', async () => {
  clock(initialDate);
  const user = await player(41001);
  const unclaimed = await player(41002, '2026-11-18T14:00:00Z');
  assert.equal((await reminder.status(user)).reminder, null);
  await assert.rejects(() => reminder.set(user, {...schedule, consent: false}, true));
  await assert.rejects(() => reminder.set(unclaimed, schedule, true));
  await assert.rejects(() => reminder.set(user, schedule, false));
  assert.equal((await reminder.status(user)).reminder, null);

  const enabled = await reminder.set(user, schedule, true);
  assert.equal(enabled.ok, true);
  assert.equal(new Date(enabled.reminder.due_at).toISOString(), '2026-11-20T17:15:00.000Z');
  assert.equal(enabled.reminder.target_day, '2026-11-20');
  assert.equal(enabled.reminder.local_time, schedule.local_time);
  assert.equal(enabled.reminder.time_zone, schedule.time_zone);
  assert.deepEqual((await reminder.status(user)).reminder, enabled.reminder);
  await reminder.set(user, {enabled: false});
});

integration('a Telegram write-access update must be private and belong to its sender', async () => {
  clock(initialDate);
  const user = await player(41003);
  const event = permissionEvent(user.telegram_id);
  const unrelated = await player(41004);
  await reminder.recordWriteAccess({...event, chat: {...event.chat, type: 'group'}});
  await reminder.recordWriteAccess({...event, from: {id: Number(unrelated.telegram_id)}});
  await assert.rejects(() => reminder.set(user, schedule, false));
  await reminder.recordWriteAccess(event);
  assert.equal((await reminder.status(user)).reminder, null);
  assert.equal((await reminder.set(user, schedule, false)).ok, true);
  await assert.rejects(() => reminder.set(unrelated, schedule, false));
  await reminder.set(user, {enabled: false});
});

integration('a reminder must fall on the next local and UTC day and represent a real local time', async () => {
  clock(initialDate);
  const user = await player(41005);
  for (const invalid of [
    {local_time: '25:15'}, {time_zone: 'Mars/Olympus'},
    {local_time: '01:15', time_zone: 'Asia/Tokyo'}
  ]) {
    await assert.rejects(() => reminder.set(user, {...schedule, ...invalid}, true), {status: 400});
  }
  clock('2027-03-27T12:00:00Z');
  const dst = await player(41006);
  await assert.rejects(() => reminder.set(dst, {...schedule, local_time: '01:30'}, true), {status: 400});
  const next = await reminder.set(dst, {...schedule, local_time: '03:15'}, true);
  assert.equal(new Date(next.reminder.due_at).toISOString(), '2027-03-28T02:15:00.000Z');
  await reminder.set(dst, {enabled: false});
});

integration('cancelling or claiming before dispatch suppresses delivery; parallel dispatch sends once', async () => {
  clock(initialDate);
  const [cancelled, claimed, waiting] = await Promise.all([41007,41008,41009].map(id => player(id)));
  for (const user of [cancelled, claimed, waiting]) await reminder.set(user, schedule, true);
  await reminder.set(cancelled, {enabled: false});
  await db.query(`UPDATE public.users SET last_checkin_at='2026-11-20T02:00:00Z', last_checkin_date='2026-11-20' WHERE id=$1`, [claimed.id]);

  clock('2026-11-20T17:14:59Z');
  await reminder.dispatch();
  assert.equal(deliveries.length, 0);
  clock('2026-11-20T17:15:01Z');
  await Promise.all([reminder.dispatch(), service().dispatch()]);
  await reminder.dispatch();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].method, 'sendMessage');
  assert.equal(String(deliveries[0].payload.chat_id), String(waiting.telegram_id));
  assert.match(deliveries[0].payload.text, /200 in-game coins/);
  assert.equal(deliveries[0].payload.reply_markup.inline_keyboard[0][0].url, 'https://t.me/JIGCOINBOT?startapp=daily_rewards');
  clock('2026-11-21T17:15:01Z');
  await reminder.dispatch();
  assert.equal(deliveries.length, 1);
});

integration('explicit flood control retries after its delay; ambiguous sends are retired', async () => {
  clock(initialDate);
  const limited = await player(41010);
  const unknown = await player(41011);
  const attempts = new Map();
  const sender = service({callTelegram: async (method, payload) => {
    const id = String(payload.chat_id);
    attempts.set(id, (attempts.get(id) || 0) + 1);
    if (id === String(unknown.telegram_id)) throw Error('Network timeout');
    if (attempts.get(id) === 1) throw Object.assign(Error('Flood control'), {telegramStatus:429, retryAfter:5});
  }});
  for (const user of [limited, unknown]) await sender.set(user, schedule, true);
  clock('2026-11-20T17:15:00Z');
  await sender.dispatch();
  clock('2026-11-20T17:15:04Z');
  await sender.dispatch();
  assert.equal(attempts.get(String(limited.telegram_id)), 1);
  clock('2026-11-20T17:15:05Z');
  await sender.dispatch();
  assert.equal(attempts.get(String(limited.telegram_id)), 2);
  assert.equal(attempts.get(String(unknown.telegram_id)), 1);
});

integration('a stale, suspended or past-day reminder never sends', async () => {
  clock(initialDate);
  const [late, banned, old] = await Promise.all([41012,41013,41014].map(id => player(id)));
  await reminder.set(late, schedule, true);
  await reminder.set(banned, {...schedule, local_time:'18:00'}, true);
  await reminder.set(old, {...schedule, local_time:'23:55'}, true);
  await db.query("UPDATE public.users SET banned_until='2026-12-20' WHERE id=$1", [banned.id]);
  const existing = deliveries.length;
  clock('2026-11-20T18:00:00Z');
  await reminder.dispatch();
  clock('2026-11-21T00:00:00Z');
  await reminder.dispatch();
  assert.equal(deliveries.length, existing);
});

integration('the owner scorecard compares mature cohorts, subtracts refunds and excludes QA and system users', async () => {
  const sql = await readFile(path.join(__dirname, '../sql/streak_reminder_scorecard.sql'), 'utf8');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // A local database clock lets this regression run on either side of the launch date.
    await client.query(`
      CREATE SCHEMA report_test_clock;
      CREATE FUNCTION report_test_clock.now() RETURNS timestamptz LANGUAGE sql STABLE
        AS $$ SELECT timestamptz '2027-01-15 10:00:00+00' $$;
      SET LOCAL search_path = report_test_clock, pg_catalog, public;
      CREATE TABLE jigcoin_internal.acquisition_v13(user_id bigint PRIMARY KEY, excluded boolean);
      CREATE TABLE jigcoin_internal.pilot_players_v14(user_id bigint PRIMARY KEY, enrolled_at timestamptz, returned_day7_at timestamptz);
      CREATE TABLE jigcoin_internal.purchase_receipts_v13(user_id bigint, charge_id text, stars int, paid_at timestamptz, refunded_at timestamptz);

      INSERT INTO public.users(id, telegram_id, is_system_user)
        SELECT id,id+50000,id=205 FROM generate_series(201,207) id;
      INSERT INTO jigcoin_internal.acquisition_v13 SELECT id,id=204 FROM public.users WHERE id BETWEEN 201 AND 207;
      INSERT INTO jigcoin_internal.pilot_players_v14
        SELECT id, CASE id WHEN 206 THEN timestamptz '2026-11-19 10:00+00'
                           WHEN 207 THEN timestamptz '2027-01-14 10:00+00'
                           ELSE timestamptz '2026-12-01 10:00+00' END,
                   CASE WHEN id IN (201,203,204,205) THEN timestamptz '2026-12-08 10:00+00' END
        FROM public.users WHERE id BETWEEN 201 AND 207;
      INSERT INTO jigcoin_internal.daily_streak_reminders
        (user_id,target_day,due_at,local_time,time_zone,opted_at,next_attempt_at,state)
        SELECT id,date '2026-12-02',timestamptz '2026-12-02 17:00+00','17:00','UTC',
               timestamptz '2026-12-01 13:00+00',timestamptz '2026-12-02 17:00+00','sent'
        FROM public.users WHERE id IN (201,202,204,205);
      INSERT INTO jigcoin_internal.purchase_receipts_v13 VALUES
        (201,'a',200,'2026-12-01 10:01+00',NULL), (201,'b',250,'2026-12-02','2026-12-08'),
        (201,'outside',500,'2026-12-31 10:00+00',NULL), (201,NULL,500,'2026-12-02',NULL),
        (203,'c',50,'2026-12-02',NULL), (204,'qa',2000,'2026-12-02',NULL),
        (205,'system',2000,'2026-12-02',NULL);
    `);
    const [cohorts, outcomes] = await client.query(sql);
    assert.equal(cohorts.rows.length, 3);
    const current = cohorts.rows[0];
    assert.deepEqual([current.enrolled_players, current.d7_eligible, current.d30_eligible,
      current.d7_return_percent, current.d30_net_stars_per_player], ['1', '0', '0', null, null]);
    const mature = cohorts.rows.slice(1).map(row => [row.opted_in_first_day, row.enrolled_players,
      row.d7_eligible, row.d7_return_percent, row.d30_eligible, row.d30_net_stars_per_player]);
    assert.deepEqual(mature, [[false,'1','1','100.0','1','50.00'], [true,'2','2','50.0','2','100.00']]);
    assert.deepEqual(outcomes.rows.map(row => [row.state, row.reminders]), [['sent','2']]);
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
});
