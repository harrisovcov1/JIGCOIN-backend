'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createWeeklyResults, rankFinish, runFinish} = require('./weeklyResults');

const PLAYERS = 'jigcoin_internal.pilot_players_v14';
const RACERS = 'jigcoin_internal.weekly_racers_v14';
const RUNS = 'jigcoin_internal.weekly_runs_v14';
const REQUESTS = 'jigcoin_internal.weekly_run_requests_v16';
const PRACTICE = 'jigcoin_internal.weekly_practice_runs_v16';
const FINALS = 'jigcoin_internal.weekly_finalizations_v16';
const AWARDS = 'jigcoin_internal.weekly_awards_v16';
const MIGRATION = '20261119172851_weekly_daily_runs_and_awards.sql';
const DAY = 86400000, LENGTH = 45000, LIMIT = 3, WEEK_LOCK = 1612026;
const DAILY_FROM = '2026-11-23T00:00:00.000Z';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const fail = (code, status = 400) => Object.assign(new Error(code), {code, status});
const dayOf = now => new Date(now).toISOString().slice(0,10);
const allowed = (alias, time) => `${alias}.telegram_id>0 AND COALESCE(${alias}.is_system_user,false)=false
  AND (${alias}.banned_until IS NULL OR ${alias}.banned_until<=${time})`;
const names = alias => `left(coalesce(nullif(${alias}.username,''),nullif(${alias}.first_name,''),'Player'),48)`;
const runFields = "*,week::text AS week_key,allowance_day::text AS allowance_key,'ranked'::text AS mode";
const practiceFields = "*,NULL::smallint AS slot,NULL::text AS week_key,'practice'::text AS mode";
const awardFields = 'week::text AS week,score,place,awarded_at,player_name AS name,finish_key AS finish,vip_active,rank_finish_key AS rank_finish';

function weekOf(now) {
  const start = new Date(now);
  start.setUTCHours(0,0,0,0);
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay()+6)%7);
  return {week:dayOf(start),closes:new Date(+start+7*DAY)};
}
function policyOf(now) {
  const daily = +new Date(now)>=Date.parse(DAILY_FROM);
  return {version:daily?'daily-v16':'weekly-v14',limit:LIMIT,period:daily?'day':'week',
    activates_at:DAILY_FROM,carryover:false,weekly_best:true,paid_advantage:false};
}

// Legacy puzzle values stay unchanged. Daily ranked puzzles share fair values
// for each UTC date/slot/turn, with individually shuffled layouts. Practice has
// an independent secret seed and cannot reveal future ranked puzzles.
function board(run) {
  const puzzleVersion=run.puzzle_version||run.policy_version;
  const key = run.mode==='practice' ? ['practice-v16',run.seed,run.turn].join('/') :
    puzzleVersion==='daily-v16' ? ['daily-v16',run.week_key,run.allowance_key || dayOf(run.allowance_day),run.slot,run.turn].join('/') :
    [run.week_key,run.slot,run.turn].join('/');
  const puzzle = crypto.createHash('sha256').update(key).digest();
  const digits = Array.from({length:9},(_,i)=>i+1);
  const shuffle = (a,bytes) => {
    for (let i=a.length-1;i>0;i--) {
      const j=bytes[i]%(i+1);
      [a[i],a[j]]=[a[j],a[i]];
    }
  };
  shuffle(digits,puzzle);
  const tiles=digits.slice(0,6), target=tiles[0]+tiles[1];
  shuffle(tiles,crypto.createHmac('sha256',run.seed).update(String(run.turn)).digest());
  return {tiles,target};
}

