// lib/payoutProvider.js
//
// Abstraction over external payout providers for withdrawals.
//
// The goal of this module is to give a single place to plug in TON/USDT or
// any other payout rail without touching business logic in job handlers.
//
// Interface:
//   async sendPayout(withdrawRow) -> { provider, txId }
//
// - `withdrawRow` is the row from public.withdraw_requests.
// - `provider` is a short identifier (e.g. 'ton', 'tron', 'manual').
// - `txId` is the provider's transaction id / hash, or null if not available.
//
// IMPORTANT:
// No payout provider is implemented. Fail closed until an actual, reconciled
// provider integration exists. A placeholder must never be recorded as payment.

const PROVIDER = (process.env.WITHDRAW_PROVIDER || "manual").toLowerCase();

async function sendPayout(withdraw) {
  const error = new Error("No payout provider is configured; no payment was sent.");
  error.code = "PAYOUT_PROVIDER_NOT_CONFIGURED";
  error.permanent = true;
  error.provider = PROVIDER;
  throw error;
}

module.exports = {
  sendPayout,
};
