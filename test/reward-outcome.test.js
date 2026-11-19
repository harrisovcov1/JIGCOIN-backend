'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMonetagRewards } = require('../lib/monetagRewards');
const { startIsolatedApp, signedInitData } = require('./helpers/httpApp.cjs');

const CODE = 'sp_emergency_energy';
const ATTEMPT = 'a08c5c52-3b54-4a0c-9230-7f552bcce251';
const OTHER_ATTEMPT = 'b08c5c52-3b54-4a0c-9230-7f552bcce252';
const user = { id: 1, telegram_id: '10001', is_system_user: false, banned_until: null };

function database({ failInsert = false, omitReceipt = false } = {}) {
  const calls = [], events = [];
  const attempts = [
    { ymid: ATTEMPT, user_id: 1, code: CODE, eligible_at: null, claimed_at: null },
    { ymid: OTHER_ATTEMPT, user_id: 2, code: CODE, eligible_at: null, claimed_at: null },
  ];
  const pool = { async query(sql, args) {
    calls.push({ sql, args });
    if (/^SELECT (?:\*|id,telegram_id,is_system_user,banned_until) FROM public\.users WHERE telegram_id=\$1/.test(sql.trim())) {
      const id = String(args[0]);
      return { rows: id === '10001' ? [{ ...user }] : id === '10002' ? [{ ...user, id: 2, telegram_id: '10002' }] : [] };
    }
    if (/^SELECT ymid,refill_policy_version,refill_group,cooldown_seconds FROM jigcoin_internal\.ad_attempts/.test(sql.trim())) {
      return { rows: attempts.filter(a => a.ymid === args[0] && a.user_id === args[1] && a.code === args[2]).map(a => ({ ymid: a.ymid })) };
    }
    if (/^INSERT INTO public\.event_log/.test(sql.trim())) {
      if (failInsert) throw Object.assign(Error('synthetic persistence failure'), { code: 'TEST_FAILURE' });
      if (omitReceipt) return { rows: [] };
      events.push({ user_id: args[0], event: 'reward_client_outcome_v1', meta: JSON.parse(args[1]) });
      return { rows: [{ id: events.length }] };
    }
    throw Error('Unexpected database operation in outcome endpoint');
  } };
  return { pool, calls, events, attempts };
}

function service(db, options = {}) {
  return createMonetagRewards({
    pool: db.pool, env: {}, allowClientOutcome: () => true, logger: { info() {} },
    withTransaction: async () => { throw Error('Outcome must not enter a reward transaction'); },
    applyBalanceChangeTx: async () => { throw Error('Outcome must not change balances'); },
    ...options,
  });
}

const outcome = overrides => ({ code: CODE, attempt_id: ATTEMPT, stage: 'display', error_code: 'DISPLAY_REJECTED', ...overrides });

test('outcome persistence and logs retain only bounded fields, without changing reward state', async () => {
  const db = database(), logs = [];
  const before = structuredClone(db.attempts);
  const rewards = service(db, { logger: { info: line => logs.push(line) } });
  const result = await rewards.reportOutcome(user, outcome({
    user_id: 999, telegram_id: 999, verified: true, reward_amount: 999999,
    error: 'private raw error', url: 'https://example.invalid/?secret=private', secret: 'private', stack: 'private',
  }));
  assert.deepEqual(result, { ok: true, recorded: true });
  assert.deepEqual(db.events, [{ user_id: 1, event: 'reward_client_outcome_v1', meta: outcome() }]);
  assert.deepEqual(db.attempts, before);
  assert.equal(db.calls.filter(c => /^INSERT/.test(c.sql.trim())).length, 1);
  assert.ok(db.calls.every(c => /^SELECT ymid,refill_policy_version,refill_group,cooldown_seconds FROM jigcoin_internal\.ad_attempts|^INSERT INTO public\.event_log/.test(c.sql.trim())));
  assert.deepEqual(logs, ['JigCoin reward client outcome ' + JSON.stringify({ stage: 'display', error_code: 'DISPLAY_REJECTED', attempt_id: ATTEMPT })]);
  assert.doesNotMatch(JSON.stringify(db.events) + logs.join(''), /private|telegram_id|reward_amount|verified|stack/);
});

test('attempt ownership and placement are checked before recording', async () => {
  const db = database(), rewards = service(db);
  for (const input of [outcome({ attempt_id: OTHER_ATTEMPT }), outcome({ code: 'sp_visit_partner' })]) {
    await assert.rejects(rewards.reportOutcome(user, input), { code: 'AD_ATTEMPT_NOT_FOUND' });
  }
  assert.equal(db.events.length, 0);
});

test('preload deadline is distinct from SDK timeout and optional timing is bounded and persisted safely', async () => {
  const db = database(), logs = [];
  const before = structuredClone(db.attempts);
  const rewards = service(db, { logger: { info: line => logs.push(line) } });
  for (const elapsedMs of [0, 9487, 300000]) {
    const input = outcome({ stage: 'preload', error_code: 'PRELOAD_DEADLINE', elapsed_ms: elapsedMs });
    await rewards.reportOutcome(user, {
      ...input, error: 'private provider text', cancellation_reason: 'private navigation data',
    });
    assert.deepEqual(db.events.at(-1).meta, input);
    assert.equal(logs.at(-1), 'JigCoin reward client outcome ' + JSON.stringify({
      stage: 'preload', error_code: 'PRELOAD_DEADLINE', attempt_id: ATTEMPT, elapsed_ms: elapsedMs,
    }));
  }
  const legacy = outcome({ stage: 'preload', error_code: 'SDK_TIMEOUT' });
  await rewards.reportOutcome(user, legacy);
  assert.deepEqual(db.events.at(-1).meta, legacy);
  assert.equal(Object.hasOwn(db.events.at(-1).meta, 'elapsed_ms'), false);
  await assert.rejects(rewards.reportOutcome(user, outcome({ error_code: 'PRELOAD_DEADLINE', elapsed_ms: 12000 })),
    { code: 'INVALID_AD_OUTCOME', status: 400 });
  assert.equal(db.events.length, 4);
  assert.deepEqual(db.attempts, before);
  assert.doesNotMatch(JSON.stringify(db.events) + logs.join(''), /private|cancellation_reason/);
});

