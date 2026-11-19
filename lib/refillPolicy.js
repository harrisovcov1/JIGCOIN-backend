'use strict';

const crypto = require('node:crypto');
const {ids} = require('./releaseAccess');
const VERSION = 'refill-v15-20261119';
const TABLE = 'jigcoin_internal.refill_cohorts_v15';
const fail = (code, status = 409) => Object.assign(Error(code), {code, status});

function snapshot(row) {
  if (!row) return null;
  return {version: row.policy_version, group: row.cohort,
    cooldown_seconds: Number(row.cooldown_seconds), offer_threshold_pct: 30,
    // Preparation is allowed whenever a refill can help. Cache freshness is
    // independent of the successful-claim cooldown and adds no retry penalty.
    prepare_threshold_pct: 100, ready_ttl_ms: 300000, retry_seconds: 0};
}

function createRefillPolicy({pool, env = process.env}) {
  const qa = ids(env.ANALYTICS_TEST_TELEGRAM_IDS);
  if (env.RECOVERY_TEST_TELEGRAM_ID) qa.add(String(env.RECOVERY_TEST_TELEGRAM_ID));

  async function assertReady() {
    const result = await pool.query(`SELECT
      to_regclass('jigcoin_internal.refill_cohorts_v15') IS NOT NULL
      AND to_regclass('jigcoin_internal.refill_events_v15') IS NOT NULL
      AND to_regclass('jigcoin_internal.refill_finance_v15') IS NOT NULL AS ready`);
    if (!result.rows[0]?.ready) throw fail('INSTALL_REFILL_V15_MIGRATION', 503);
  }

  async function peek(userId) {
    return (await pool.query(`SELECT * FROM ${TABLE} WHERE user_id=$1 AND policy_version=$2`,
      [userId, VERSION])).rows[0] || null;
  }

  async function enroll(user) {
    if (!Number.isSafeInteger(Number(user?.id)) || Number(user.id) < 1 || user.is_system_user)
      throw fail('ACCOUNT_UNAVAILABLE', 403);
    const treatment = crypto.createHash('sha256').update(VERSION + '/' + user.id).digest()[0] < 128;
    // A separate immutable assignment: never update the existing v14 refill/
    // holdout group. A later QA exclusion is monotonic, not a reassignment.
    const result = await pool.query(`INSERT INTO ${TABLE} AS p
      (user_id,policy_version,cohort,cooldown_seconds,excluded)
      SELECT u.id,$2,CASE WHEN $3 OR coalesce(a.excluded,FALSE) THEN 'qa_120' ELSE $4 END,
        CASE WHEN $3 OR coalesce(a.excluded,FALSE) THEN 120 ELSE $5 END,
        $3 OR coalesce(a.excluded,FALSE)
      FROM public.users u LEFT JOIN jigcoin_internal.acquisition_v13 a ON a.user_id=u.id
      WHERE u.id=$1 AND NOT coalesce(u.is_system_user,FALSE)
      ON CONFLICT (user_id,policy_version) DO UPDATE SET
        excluded=p.excluded OR EXCLUDED.excluded,
        returned_day7_at=CASE WHEN p.returned_day7_at IS NULL
          AND clock_timestamp()>=p.assigned_at+interval '168 hours'
          AND clock_timestamp()<p.assigned_at+interval '192 hours' THEN clock_timestamp()
          ELSE p.returned_day7_at END
      WHERE (NOT p.excluded AND EXCLUDED.excluded) OR (p.returned_day7_at IS NULL
        AND clock_timestamp()>=p.assigned_at+interval '168 hours'
        AND clock_timestamp()<p.assigned_at+interval '192 hours')
      RETURNING *`, [user.id, VERSION, qa.has(String(user.telegram_id)),
      treatment ? 'treatment_120' : 'control_300', treatment ? 120 : 300]);
    const row = result.rows[0] || await peek(user.id);
    if (!row) throw fail('REFILL_POLICY_UNAVAILABLE', 503);
    return snapshot(row);
  }

  async function observe(user, body, attempt) {
    const row = await peek(user.id);
    if (!row || (attempt && (attempt.refill_policy_version !== row.policy_version ||
        attempt.refill_group !== row.cohort))) throw fail('AD_POLICY_REQUIRED');
    const policy = snapshot(row);
    // These are client observations, not billable impressions or reward proof.
    // Database uniqueness deduplicates retries across tabs/server instances.
    const result = await pool.query(`INSERT INTO jigcoin_internal.refill_events_v15
      (user_id,policy_version,cohort,attempt_id,event,elapsed_ms,offer_window)
      VALUES ($1,$2,$3,$4,$5,$6,
        CASE WHEN $4::uuid IS NULL THEN date_trunc('minute',clock_timestamp()) ELSE NULL END)
      ON CONFLICT DO NOTHING RETURNING id`, [user.id, policy.version, policy.group,
      body.attempt_id, body.error_code, Object.hasOwn(body, 'elapsed_ms') ? body.elapsed_ms : null]);
    return {ok: true, recorded: true, duplicate: !result.rows.length};
  }

  return {assertReady, enroll, peek, observe};
}

module.exports = {createRefillPolicy, VERSION, snapshot};