function createWeeklyRace({pool,withTransaction,env=process.env,clock}) {
  const cards=createWeeklyResults({pool,env});
  let prepared=false,preparing=null,retryAt=0,finalizing=null,finalizedForWeek=null;
  const nowOf = async c => clock ? new Date(clock()) : (await c.query('SELECT clock_timestamp() AS now')).rows[0].now;
  const mayInstall = () => env.JIGCOIN_INSTALL_PILOT_SCHEMA==='1' || env.AUTO_MIGRATE==='1';
  async function prepare() {
    if (prepared) return;
    if (preparing) return preparing;
    if (Date.now()<retryAt) throw fail('PILOT_STARTING',503);
    preparing=(async()=>{
      const c=await pool.connect();
      try {
        if (!(await c.query('SELECT to_regclass($1) AS present',[RUNS])).rows[0].present) {
          if (!mayInstall()) throw fail('PILOT_SCHEMA_REQUIRED',503);
          await c.query(await fs.readFile(path.join(__dirname,'../sql/migrations/024_revenue_pilot.sql'),'utf8'));
        }
        if (!await cards.installed()) throw fail('PILOT_SCHEMA_REQUIRED',503);
        const {rows:[schema]}=await c.query(`SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL
          AND to_regclass($3) IS NOT NULL AND to_regclass($4) IS NOT NULL AND (SELECT count(*)=2 FROM information_schema.columns
            WHERE table_schema='jigcoin_internal' AND table_name='weekly_runs_v14' AND column_name IN ('allowance_day','puzzle_version')) AS ready`,[PRACTICE,FINALS,AWARDS,REQUESTS]);
        if (!schema.ready) {
          if (!mayInstall()) throw fail('WEEKLY_SCHEMA_REQUIRED',503);
          await c.query(await fs.readFile(path.join(__dirname,'../sql/migrations',MIGRATION),'utf8'));
        }
        prepared=true;
      } catch(error) {
        await c.query('ROLLBACK').catch(()=>{});
        retryAt=Date.now()+30000;
        throw error;
      } finally { c.release(); }
    })().finally(()=>{preparing=null;});
    return preparing;
  }
  function eligible(user,now=clock?new Date(clock()):new Date()) {
    if (!user || user.is_system_user || !(Number(user.telegram_id)>0) || new Date(user.banned_until)>now)
      throw fail('PLAYER_UNAVAILABLE',403);
  }
  async function lockPlayer(c,user) {
    const row=(await c.query(`SELECT id,telegram_id,is_system_user,banned_until,balance,vip_until
      FROM public.users WHERE id=$1 AND telegram_id=$2 FOR UPDATE`,[user.id,user.telegram_id])).rows[0];
    eligible(row,await nowOf(c));
    return row;
  }
  async function lockWeek(c,week,shared=false) {
    await c.query(`SELECT pg_advisory_xact_lock${shared?'_shared':''}($1::int,$2::int)`,
      [WEEK_LOCK,Math.floor(Date.parse(week+'T00:00:00Z')/DAY)]);
  }
  function view(run,now) {
    if (!run) return null;
    const live=new Date(run.ends_at)>now;
    return {id:run.id,mode:run.mode||'ranked',slot:run.slot,turn:run.turn,score:run.score,
      starts_at:run.starts_at,ends_at:run.ends_at,live,board:live?board(run):null,
      allowance_day:run.allowance_key||null,policy_version:run.policy_version||'practice-v16',
      puzzle_version:run.puzzle_version||'practice-v16'};
  }
  const response = (user,now,run,extra={}) => ({ok:true,telegram_id:String(user.telegram_id),server_now:now,...extra,run:view(run,now)});
  const validateMove = body => {
    if (!uuid(body.id) || !Number.isSafeInteger(body.turn) || body.turn<0 || !Array.isArray(body.picks) ||
      body.picks.length!==2 || body.picks[0]===body.picks[1] || !body.picks.every(i=>Number.isInteger(i)&&i>=0&&i<6))
      throw fail('INVALID_MOVE');
  };
  async function usedSlots(c,user,now) {
    const policy=policyOf(now), {week}=weekOf(now);
    const period=policy.period==='day'?'allowance_day=$2::date':'week=$2::date';
    const value=policy.period==='day'?dayOf(now):week;
    return Number((await c.query(`SELECT coalesce(max(slot),0)::int AS used FROM ${RUNS}
      WHERE user_id=$1 AND ${period} AND policy_version=$3`,[user.id,value,policy.version])).rows[0].used);
  }

  async function enroll(user) {
    eligible(user);
    await prepare();
    const split=env.JIGCOIN_REFILL_TEST==='1';
    const bucket=crypto.createHash('sha256').update('refill-v14/'+user.id).digest()[0];
    const group=split?(bucket<128?'refill':'holdout'):'baseline';
    const row=(await pool.query(`INSERT INTO ${PLAYERS} AS p(user_id,ad_group) VALUES ($1,$2)
      ON CONFLICT (user_id) DO UPDATE SET returned_day7_at=clock_timestamp()
      WHERE p.returned_day7_at IS NULL AND clock_timestamp()>=p.enrolled_at+interval '168 hours'
        AND clock_timestamp()<p.enrolled_at+interval '192 hours' RETURNING ad_group,vip_coin`,[user.id,group])).rows[0];
    return row || (await pool.query(`SELECT ad_group,vip_coin FROM ${PLAYERS} WHERE user_id=$1`,[user.id])).rows[0];
  }
  async function refillAvailable(user) {
    try { return (await enroll(user)).ad_group!=='holdout'; }
    catch { return false; }
  }

  // The same week lock is held by ranked answers. The final snapshot therefore
  // waits for accepted answers to commit and rejects every later score change.
  async function finalizeDue({force=false,now:providedNow}={}) {
    await prepare();
    const now=providedNow || await nowOf(pool), {week}=weekOf(now);
    if (!force && finalizedForWeek===week) return [];
    if (finalizing) {
      await finalizing;
      return finalizeDue({force,now});
    }
    finalizing=(async()=>{
      const candidates=(await pool.query(`SELECT candidate.week::text AS week FROM (
        SELECT week FROM ${RACERS} WHERE week<$1::date
        UNION SELECT $1::date-7
      ) candidate WHERE NOT EXISTS (SELECT 1 FROM ${FINALS} f WHERE f.week=candidate.week)
      ${require('./championshipRules').legacyPeriodFilter('candidate.week')} ORDER BY candidate.week`,[week])).rows;
      const finished=[];
      for (const candidate of candidates) {
        const result=await withTransaction(async c=>{
          await lockWeek(c,candidate.week);
          if ((await c.query(`SELECT 1 FROM ${FINALS} WHERE week=$1`,[candidate.week])).rowCount) return null;
          const {rows:[final]}=await c.query(`WITH eligible AS MATERIALIZED (
            SELECT r.user_id,r.best,${names('u')} AS player_name FROM ${RACERS} r
            JOIN public.users u ON u.id=r.user_id WHERE r.week=$1::date AND r.best>0 AND ${allowed('u','$2')}
          ), summary AS (SELECT count(*)::int AS participants,coalesce(max(best),0) AS winning_score FROM eligible),
          finalized AS (
            INSERT INTO ${FINALS}(week,finalized_at,participants,winning_score,policy_version,source)
            SELECT $1::date,$2,participants,winning_score,$3,'server' FROM summary RETURNING *
          ), awards AS (
            INSERT INTO ${AWARDS}(week,user_id,score,place,awarded_at,player_name,finish_key,vip_active,rank_finish_key)
            SELECT f.week,e.user_id,e.best,1,f.finalized_at,e.player_name,
              best.finish_key,best.vip_active_at_start,best.rank_finish_key
            FROM finalized f JOIN eligible e ON e.best=f.winning_score
            LEFT JOIN LATERAL (SELECT r.finish_key,r.vip_active_at_start,r.rank_finish_key FROM ${RUNS} r
              WHERE r.week=f.week AND r.user_id=e.user_id AND r.score=e.best AND r.ends_at<=$2
              ORDER BY r.starts_at DESC,r.id LIMIT 1) best ON true
            RETURNING user_id
          ) SELECT f.week::text AS week,f.participants,f.winning_score,(SELECT count(*)::int FROM awards) AS winners
            FROM finalized f`,[candidate.week,now,policyOf(candidate.week+'T00:00:00Z').version]);
          return final;
        });
        if (result) finished.push(result);
      }
      finalizedForWeek=week;
      return finished;
    })().finally(()=>{finalizing=null;});
    return finalizing;
  }
  function kickFinalizer() {
    return finalizeDue().catch(error=>{console.error('[weekly-race] finalization failed',error.code||error.message);});
  }
  async function profile(user,setting) {
    const p=await enroll(user),now=await nowOf(pool);
    if (setting!==undefined) {
      if (typeof setting!=='boolean') throw fail('INVALID_COIN_STYLE');
      const result=await pool.query(`UPDATE ${PLAYERS} p SET vip_coin=$2 FROM public.users u
        WHERE p.user_id=$1 AND u.id=p.user_id AND (NOT $2 OR u.vip_until>$3) RETURNING p.vip_coin`,[user.id,setting,now]);
      if (!result.rowCount) throw fail('VIP_REQUIRED',403);
      p.vip_coin=result.rows[0].vip_coin;
    }
    await finalizeDue({now});
    const [account,awards]=await Promise.all([
      pool.query('SELECT coalesce(vip_until>$2,false) AS vip_active FROM public.users WHERE id=$1',[user.id,now]),
      pool.query(`SELECT ${awardFields} FROM ${AWARDS} WHERE user_id=$1 ORDER BY week DESC`,[user.id])
    ]);
    const active=account.rows[0]?.vip_active===true;
    return {ok:true,telegram_id:String(user.telegram_id),refill:p.ad_group!=='holdout',vip_active:active,
      vip_coin:active&&p.vip_coin,medals:awards.rows.map(({week,score})=>({week,score})),weekly_awards:awards.rows};
  }
  async function dress(rows) {
    if (!rows.length) return rows;
    try { await prepare(); } catch { return rows; }
    const now=await nowOf(pool);
    const {rows:accounts}=await pool.query(`SELECT u.telegram_id::text AS id,u.balance,
      coalesce(u.vip_until>$2,false) AS vip_active,coalesce(p.vip_coin AND u.vip_until>$2,false) AS vip_coin
      FROM public.users u LEFT JOIN ${PLAYERS} p ON p.user_id=u.id WHERE u.telegram_id=ANY($1::bigint[])`,[rows.map(r=>r.telegram_id),now]);
    const byId=new Map(accounts.map(a=>[a.id,a]));
    return rows.map(row=>{
      const account=byId.get(String(row.telegram_id));
      if (!account) return {...row,vip_active:false,vip_coin:false,rank_finish:null,finish:null};
      const rank=rankFinish(account.balance);
      return {...row,vip_active:account.vip_active,vip_coin:account.vip_coin,rank_finish:rank,finish:account.vip_coin?'midnight':rank};
    });
  }

  async function start(user,body={}) {
    eligible(user);
    if (!uuid(body.request_key)) throw fail('INVALID_RUN');
    await prepare();
    return withTransaction(async c=>{
      // Week locks precede player locks. Final award inserts take a foreign-key
      // lock on a player; reversing this order can deadlock a late answer.
      await lockWeek(c,weekOf(await nowOf(c)).week,true);
      const player=await lockPlayer(c,user),now=await nowOf(c),{week,closes}=weekOf(now),policy=policyOf(now);
      const old=(await c.query(`SELECT ${runFields} FROM ${RUNS} WHERE user_id=$1 AND (request_key=$2 OR id=
        (SELECT run_id FROM ${REQUESTS} WHERE user_id=$1 AND request_key=$2))`,[user.id,body.request_key])).rows[0];
      const last=old || (await c.query(`SELECT ${runFields} FROM ${RUNS} WHERE user_id=$1 AND week=$2
        ORDER BY starts_at DESC,id LIMIT 1`,[user.id,week])).rows[0];
      let run=last;
      if (!old && !(last && new Date(last.ends_at)>now)) {
        const slot=1+await usedSlots(c,user,now);
        if (slot>LIMIT) throw fail('RUNS_USED',409);
        if (+closes-+now<LENGTH) throw fail('WEEK_CLOSING',409);
        await lockWeek(c,week,true);
        if ((await c.query(`SELECT 1 FROM ${FINALS} WHERE week=$1`,[week])).rowCount) throw fail('WEEK_CLOSED',409);
        await c.query(`INSERT INTO ${RACERS}(week,user_id,share_code) VALUES ($1,$2,$3) ON CONFLICT (week,user_id) DO NOTHING`,
          [week,user.id,crypto.randomBytes(10).toString('hex')]);
        run=(await c.query(`INSERT INTO ${RUNS}
          (id,request_key,week,user_id,slot,seed,starts_at,ends_at,finish_key,allowance_day,policy_version,vip_active_at_start,rank_finish_key,puzzle_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING ${runFields}`,
          [crypto.randomUUID(),body.request_key,week,user.id,slot,crypto.randomBytes(24).toString('hex'),now,new Date(+now+LENGTH),
            await runFinish(c,player,body.launch_equipped,now),dayOf(now),policy.version,new Date(player.vip_until)>now,rankFinish(player.balance),policy.version])).rows[0];
      }
      if (!old) {
        const aliases=Number((await c.query(`SELECT count(*)::int AS n FROM ${REQUESTS} WHERE run_id=$1`,[run.id])).rows[0].n);
        if (aliases>=16) throw fail('RUN_RETRY_LIMIT',429);
      }
      await c.query(`INSERT INTO ${REQUESTS}(user_id,request_key,run_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,[user.id,body.request_key,run.id]);
      return response(user,now,run);
    });
  }
  async function practiceStart(user,body={}) {
    eligible(user);
    if (!uuid(body.request_key)) throw fail('INVALID_RUN');
    await prepare();
    return withTransaction(async c=>{
      await lockPlayer(c,user);
      const now=await nowOf(c);
      let run=(await c.query(`SELECT ${practiceFields} FROM ${PRACTICE} WHERE user_id=$1 FOR UPDATE`,[user.id])).rows[0];
      const known=run?.request_keys.includes(body.request_key.toLowerCase());
      if (!run || (!known && new Date(run.ends_at)<=now)) {
        run=(await c.query(`INSERT INTO ${PRACTICE}(user_id,id,request_key,request_keys,seed,starts_at,ends_at)
          VALUES ($1,$2,$3,ARRAY[$3::uuid],$4,$5,$6) ON CONFLICT (user_id) DO UPDATE SET
            id=EXCLUDED.id,request_key=EXCLUDED.request_key,request_keys=EXCLUDED.request_keys,seed=EXCLUDED.seed,
            starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,turn=0,score=0 RETURNING ${practiceFields}`,
          [user.id,crypto.randomUUID(),body.request_key,crypto.randomBytes(24).toString('hex'),now,new Date(+now+LENGTH)])).rows[0];
      } else if (!known) {
        if (run.request_keys.length>=16) throw fail('RUN_RETRY_LIMIT',429);
        run=(await c.query(`UPDATE ${PRACTICE} SET request_keys=array_append(request_keys,$2::uuid)
          WHERE user_id=$1 RETURNING ${practiceFields}`,[user.id,body.request_key])).rows[0];
      }
      return response(user,now,run);
    });
  }
  async function answerMode(user,body,practice) {
    eligible(user);
    validateMove(body);
    await prepare();
    const table=practice?PRACTICE:RUNS,fields=practice?practiceFields:runFields;
    return withTransaction(async c=>{
      if (!practice) {
        const found=(await c.query(`SELECT week::text AS week FROM ${RUNS} WHERE id=$1 AND user_id=$2`,[body.id,user.id])).rows[0];
        if (!found) throw fail('RUN_UNAVAILABLE',404);
        await lockWeek(c,found.week,true);
      }
      await lockPlayer(c,user);
      let run=(await c.query(`SELECT ${fields} FROM ${table} WHERE id=$1 AND user_id=$2 FOR UPDATE`,[body.id,user.id])).rows[0];
      if (!run) throw fail('RUN_UNAVAILABLE',404);
      const now=await nowOf(c);
      let correct=null;
      if (body.turn>run.turn) throw fail('REFRESH_RUN',409);
      const closed=!practice && (await c.query(`SELECT 1 FROM ${FINALS} WHERE week=$1`,[run.week_key])).rowCount>0;
      if (!closed && body.turn===run.turn && new Date(run.ends_at)>now) {
        const {tiles,target}=board(run);
        correct=tiles[body.picks[0]]+tiles[body.picks[1]]===target;
        run=(await c.query(`UPDATE ${table} SET turn=turn+1,score=score+$2 WHERE id=$1 RETURNING ${fields}`,
          [run.id,correct?1:0])).rows[0];
        if (correct && !practice) await c.query(`UPDATE ${RACERS} SET best=greatest(best,$3) WHERE week=$1 AND user_id=$2`,[run.week_key,user.id,run.score]);
      }
      return response(user,now,run,{correct});
    });
  }
  const answer=(user,body={})=>answerMode(user,body,false);
  const practiceAnswer=(user,body={})=>answerMode(user,body,true);
  async function endMode(user,body,practice) {
    eligible(user);
    if (!uuid(body.id)) throw fail('INVALID_RUN');
    await prepare();
    return withTransaction(async c=>{
      await lockPlayer(c,user);
      const run=(await c.query(`SELECT ${practice?practiceFields:runFields} FROM ${practice?PRACTICE:RUNS}
        WHERE id=$1 AND user_id=$2 FOR UPDATE`,[body.id,user.id])).rows[0];
      if (!run) throw fail('RUN_UNAVAILABLE',404);
      // Reconciliation only: an early end request cannot shorten the timer,
      // accept a client score, grant a prize, or release another ranked slot.
      return response(user,await nowOf(c),run);
    });
  }
  const end=(user,body={})=>endMode(user,body,false);
  const practiceEnd=(user,body={})=>endMode(user,body,true);

  async function standings(user,body={}) {
    eligible(user);
    if (body.scope!==undefined && !['global','friends'].includes(body.scope)) throw fail('INVALID_SCOPE');
    await prepare();
    const scope=body.scope||'global',now=await nowOf(pool),{week,closes}=weekOf(now),policy=policyOf(now);
    await finalizeDue({now});
    const code=typeof body.rival==='string' && /^[a-f0-9]{20}$/.test(body.rival)?body.rival:null;
    const values=[week,user.id,now];
    const filter=scope==='friends'?`(u.id=$2 OR EXISTS (SELECT 1 FROM public.referrals f
      WHERE (f.inviter_id=$4::bigint AND f.invited_id=u.telegram_id)
        OR (f.invited_id=$4::bigint AND f.inviter_id=u.telegram_id)))`:'true';
    if (scope==='friends') values.push(user.telegram_id);
    const eligiblePlayers=`SELECT r.best,r.user_id FROM ${RACERS} r JOIN public.users u ON u.id=r.user_id
      WHERE r.week=$1 AND r.best>0 AND ${allowed('u','$3')}`;
    const [latest,practice,own,podium,rival,used,lastAward,lastFinal]=await Promise.all([
      pool.query(`SELECT ${runFields} FROM ${RUNS} WHERE week=$1 AND user_id=$2 ORDER BY starts_at DESC,id LIMIT 1`,[week,user.id]),
      pool.query(`SELECT ${practiceFields} FROM ${PRACTICE} WHERE user_id=$1`,[user.id]),
      pool.query(`WITH eligible AS (${eligiblePlayers}), scoped AS (${eligiblePlayers} AND ${filter})
        SELECT me.best,me.share_code,(SELECT count(*)::int FROM scoped) AS total,
          CASE WHEN me.best>0 THEN 1+(SELECT count(*)::int FROM scoped b WHERE b.best>me.best) END AS place,
          CASE WHEN me.best>0 THEN 1+(SELECT count(*)::int FROM eligible b WHERE b.best>me.best) END AS global_place
        FROM (SELECT 1) anchor LEFT JOIN ${RACERS} me ON me.week=$1 AND me.user_id=$2`,values),
      pool.query(`SELECT ${names('u')} AS name,r.best AS score,u.id=$2 AS me,r.share_code,u.balance,
        coalesce(u.vip_until>$3,false) AS vip_active,coalesce(p.vip_coin AND u.vip_until>$3,false) AS vip_coin,
        rank() OVER(ORDER BY r.best DESC)::int AS place FROM ${RACERS} r JOIN public.users u ON u.id=r.user_id
        LEFT JOIN ${PLAYERS} p ON p.user_id=u.id WHERE r.week=$1 AND r.best>0 AND ${allowed('u','$3')} AND ${filter}
        ORDER BY r.best DESC,u.id LIMIT 10`,values),
      code?pool.query(`SELECT r.week::text AS week,r.best AS score,${names('u')} AS name,u.id=$2 AS me
        FROM ${RACERS} r JOIN public.users u ON u.id=r.user_id WHERE r.share_code=$1 AND ${allowed('u','$3')}`,[code,user.id,now]):Promise.resolve({rows:[]}),
      usedSlots(pool,user,now),
      pool.query(`SELECT ${awardFields} FROM ${AWARDS} WHERE user_id=$1 ORDER BY week DESC LIMIT 1`,[user.id]),
      pool.query(`SELECT max(week)::text AS week FROM ${FINALS}`)
    ]);
    let result=null;
    if (code || body.card) result=body.card?await cards.read(body.card,user):await cards.compare(user,code,week,now);
    const me=own.rows[0],remaining=Math.max(0,LIMIT-used),closing=+closes-+now<LENGTH;
    const leaders=podium.rows.map(({balance,...row})=>({...row,rank_finish:rankFinish(balance),finish:row.vip_coin?'midnight':rankFinish(balance)}));
    const resets=policy.period==='day'?new Date(Date.parse(dayOf(now)+'T00:00:00Z')+DAY):closes;
    return {ok:true,telegram_id:String(user.telegram_id),server_now:now,scope,week,closes_at:closes,policy,
      allowance_day:dayOf(now),resets_at:resets,runs_left:remaining,seconds:LENGTH/1000,
      can_start:remaining>0&&!closing,starts_blocked_until:closing?closes:null,
      run:view(latest.rows[0],now),practice_run:view(practice.rows[0],now),best:me?.best||0,
      total:me?.total||0,place:me?.place?Number(me.place):null,global_place:me?.global_place?Number(me.global_place):null,
      share_code:me?.share_code||null,leaders,rival:rival.rows[0]||null,result,
      last_award:lastAward.rows[0]||null,finalized_through_week:lastFinal.rows[0]?.week||null};
  }
  async function prepareRelease() {
    await prepare();
    await finalizeDue();
  }
  return {prepare,prepareRelease,enroll,refillAvailable,profile,dress,start,answer,end,standings,
    practiceStart,practiceAnswer,practiceEnd,finalizeDue,kickFinalizer};
}
module.exports={createWeeklyRace,weekOf,policyOf,board,DAILY_FROM};