test('invalid elapsed timing is rejected before ownership queries, rate limiting, persistence or logs', async () => {
  const db = database(), logs = [];
  let limiterCalls = 0;
  const rewards = service(db, {
    allowClientOutcome: () => { limiterCalls++; return true; },
    logger: { info: line => logs.push(line) },
  });
  for (const elapsedMs of [-1, 300001, 1.5, '9487', null, undefined, true, {}, [], NaN, Infinity, -Infinity]) {
    await assert.rejects(rewards.reportOutcome(user, outcome({ elapsed_ms: elapsedMs })),
      { code: 'INVALID_AD_OUTCOME', status: 400 });
  }
  assert.equal(limiterCalls, 0);
  assert.equal(db.calls.length, 0);
  assert.equal(db.events.length, 0);
  assert.equal(logs.length, 0);
});

test('null attempts are restricted to validated load/start failures; stage and code pairs are enforced', async () => {
  const db = database(), rewards = service(db);
  await rewards.reportOutcome(user, outcome({ attempt_id: null, stage: 'sdk_load', error_code: 'SDK_LOAD_TIMEOUT' }));
  await rewards.reportOutcome(user, outcome({ attempt_id: null, stage: 'start', error_code: 'INVALID_ATTEMPT' }));
  const accepted = db.events.length;
  for (const input of [
    outcome({ attempt_id: null, stage: 'preload', error_code: 'NO_FILL' }),
    outcome({ stage: 'confirmation', error_code: 'SDK_RETURNED' }),
    outcome({ stage: '__proto__', error_code: 'UNKNOWN' }),
    outcome({ error_code: 'https://example.invalid/?token=private' }),
    outcome({ attempt_id: 'not-a-uuid' }),
    outcome({ attempt_id: undefined }),
    outcome({ code: 'untrusted' }),
  ]) await assert.rejects(rewards.reportOutcome(user, input), e => e.status === 400);
  assert.equal(db.events.length, accepted);
});

test('a rate-denied or unpersisted outcome is not acknowledged or logged', async () => {
  const denied = database();
  await assert.rejects(service(denied, { allowClientOutcome: () => false }).reportOutcome(user, outcome()), { code: 'AD_OUTCOME_RATE_LIMIT', status: 429 });
  assert.equal(denied.calls.length, 0);
  for (const options of [{ failInsert: true }, { omitReceipt: true }]) {
    const db = database(options), logs = [];
    await assert.rejects(service(db, { logger: { info: line => logs.push(line) } }).reportOutcome(user, outcome()));
    assert.equal(logs.length, 0);
    assert.equal(db.events.length, 0);
  }
});

async function post(app, body, identity) {
  const response = await fetch(app.url + '/api/mission/outcome', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, ...(identity ? { initData: signedInitData(identity) } : {}) }),
  });
  return { status: response.status, body: await response.json() };
}

test('ordinary endpoint requires a signed existing account and performs no registration or gameplay writes', async t => {
  const db = database();
  const app = await startIsolatedApp(t, false, { pool: db.pool });
  assert.equal((await post(app, outcome())).status, 401);
  assert.equal(db.calls.length, 0);
  assert.equal((await post(app, outcome(), 10003)).status, 403);
  assert.equal((await post(app, outcome(), 10002)).status, 404);
  const result = await post(app, outcome(), 10001);
  assert.deepEqual(result, { status: 200, body: { ok: true, recorded: true } });
  assert.equal(db.events.length, 1);
  assert.ok(db.calls.every(c => /^SELECT |^INSERT INTO public\.event_log/.test(c.sql.trim())));
});

test('owner and cohort outcome routes work during maintenance while ordinary accounts remain blocked', async t => {
  const db = database();
  const app = await startIsolatedApp(t, true, { pool: db.pool, env: {
    RECOVERY_TEST_ENABLED: '1', RECOVERY_TEST_TELEGRAM_ID: '10001',
    RELEASE_COHORT_ENABLED: '1', RELEASE_COHORT_TELEGRAM_IDS: '10002',
  } });
  assert.equal((await post(app, outcome(), 10003)).status, 503);
  assert.equal(db.calls.length, 0);
  assert.equal((await post(app, outcome(), 10001)).status, 200);
  assert.equal((await post(app, outcome({ attempt_id: OTHER_ATTEMPT }), 10002)).status, 200);
  assert.equal(db.events.length, 2);
  assert.ok(db.calls.every(c => /^SELECT |^INSERT INTO public\.event_log/.test(c.sql.trim())));
});

test('endpoint caps diagnostic reports at twelve per user per ten-minute process window', async t => {
  const db = database();
  const app = await startIsolatedApp(t, false, { pool: db.pool });
  const input = outcome({ attempt_id: null, stage: 'sdk_load', error_code: 'SDK_LOAD_FAILED' });
  for (let i = 0; i < 12; i++) assert.equal((await post(app, input, 10001)).status, 200);
  const blocked = await post(app, input, 10001);
  assert.deepEqual(blocked, { status: 429, body: { ok: false, error: 'AD_OUTCOME_RATE_LIMIT' } });
  assert.equal(db.events.length, 12);
  assert.equal((await post(app, input, 10002)).status, 200);
});
