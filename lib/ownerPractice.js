'use strict';

const {randomUUID} = require('node:crypto');
const games = require('./championshipGames');
const {viewRun} = require('./championshipService');
const ttl = 10 * 60 * 1000;
const validRequest = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function reject(code, status = 400) {
  throw Object.assign(new Error(code), {code, status});
}

// One expiring rehearsal per process, with no persistence, rankings or ledger dependency.
function createOwnerPractice({clock = Date.now, deal = games.puzzle} = {}) {
  let run;
  function current(owner) {
    if (run && (clock() >= run.expires || run.owner !== owner)) run = undefined;
    return run;
  }
  function status(owner) {
    const active = current(owner);
    return {variants: games.names.map((name, id) => ({id, name, instructions: games.instructions[id]})),
      run: active ? {id: active.id, variant: active.variant, finished: active.finished} : null};
  }
  function start(owner, body) {
    const previous = current(owner);
    if (body.mode !== 'practice' || !Number.isInteger(body.variant) || !games.names[body.variant] ||
        !validRequest(body.request)) reject('INVALID_PRACTICE');
    if (previous && previous.request === body.request && previous.variant === body.variant) return viewRun(previous);
    if (body.previous !== (previous?.id ?? null)) reject('REOPEN_PRACTICE', 409);
    const now = clock();
    run = {id: randomUUID(), owner, request: body.request, variant: body.variant, mode: 'practice',
      round: 0, points: 0, opened: now, expires: now + ttl, finished: false, flips: [], board: deal(body.variant)};
    return viewRun(run);
  }
  function act(owner, action, body) {
    if (action === 'start') return start(owner, body);
    const r = current(owner);
    if (!r || body.id !== r.id) reject('REOPEN_PRACTICE', 409);
    if (action === 'resume') return viewRun(r);
    if (!Number.isInteger(body.round) || body.round < 0 || body.round > r.round) reject('INVALID_ROUND');
    if (action === 'answer' && (body.round < r.round || r.finished)) return viewRun(r);
    if (r.finished || body.round !== r.round) reject('ROUND_CLOSED', 409);
    const observation = games.observation(r.board);
    const age = clock() - r.opened;
    if (action === 'observe') {
      if (!observation) return {done: true};
      const frame = Math.floor(age / observation.interval);
      return frame >= observation.frames.length ? {done: true} :
        {frame: observation.frames[frame], wait: (frame + 1) * observation.interval - age};
    }
    if (observation && age < observation.frames.length * observation.interval) reject('OBSERVE_FIRST', 409);
    if (action === 'flip') {
      const {tile, step} = body;
      const {faces, hidden, turns} = r.board;
      if (!hidden || !Number.isInteger(tile) || tile < 0 || tile >= faces.length ||
          !Number.isInteger(step) || step < 0 || step >= 2 * turns) reject('INVALID_FLIP');
      if (step === r.flips.length) {
        for (let n = 0; n + 1 < step; n += 2) {
          const [left, right] = r.flips.slice(n, n + 2);
          if (faces[left] === faces[right] && (tile === left || tile === right)) reject('ALREADY_MATCHED');
        }
        if (step % 2 && r.flips[step - 1] === tile) reject('SAME_TILE');
        r.flips.push(tile);
      } else if (step !== r.flips.length - 1 || r.flips[step] !== tile) reject('STALE_FLIP', 409);
      return {face: faces[tile], matched: Boolean(step % 2 && faces[tile] === faces[r.flips[step - 1]])};
    }
    if (action !== 'answer' || !Array.isArray(body.actions) || body.actions.length > 20 ||
        !body.actions.every(Number.isSafeInteger)) reject('INVALID_ANSWER');
    if (r.board.hidden && JSON.stringify(body.actions) !== JSON.stringify(r.flips)) reject('MISMATCHED_FLIPS');
    const points = games.points(r.board, body.actions);
    r.points += points;
    r.round++;
    r.finished = r.round === 5;
    r.board = r.finished ? {} : deal(r.variant);
    r.flips = [];
    r.opened = clock();
    return {...viewRun(r), lastCorrect: points === 200};
  }
  return {status, act};
}

// The status probe also serves ordinary players while the championship is inactive.
function installOwnerPractice({app, env, pool, verifyTelegramInitData, handler}) {
  const owner = env.CHAMPIONSHIP_OWNER_PREVIEW_ID;
  if (!/^[1-9]\d{0,15}$/.test(owner || '') || !Number.isSafeInteger(Number(owner)) || env.CHAMPIONSHIP_V2 === '1') return;
  const practice = createOwnerPractice();
  function identity(req) {
    const raw = req.body?.initData || req.headers['x-telegram-initdata'];
    const token = String(env.TELEGRAM_BOT_TOKEN || env.BOT_TOKEN || '').trim();
    if (!verifyTelegramInitData(raw, token).ok) reject('UNAUTHORIZED', 401);
    const user = JSON.parse(new URLSearchParams(raw).get('user') || 'null');
    if (!Number.isSafeInteger(user?.id) || user.id <= 0 || user.is_bot) reject('UNAUTHORIZED', 401);
    return String(user.id);
  }
  async function eligible(id) {
    if (id !== owner) return false;
    const result = await pool.query(`SELECT 1 FROM public.users u WHERE u.telegram_id=$1
      AND NOT coalesce(u.is_system_user,false) AND (u.banned_until IS NULL OR u.banned_until<=now())
      AND NOT EXISTS (SELECT 1 FROM jigcoin_internal.championship_exclusions x WHERE x.player=u.id)`, [id]);
    return result.rowCount === 1;
  }
  app.post('/api/championship/status', handler(async req => {
    const id = identity(req);
    return await eligible(id) ? {active: false, ownerPractice: practice.status(id)} : {active: false};
  }));
  for (const method of ['start','resume','observe','flip','answer']) {
    app.post('/api/championship/owner-practice/' + method, handler(async req => {
      const id = identity(req);
      if (!await eligible(id)) reject('UNAVAILABLE', 403);
      return practice.act(id, method, req.body);
    }));
  }
}
module.exports = {createOwnerPractice, installOwnerPractice};
