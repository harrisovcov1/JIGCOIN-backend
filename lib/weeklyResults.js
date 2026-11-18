'use strict';

const {createHash} = require('node:crypto');
const {readFile} = require('node:fs/promises');
const path = require('node:path');
const {EVENT_KEY} = require('./progression');

const RUNS = 'jigcoin_internal.weekly_runs_v14';
const RACERS = 'jigcoin_internal.weekly_racers_v14';
const CARDS = 'jigcoin_internal.weekly_result_cards';
const RANKS = [0, 10000, 50000, 150000, 500000, 1500000, 5000000, 10000000];
const codeValid = code => typeof code === 'string' && /^[a-f0-9]{32}$/.test(code);
const rankFinish = balance => 'rank-' + Math.max(0, RANKS.filter(min => Number(balance) >= min).length - 1);

async function runFinish(client, player, launchRequested, now) {
  if (new Date(player.vip_until) > now) {
    const equipped = await client.query('SELECT vip_coin FROM jigcoin_internal.pilot_players_v14 WHERE user_id=$1', [player.id]);
    if (equipped.rows[0]?.vip_coin) return 'midnight';
  }
  if (launchRequested === true) {
    const owned = await client.query(`SELECT 1 FROM jigcoin_internal.progression_claims
      WHERE user_id=$1 AND kind='launch' AND period=$2`, [player.id, EVENT_KEY]);
    if (owned.rowCount) return 'launch';
  }
  return rankFinish(player.balance);
}

function createWeeklyResults({pool, env}) {
  let ready = false, checking = null, retryAt = 0;
  async function installed() {
    if (ready || Date.now() < retryAt) return ready;
    if (checking) return checking;
    checking = (async () => {
      const {rows} = await pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [CARDS]);
      ready = rows[0].present;
      if (!ready && (env.JIGCOIN_INSTALL_PILOT_SCHEMA === '1' || env.AUTO_MIGRATE === '1')) {
        const client = await pool.connect();
        try {
          await client.query(await readFile(path.join(__dirname, '../sql/migrations/025_mint_race_cards.sql'), 'utf8'));
          ready = true;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally { client.release(); }
      }
      return ready;
    })().finally(() => { if (!ready) retryAt = Date.now() + 30000; checking = null; });
    return checking;
  }

  async function read(code, viewer) {
    if (!codeValid(code)) return null;
    const {rows} = await pool.query(`SELECT r.week::text AS week, r.slot, r.score, r.finish_key,
      left(coalesce(nullif(u.username,''),nullif(u.first_name,''),'Player'),48) AS name,
      u.id=$2 AS me, racer.share_code
      FROM ${CARDS} card JOIN ${RUNS} r ON r.id IN (card.first_run,card.second_run)
      JOIN public.users u ON u.id=r.user_id JOIN ${RACERS} racer ON racer.week=r.week AND racer.user_id=r.user_id
      WHERE card.code=$1 ORDER BY r.score DESC, r.id`, [code,viewer.id]);
    if (rows.length !== 2) return null;
    const players = rows.map(row => ({name:row.name, me:row.me, score:row.score, slot:row.slot,
      finish:row.finish_key, challenge:row.share_code}));
    return {code, week:rows[0].week, margin:players[0].score - players[1].score, players};
  }

  // Pair the viewer's latest completed run with their friend's best completed run.
  // Persist the two run references so later rematches cannot change an existing card.
  async function compare(viewer, rivalCode, week, now) {
    const {rows} = await pool.query(`SELECT a.id AS mine, b.id AS theirs FROM ${RACERS} rival
      CROSS JOIN LATERAL (SELECT id FROM ${RUNS} WHERE user_id=$1 AND week=$3 AND ends_at<=$4
        ORDER BY slot DESC LIMIT 1) a
      CROSS JOIN LATERAL (SELECT id FROM ${RUNS} WHERE user_id=rival.user_id AND week=$3 AND ends_at<=$4
        ORDER BY score DESC, slot DESC LIMIT 1) b
      WHERE rival.share_code=$2 AND rival.user_id<>$1`, [viewer.id,rivalCode,week,now]);
    if (!rows.length) return null;
    const [first, second] = [rows[0].mine,rows[0].theirs].sort();
    const code = createHash('sha256').update('jigcoin/result/'+first+'/'+second).digest('hex').slice(0,32);
    await pool.query(`INSERT INTO ${CARDS}(code,first_run,second_run) VALUES ($1,$2,$3)
      ON CONFLICT DO NOTHING`, [code,first,second]);
    return read(code, viewer);
  }
  return {installed, read, compare};
}
module.exports = {createWeeklyResults, rankFinish, runFinish};
