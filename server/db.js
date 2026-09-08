require('dotenv').config();

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'Falta DATABASE_URL en .env (ej: postgresql://postgres:postgres@localhost:5432/tpv_stripe)'
  );
}

const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('connect', (client) => {
  client.query("SET client_encoding TO 'UTF8'");
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      stripe_payment_intent_id TEXT,
      stripe_charge_id TEXT,
      stripe_refund_id TEXT,
      type TEXT NOT NULL CHECK (type IN ('charge', 'refund')),
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'eur',
      status TEXT NOT NULL,
      description TEXT,
      customer_name TEXT,
      customer_email TEXT,
      parent_transaction_id INTEGER REFERENCES transactions(id),
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_name TEXT;

    CREATE INDEX IF NOT EXISTS idx_transactions_payment_intent
      ON transactions(stripe_payment_intent_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_type
      ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_transactions_status
      ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_created_at
      ON transactions(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_customer_name
      ON transactions (LOWER(customer_name));
    CREATE INDEX IF NOT EXISTS idx_transactions_booking_date
      ON transactions ((metadata->'booking'->>'date'));

    CREATE TABLE IF NOT EXISTS closed_days (
      id SERIAL PRIMARY KEY,
      closed_date DATE NOT NULL UNIQUE,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_closed_days_date
      ON closed_days(closed_date);
  `);

  const broken = await pool.query(`
    SELECT id, metadata
    FROM transactions
    WHERE metadata ? 'booking'
      AND metadata->'booking' ? 'date'
  `);

  for (const row of broken.rows) {
    const booking = row.metadata?.booking;
    const date = booking?.date;
    if (!date) continue;
    const weekday = new Intl.DateTimeFormat('es-ES', { weekday: 'long' }).format(
      new Date(`${date}T12:00:00`)
    );
    if (booking.weekday === weekday) continue;
    await pool.query(
      `UPDATE transactions
       SET metadata = jsonb_set(metadata, '{booking,weekday}', to_jsonb($1::text), true),
           updated_at = NOW()
       WHERE id = $2`,
      [weekday, row.id]
    );
  }
}

async function createTransaction(data) {
  const result = await pool.query(
    `INSERT INTO transactions (
      stripe_payment_intent_id,
      stripe_charge_id,
      stripe_refund_id,
      type,
      amount,
      currency,
      status,
      description,
      customer_name,
      customer_email,
      parent_transaction_id,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *`,
    [
      data.stripe_payment_intent_id ?? null,
      data.stripe_charge_id ?? null,
      data.stripe_refund_id ?? null,
      data.type,
      data.amount,
      data.currency || 'eur',
      data.status,
      data.description ?? null,
      data.customer_name ?? null,
      data.customer_email ?? null,
      data.parent_transaction_id ?? null,
      data.metadata ? JSON.stringify(data.metadata) : null,
    ]
  );

  return mapRow(result.rows[0]);
}

async function updateTransaction(id, data) {
  const fields = [];
  const values = [];
  let i = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    fields.push(`${key} = $${i++}`);
    values.push(key === 'metadata' && value !== null ? JSON.stringify(value) : value);
  }

  if (fields.length === 0) return getTransactionById(id);

  fields.push('updated_at = NOW()');
  values.push(id);

  const result = await pool.query(
    `UPDATE transactions SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );

  return mapRow(result.rows[0] || null);
}

async function updateByPaymentIntent(paymentIntentId, data) {
  const tx = await getTransactionByPaymentIntent(paymentIntentId);
  if (!tx) return null;
  return updateTransaction(tx.id, data);
}

async function getTransactionById(id) {
  const result = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
  return mapRow(result.rows[0] || null);
}

async function getTransactionByPaymentIntent(paymentIntentId) {
  const result = await pool.query(
    `SELECT * FROM transactions
     WHERE stripe_payment_intent_id = $1 AND type = 'charge'
     ORDER BY id ASC
     LIMIT 1`,
    [paymentIntentId]
  );
  return mapRow(result.rows[0] || null);
}

async function listTransactions({
  limit = 50,
  offset = 0,
  q = '',
  dateFrom = '',
  dateTo = '',
  bookingsOnly = false,
  includeCanceled = true,
} = {}) {
  const where = [];
  const params = [];
  let i = 1;

  if (bookingsOnly) {
    where.push(`type = 'charge' AND metadata ? 'booking'`);
    if (!includeCanceled) {
      where.push(`COALESCE(metadata->'booking'->>'canceled', 'false') <> 'true'`);
    }
  }

  const search = String(q || '').trim();
  if (search) {
    where.push(`(
      customer_name ILIKE $${i}
      OR customer_email ILIKE $${i}
      OR description ILIKE $${i}
      OR COALESCE(metadata->>'booking', '') ILIKE $${i}
      OR COALESCE(metadata->'booking'->>'date', '') ILIKE $${i}
      OR COALESCE(metadata->'booking'->>'contact_name', '') ILIKE $${i}
    )`);
    params.push(`%${search}%`);
    i += 1;
  }

  if (dateFrom) {
    where.push(`COALESCE(metadata->'booking'->>'date', '') >= $${i}`);
    params.push(dateFrom);
    i += 1;
  }

  if (dateTo) {
    where.push(`COALESCE(metadata->'booking'->>'date', '') <= $${i}`);
    params.push(dateTo);
    i += 1;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);

  const result = await pool.query(
    `SELECT * FROM transactions
     ${whereSql}
     ORDER BY
       COALESCE(metadata->'booking'->>'date', to_char(created_at, 'YYYY-MM-DD')) DESC,
       COALESCE(metadata->'booking'->>'time_from', '00:00') ASC,
       id DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    params
  );

  return result.rows.map(mapRow);
}

async function getOccupancy({ dateFrom, dateTo }) {
  const params = [];
  let i = 1;
  const where = [`t.type = 'charge'`, `t.metadata ? 'booking'`];

  if (dateFrom) {
    where.push(`t.metadata->'booking'->>'date' >= $${i}`);
    params.push(dateFrom);
    i += 1;
  }
  if (dateTo) {
    where.push(`t.metadata->'booking'->>'date' <= $${i}`);
    params.push(dateTo);
    i += 1;
  }

  const result = await pool.query(
    `SELECT
       t.id,
       t.customer_name,
       t.customer_email,
       t.amount,
       t.currency,
       t.status,
       t.metadata,
       t.created_at,
       t.stripe_payment_intent_id
     FROM transactions t
     WHERE ${where.join(' AND ')}
     ORDER BY t.metadata->'booking'->>'date' ASC,
              t.metadata->'booking'->>'time_from' ASC,
              t.id ASC`,
    params
  );

  const reservations = result.rows.map(mapRow);
  const byDayMap = new Map();
  const byHourByDay = new Map();

  for (const tx of reservations) {
    const booking = tx.metadata?.booking || {};
    if (booking.canceled === true || tx.status !== 'succeeded') continue;

    const date = booking.date;
    const plazas = Number(booking.plazas) || 0;
    if (!date || plazas < 1) continue;

    byDayMap.set(date, (byDayMap.get(date) || 0) + plazas);

    if (!byHourByDay.has(date)) {
      byHourByDay.set(date, Array.from({ length: 24 }, () => 0));
    }
    const hours = byHourByDay.get(date);
    const from = parseHour(booking.time_from);
    const to = parseHour(booking.time_to);
    if (from == null || to == null) continue;
    for (let h = from; h < to; h += 1) {
      hours[h] += plazas;
    }
  }

  const byDay = [...byDayMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, people]) => ({ date, people }));

  const byHour = {};
  for (const [date, hours] of byHourByDay.entries()) {
    byHour[date] = hours.map((people, hour) => ({ hour, people }));
  }

  const totalPeople = byDay.reduce((sum, d) => sum + d.people, 0);

  return {
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    totalPeople,
    byDay,
    byHour,
    reservations,
  };
}

function parseHour(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour < 0 || hour > 23) return null;
  return hour;
}

async function cancelReservation(transactionId) {
  const tx = await getTransactionById(transactionId);
  if (!tx || tx.type !== 'charge' || !tx.metadata?.booking) {
    const err = new Error('Reserva no encontrada.');
    err.status = 404;
    throw err;
  }
  if (tx.metadata.booking.canceled === true) {
    const err = new Error('Esta reserva ya está cancelada.');
    err.status = 400;
    throw err;
  }

  const metadata = {
    ...tx.metadata,
    booking: {
      ...tx.metadata.booking,
      canceled: true,
      canceled_at: new Date().toISOString(),
    },
  };

  return updateTransaction(tx.id, {
    metadata,
    status: tx.status === 'succeeded' ? 'canceled_booking' : tx.status,
  });
}

async function getRefundableAmount(chargeTransactionId) {
  const charge = await getTransactionById(chargeTransactionId);
  if (!charge || charge.type !== 'charge') {
    return 0;
  }

  if (!['succeeded', 'canceled_booking'].includes(charge.status)) {
    return 0;
  }

  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::INT AS total
     FROM transactions
     WHERE parent_transaction_id = $1
       AND type = 'refund'
       AND status IN ('succeeded', 'pending')`,
    [chargeTransactionId]
  );

  return Math.max(0, charge.amount - Number(result.rows[0].total || 0));
}

function mapRow(row) {
  if (!row) return null;
  return {
    ...row,
    metadata:
      row.metadata == null
        ? null
        : typeof row.metadata === 'string'
          ? JSON.parse(row.metadata)
          : row.metadata,
  };
}

function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const str = String(value);
  return str.slice(0, 10);
}

function mapClosedDay(row) {
  if (!row) return null;
  return {
    id: row.id,
    closed_date: toDateOnly(row.closed_date),
    reason: row.reason || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listClosedDays({ dateFrom = '', dateTo = '' } = {}) {
  const where = [];
  const params = [];
  let i = 1;

  if (dateFrom) {
    where.push(`closed_date >= $${i++}`);
    params.push(dateFrom);
  }
  if (dateTo) {
    where.push(`closed_date <= $${i++}`);
    params.push(dateTo);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT id,
            to_char(closed_date, 'YYYY-MM-DD') AS closed_date,
            reason,
            created_at,
            updated_at
     FROM closed_days
     ${whereSql}
     ORDER BY closed_date ASC`,
    params
  );
  return result.rows.map(mapClosedDay);
}

async function getClosedDay(date) {
  const result = await pool.query(
    `SELECT id,
            to_char(closed_date, 'YYYY-MM-DD') AS closed_date,
            reason,
            created_at,
            updated_at
     FROM closed_days
     WHERE closed_date = $1::date
     LIMIT 1`,
    [date]
  );
  return mapClosedDay(result.rows[0] || null);
}

async function isClosedDay(date) {
  const row = await getClosedDay(date);
  return Boolean(row);
}

async function upsertClosedDay({ closedDate, reason = null }) {
  const result = await pool.query(
    `INSERT INTO closed_days (closed_date, reason)
     VALUES ($1::date, $2)
     ON CONFLICT (closed_date)
     DO UPDATE SET
       reason = EXCLUDED.reason,
       updated_at = NOW()
     RETURNING id,
               to_char(closed_date, 'YYYY-MM-DD') AS closed_date,
               reason,
               created_at,
               updated_at`,
    [closedDate, reason || null]
  );
  return mapClosedDay(result.rows[0]);
}

async function deleteClosedDay(date) {
  const result = await pool.query(
    `DELETE FROM closed_days
     WHERE closed_date = $1::date
     RETURNING id,
               to_char(closed_date, 'YYYY-MM-DD') AS closed_date,
               reason,
               created_at,
               updated_at`,
    [date]
  );
  return mapClosedDay(result.rows[0] || null);
}

async function toggleClosedDay({ closedDate, reason = null }) {
  const existing = await getClosedDay(closedDate);
  if (existing) {
    await deleteClosedDay(closedDate);
    return { closed: false, day: null };
  }
  const day = await upsertClosedDay({ closedDate, reason });
  return { closed: true, day };
}

module.exports = {
  pool,
  initSchema,
  createTransaction,
  updateTransaction,
  updateByPaymentIntent,
  getTransactionById,
  getTransactionByPaymentIntent,
  listTransactions,
  getOccupancy,
  cancelReservation,
  getRefundableAmount,
  listClosedDays,
  getClosedDay,
  isClosedDay,
  upsertClosedDay,
  deleteClosedDay,
  toggleClosedDay,
};
