'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const PLAYERS = 'jigcoin_internal.pilot_players_v14';
const RACERS = 'jigcoin_internal.weekly_racers_v14';
const RUNS = 'jigcoin_internal.weekly_runs_v14';
const DAY = 86400000;
const LENGTH = 45000;
const LIMIT = 3;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const fail = (code, status = 400) => Object.assign(new Error(code), {code, status});

function weekOf(now) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  return {week: start.toISOString().slice(0, 10), closes: new Date(+start + 7 * DAY)};
}

// The same puzzle values for each week's slot and turn. Layouts vary per run.
// No device supplies a score, deadline, multiplier or energy balance.
function board(run) {
  const puzzle = crypto.createHash('sha256').update([run.week_key, run.slot, run.turn].join('/')).digest();
  const digits = Array.from({length: 9}, (_, i) => i + 1);
  const shuffle = (a, bytes) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = bytes[i] % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
  };
  shuffle(digits, puzzle);
  const tiles = digits.slice(0, 6);
  const target = tiles[0] + tiles[1];
  shuffle(tiles, crypto.createHmac('sha256', run.seed).update(String(run.turn)).digest());
  return {tiles, target};
}

function createWeeklyRace({pool, withTransaction, env = process.env, clock}) {
  let prepared = false, preparing = null, retryAt = 0;
  async function prepare() {
    if (prepared) return;
    if (preparing) return preparing;
    if (Date.now() < retryAt) throw fail('PILOT_STARTING', 503);
    preparing = (async () => {
      const client = await pool.connect();
      try {
        const installed = await client.query('SELECT to_regclass($1) AS present', [RUNS]);
        if (!installed.rows[0].present) {
          if (env.JIGCOIN_INSTALL_PILOT_SCHEMA !== '1' && env.AUTO_MIGRATE !== '1')
            throw fail('PILOT_SCHEMA_REQUIRED',503);
          const file = path.join(__dirname, '../sql/migrations/024_revenue_pilot.sql');
          await client.query(await fs.readFile(file, 'utf8'));
        }
        prepared = true;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        retryAt = Date.now() + 30000;
        throw error;
      } finally { client.release(); }
    })().finally(() => { preparing = null; });
    return preparing;
  }
  function eligible(u) {
    if (!u || u.is_system_user || !(Number(u.telegram_id) > 0) || new Date(u.banned_until) > new Date())
      throw fail('PLAYER_UNAVAILABLE', 403);
  }
  const nowOf = async c => clock ? new Date(clock()) : (await c.query('SELECT clock_timestamp() AS now')).rows[0].now;
  async function enroll(user) {
    eligible(user);
    await prepare();
    const split = env.JIGCOIN_REFILL_TEST === '1';
    const bucket = crypto.createHash('sha256').update('refill-v14/' + user.id).digest()[0];
    const group = split ? (bucket < 128 ? 'refill' : 'holdout') : 'baseline';
    const row = (await pool.query(`INSERT INTO ${PLAYERS} AS p(user_id,ad_group) VALUES ($1,$2)
      ON CONFLICT (user_id) DO UPDATE SET
        returned_day7_at=clock_timestamp()
      WHERE p.returned_day7_at IS NULL AND clock_timestamp()>=p.enrolled_at+interval '168 hours'
        AND clock_timestamp()<p.enrolled_at+interval '192 hours'
      RETURNING ad_group,vip_coin`, [user.id, group])).rows[0];
    return row || (await pool.query(`SELECT ad_group,vip_coin FROM ${PLAYERS} WHERE user_id=$1`, [user.id])).rows[0];
  }
  async function refillAvailable(user) {
    try { return (await enroll(user)).ad_group !== 'holdout'; }
    catch { return false; } // Reconcile outstanding receipts even if enrolment is offline.
  }
  async function profile(user, setting) {
    const p = await enroll(user);
    const now = await nowOf(pool), active = new Date(user.vip_until).getTime() > +now;
    if (setting !== undefined) {
      if (typeof setting !== 'boolean') throw fail('INVALID_COIN_STYLE');
      const result = await pool.query(`UPDATE ${PLAYERS} p SET vip_coin=$2 FROM public.users u
        WHERE p.user_id=$1 AND u.id=p.user_id AND (NOT $2 OR u.vip_until>clock_timestamp()) RETURNING p.vip_coin`, [user.id, setting]);
      if (!result.rowCount) throw fail('VIP_REQUIRED', 403);
      p.vip_coin = result.rows[0].vip_coin;
    }
    const medals = (await pool.query(`SELECT me.week::text AS week,me.best AS score FROM ${RACERS} me
      WHERE me.user_id=$1 AND me.week<$2 AND me.best>0 AND NOT EXISTS
      (SELECT 1 FROM ${RACERS} r WHERE r.week=me.week AND r.best>me.best)
      ORDER BY me.week DESC`, [user.id, weekOf(now).week])).rows;
    return {ok:true,telegram_id:String(user.telegram_id),refill:p.ad_group !== 'holdout',vip_coin:active && p.vip_coin,medals};
  }
  async function dress(rows) {
    if (!rows.length) return rows;
    try { await prepare(); } catch { return rows; }
    const result = await pool.query(`SELECT u.telegram_id::text AS id FROM ${PLAYERS} p JOIN public.users u ON u.id=p.user_id
      WHERE p.vip_coin AND u.vip_until>clock_timestamp() AND u.telegram_id=ANY($1::bigint[])`, [rows.map(r => r.telegram_id)]);
    const vip = new Set(result.rows.map(r => r.id));
    return rows.map(r => ({...r,vip_coin:vip.has(String(r.telegram_id))}));
  }
  function view(run, now) {
    if (!run) return null;
    const live = new Date(run.ends_at) > now;
    return {id:run.id,slot:run.slot,turn:run.turn,score:run.score,ends_at:run.ends_at,live,
      board:live ? board(run) : null};
  }
  const runFields = '*,week::text AS week_key';
  async function lockPlayer(c, user) {
    const row = (await c.query('SELECT id,telegram_id,is_system_user,banned_until FROM public.users WHERE id=$1 AND telegram_id=$2 FOR UPDATE',
      [user.id,user.telegram_id])).rows[0];
    eligible(row);
  }
  async function start(user, body) {
    eligible(user);
    if (!uuid(body.request_key)) throw fail('INVALID_RUN');
    await prepare();
    return withTransaction(async c => {
      await lockPlayer(c,user);
      const now = await nowOf(c), {week,closes} = weekOf(now);
      const old = (await c.query(`SELECT ${runFields} FROM ${RUNS} WHERE user_id=$1 AND request_key=$2`, [user.id,body.request_key])).rows[0];
      const last = old || (await c.query(`SELECT ${runFields} FROM ${RUNS} WHERE user_id=$1 AND week=$2 ORDER BY slot DESC LIMIT 1`, [user.id,week])).rows[0];
      let run = last;
      if (!old && !(last && new Date(last.ends_at)>now)) {
        const slot = (last?.slot || 0) + 1;
        if (slot > LIMIT) throw fail('RUNS_USED',409);
        if (+closes - +now < LENGTH) throw fail('WEEK_CLOSING',409);
        await c.query(`INSERT INTO ${RACERS}(week,user_id,share_code) VALUES ($1,$2,$3) ON CONFLICT (week,user_id) DO NOTHING`,
          [week,user.id,crypto.randomBytes(10).toString('hex')]);
        run = (await c.query(`INSERT INTO ${RUNS}(id,request_key,week,user_id,slot,seed,starts_at,ends_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${runFields}`,
          [crypto.randomUUID(),body.request_key,week,user.id,slot,crypto.randomBytes(24).toString('hex'),now,new Date(+now+LENGTH)])).rows[0];
      }
      return {ok:true,telegram_id:String(user.telegram_id),server_now:now,run:view(run,now)};
    });
  }
  async function answer(user, body) {
    eligible(user);
    if (!uuid(body.id) || !Number.isSafeInteger(body.turn) || body.turn<0 ||
      !Array.isArray(body.picks) || body.picks.length!==2 || body.picks[0]===body.picks[1] ||
      !body.picks.every(i=>Number.isInteger(i)&&i>=0&&i<6)) throw fail('INVALID_MOVE');
    await prepare();
    return withTransaction(async c => {
      await lockPlayer(c,user);
      let run = (await c.query(`SELECT ${runFields} FROM ${RUNS} WHERE id=$1 AND user_id=$2 FOR UPDATE`, [body.id,user.id])).rows[0];
      if (!run) throw fail('RUN_UNAVAILABLE',404);
      const now = await nowOf(c);
      let correct = null;
      if (body.turn>run.turn) throw fail('REFRESH_RUN',409);
      if (body.turn===run.turn && new Date(run.ends_at)>now) {
        const {tiles,target} = board(run);
        correct = tiles[body.picks[0]] + tiles[body.picks[1]] === target;
        run = (await c.query(`UPDATE ${RUNS} SET turn=turn+1,score=score+$2 WHERE id=$1 RETURNING ${runFields}`,
          [run.id,correct ? 1 : 0])).rows[0];
        if (correct) await c.query(`UPDATE ${RACERS} SET best=greatest(best,$3) WHERE week=$1 AND user_id=$2`,[run.week_key,user.id,run.score]);
      }
      return {ok:true,telegram_id:String(user.telegram_id),server_now:now,correct,run:view(run,now)};
    });
  }
  async function standings(user, body) {
    eligible(user);
    await prepare();
    const code = typeof body.rival==='string' && /^[a-f0-9]{20}$/.test(body.rival) ? body.rival : null;
    const now = await nowOf(pool), {week,closes} = weekOf(now);
    const names = "left(coalesce(nullif(u.username,''),nullif(u.first_name,''),'Player'),48)";
    const [latest,own,podium,rival] = await Promise.all([
      pool.query(`SELECT ${runFields} FROM ${RUNS} WHERE week=$1 AND user_id=$2 ORDER BY slot DESC LIMIT 1`, [week,user.id]),
      pool.query(`SELECT best,share_code,CASE WHEN best>0 THEN 1+(SELECT count(*) FROM ${RACERS} b WHERE b.week=a.week AND b.best>a.best) END AS place
        FROM ${RACERS} a WHERE week=$1 AND user_id=$2`, [week,user.id]),
      pool.query(`SELECT ${names} AS name,r.best AS score,u.id=$2 AS me,
        coalesce(p.vip_coin AND u.vip_until>$3,false) AS vip_coin,rank() OVER(ORDER BY r.best DESC)::int AS place
        FROM ${RACERS} r JOIN public.users u ON u.id=r.user_id LEFT JOIN ${PLAYERS} p ON p.user_id=u.id
        WHERE week=$1 AND best>0 ORDER BY best DESC,u.id LIMIT 10`, [week,user.id,now]),
      code ? pool.query(`SELECT r.week::text AS week,r.best AS score,${names} AS name,u.id=$2 AS me FROM ${RACERS} r
        JOIN public.users u ON u.id=r.user_id WHERE share_code=$1`, [code,user.id]) : Promise.resolve({rows:[]})
    ]);
    const last = latest.rows[0], me = own.rows[0];
    return {ok:true,telegram_id:String(user.telegram_id),server_now:now,week,closes_at:closes,
      runs_left:LIMIT-(last?.slot||0),seconds:LENGTH/1000,run:view(last,now),best:me?.best||0,
      place:me?.place ? Number(me.place) : null,share_code:me?.share_code||null,leaders:podium.rows,rival:rival.rows[0]||null};
  }
  return {prepare,enroll,refillAvailable,profile,dress,start,answer,standings};
}
module.exports = {createWeeklyRace,weekOf,board};
