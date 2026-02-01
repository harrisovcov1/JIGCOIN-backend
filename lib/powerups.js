// lib/powerups.js
// Centralised helpers for user power-ups (consumables / entitlements).

/**
 * Insert a power-up record (idempotent on provider+provider_payment_id).
 *
 * Schema expectations (public.user_powerups):
 *   id uuid primary key default gen_random_uuid()
 *   user_id uuid not null
 *   powerup_code text not null
 *   pack_sku text
 *   provider text
 *   provider_payment_id text
 *   status text not null default 'active'
 *   quantity int not null default 1
 *   metadata jsonb not null default '{}'
 *   expires_at timestamptz
 *   consumed_at timestamptz
 *   created_at timestamptz not null default now()
 *   updated_at timestamptz not null default now()
 */

async function addPowerup(client, {
  userId,
  powerupCode,
  packSku = null,
  provider = null,
  providerPaymentId = null,
  status = 'active',
  quantity = 1,
  metadata = {},
  expiresAt = null,
  consumedAt = null,
}) {
  const q = `
    insert into public.user_powerups
      (user_id, powerup_code, pack_sku, provider, provider_payment_id, status, quantity, metadata, expires_at, consumed_at)
    values
      ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
    on conflict (provider, provider_payment_id)
    do nothing
    returning *;
  `;

  const res = await client.query(q, [
    userId,
    powerupCode,
    packSku,
    provider,
    providerPaymentId,
    status,
    quantity,
    JSON.stringify(metadata ?? {}),
    expiresAt,
    consumedAt,
  ]);

  return res.rows[0] || null;
}

// Cache the column type so we can tolerate schema drift (uuid vs bigint).
let _userIdColumnUdtName = null;

async function getUserIdColumnUdtName(client) {
  if (_userIdColumnUdtName) return _userIdColumnUdtName;
  try {
    const r = await client.query(
      `
      select udt_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'user_powerups'
        and column_name = 'user_id'
      limit 1;
      `
    );
    _userIdColumnUdtName = r.rows?.[0]?.udt_name || 'unknown';
  } catch {
    _userIdColumnUdtName = 'unknown';
  }
  return _userIdColumnUdtName;
}

function looksLikeUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function getActivePowerupsForUser(client, userId) {
  // IMPORTANT: We never want powerups to take down /api/state. If there's a schema mismatch,
  // we log and return an empty list so the app still loads.
  try {
    const udt = await getUserIdColumnUdtName(client);

    // If the column is uuid but the incoming id isn't, we can't match — return none without throwing.
    if (udt === 'uuid' && !looksLikeUuid(String(userId))) {
      return [];
    }

    // If the column is bigint but the incoming id isn't numeric, we can't match — return none.
    if ((udt === 'int8' || udt === 'bigint') && isNaN(Number(userId))) {
      return [];
    }

    const q = `
      select *
      from public.user_powerups
      where user_id = $1
        and status = 'active'
        and (expires_at is null or expires_at > now())
      order by created_at desc;
    `;

    const res = await client.query(q, [userId]);
    return res.rows;
  } catch (e) {
    console.error('[powerups] getActivePowerupsForUser failed (non-fatal):', e?.message || e);
    return [];
  }
}

function isExpiredRow(r) {
  if (!r) return true;
  if (!r.expires_at) return false;
  const t = Date.parse(r.expires_at);
  return Number.isFinite(t) ? t <= Date.now() : false;
}

async function getActivePowerupsForUserByCode(client, userId, powerupCode) {
  try {
    const udt = await getUserIdColumnUdtName(client);

    if (udt === 'uuid' && !looksLikeUuid(String(userId))) return [];
    if ((udt === 'int8' || udt === 'bigint') && isNaN(Number(userId))) return [];

    const q = `
      select *
      from public.user_powerups
      where user_id = $1
        and powerup_code = $2
        and status = 'active'
        and (expires_at is null or expires_at > now())
      order by created_at asc;
    `;
    const res = await client.query(q, [userId, String(powerupCode)]);
    return res.rows;
  } catch (e) {
    console.error('[powerups] getActivePowerupsForUserByCode failed (non-fatal):', e?.message || e);
    return [];
  }
}

// Consume 1 unit from a powerup row.
// - If quantity > 1: decrement quantity
// - Else: mark consumed
async function consumePowerupUnitById(client, powerupId) {
  const q = `
    update public.user_powerups
    set
      quantity = case when quantity > 1 then quantity - 1 else quantity end,
      status = case when quantity > 1 then status else 'consumed' end,
      consumed_at = case when quantity > 1 then consumed_at else now() end,
      updated_at = now()
    where id = $1
      and status = 'active'
      and (expires_at is null or expires_at > now())
    returning *;
  `;
  const res = await client.query(q, [powerupId]);
  return res.rows[0] || null;
}

async function consumePowerupById(client, powerupId) {
  // Backwards-compatible alias for single-use powerups.
  return consumePowerupUnitById(client, powerupId);
}

module.exports = {
  addPowerup,
  getActivePowerupsForUser,
  getActivePowerupsForUserByCode,
  consumePowerupUnitById,
  consumePowerupById,
};
