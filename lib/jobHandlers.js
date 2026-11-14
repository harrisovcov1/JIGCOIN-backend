// lib/jobHandlers.js
// Centralised job type handling for the background worker.
//
// Responsibilities:
// - Define supported job types and their handlers.
// - Provide a dispatcher used by worker.js.
//
// IMPORTANT:
// - Handlers must be idempotent. It should be safe to run them multiple times.
// - For permanent errors (e.g. bad payload), throw NonRetryableJobError so the
//   worker can stop retrying the job early.

const { sendPayout } = require("./payoutProvider");

class NonRetryableJobError extends Error {
  constructor(message) {
    super(message);
    this.name = "NonRetryableJobError";
    this.permanent = true;
  }
}

/**
 * sync_user
 *
 * Compare stored balances with the ledger without changing either source.
 * The recovered database contains discrepancies; their correct resolution
 * requires reviewing historical credits, not blindly replacing balances.
 */
async function handleSyncUser(client, job) {
  const payload = job.payload_json || {};
  const userId = Number(payload.user_id || payload.userId || 0);

  if (!userId) {
    // Bad payload – there is nothing useful to retry here.
    console.warn("sync_user job missing user_id", payload);
    throw new NonRetryableJobError("sync_user job missing user_id");
  }

  // Load the user row and lock it for this transaction.
  const userRes = await client.query(
    `
    SELECT id, balance
    FROM public.users
    WHERE id = $1
    FOR UPDATE
    `,
    [userId]
  );

  if (!userRes.rows.length) {
    console.warn("sync_user: user not found", { userId });
    throw new NonRetryableJobError("sync_user: user not found");
  }

  const user = userRes.rows[0];

  // Compute the ledger total for comparison. Completeness is not yet proven.
  const ledgerRes = await client.query(
    `
    SELECT COALESCE(SUM(delta), 0) AS balance_from_ledger
    FROM public.user_balance_ledger
    WHERE user_id = $1
    `,
    [userId]
  );

  // PostgreSQL bigint/numeric totals arrive as strings. Number conversion can
  // hide differences above Number.MAX_SAFE_INTEGER, so compare exact integers.
  function exactBalance(value) {
    if ((typeof value === "number" && !Number.isSafeInteger(value)) ||
        !["string", "number", "bigint"].includes(typeof value) ||
        !/^-?\d+$/.test(String(value))) {
      const error = new NonRetryableJobError("sync_user: invalid balance");
      error.code = "INVALID_BALANCE";
      throw error;
    }
    return BigInt(value);
  }

  const balanceFromLedger = exactBalance(ledgerRes.rows[0]?.balance_from_ledger);
  const currentBalance = exactBalance(user.balance);

  if (currentBalance !== balanceFromLedger) {
    const error = new NonRetryableJobError("sync_user: balance reconciliation requires review");
    error.code = "BALANCE_RECONCILIATION_REQUIRED";
    throw error;
  }

  console.log("sync_user: balance matches ledger", { user_id: userId });
}

/**
 * withdraw_payout
 *
 * Handler moved from worker.js unchanged. It is responsible for:
 * - Loading the withdraw_requests row.
 * - Skipping if already in a final state.
 * - Marking the request as paid (coins were reserved at request time).
 *
 * NOTE: The actual external payout provider integration will be added later.
 */
async function handleWithdrawPayout(client, job) {
  // Basic shape: external payout should be implemented here.
  const payload = job.payload_json || {};
  const withdrawId = Number(payload.withdraw_id || 0);

  if (!withdrawId) {
    console.warn("withdraw_payout job missing withdraw_id", payload);
    throw new NonRetryableJobError("withdraw_payout job missing withdraw_id");
  }

  const { rows } = await client.query(
    `
    SELECT id, user_id, amount, wallet, status, paid_at,
           payout_provider, payout_tx_id, payout_error
    FROM public.withdraw_requests
    WHERE id = $1
    FOR UPDATE
    `,
    [withdrawId]
  );
  if (!rows.length) {
    console.warn("withdraw_payout: withdraw request not found", { withdrawId });
    throw new NonRetryableJobError("withdraw_payout: withdraw request not found");
  }

  const wr = rows[0];

  // If already paid or rejected, nothing to do.
  if (wr.status === "paid" || wr.status === "rejected") {
    console.log("withdraw_payout: already final state, skipping", {
      id: wr.id,
      status: wr.status,
    });
    return;
  }

  if (wr.status !== "approved") {
    console.log("withdraw_payout: withdraw not approved, skipping", {
      id: wr.id,
      status: wr.status,
    });
    return;
  }

  // The provider currently throws until a real payout integration exists.
// Do not mark this request paid when provider configuration is missing.
const { provider, txId } = await sendPayout(wr);

console.log("withdraw_payout: external payout sent", {
  id: wr.id,
  user_id: wr.user_id,
  amount: wr.amount,
  wallet: wr.wallet,
  provider,
  txId,
});

// Mark as paid (coins were already reserved at request time) and store
  // provider metadata for reconciliation.
await client.query(
  `
  UPDATE public.withdraw_requests
  SET status = 'paid',
      paid_at = NOW(),
      reviewed_at = COALESCE(reviewed_at, NOW()),
      payout_provider = COALESCE($2, payout_provider),
      payout_tx_id = COALESCE($3, payout_tx_id),
      payout_error = NULL
  WHERE id = $1;
  `,
  [wr.id, provider || null, txId || null]
);
}

const handlers = {
  sync_user: handleSyncUser,
  withdraw_payout: handleWithdrawPayout,
};

async function runJobHandler(client, job) {
  const handler = handlers[job.type];
  if (!handler) {
    console.log("Unknown job type, marking completed", {
      id: job.id,
      type: job.type,
    });
    return;
  }
  await handler(client, job);
}

module.exports = {
  runJobHandler,
  NonRetryableJobError,
};
