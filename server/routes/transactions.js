const express = require('express');
const {
  listTransactions,
  getTransactionById,
  getRefundableAmount,
  getOccupancy,
  cancelReservation,
} = require('../db');

const router = express.Router();

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const q = String(req.query.q || '').trim();
    const dateFrom = String(req.query.date_from || req.query.from || '').trim();
    const dateTo = String(req.query.date_to || req.query.to || '').trim();
    const bookingsOnly =
      String(req.query.bookings_only || '').toLowerCase() === 'true' ||
      String(req.query.bookings_only || '') === '1';
    const includeCanceled = String(req.query.include_canceled || 'true').toLowerCase() !== 'false';

    if (dateFrom && !isDate(dateFrom)) {
      return res.status(400).json({ error: 'date_from debe ser YYYY-MM-DD.' });
    }
    if (dateTo && !isDate(dateTo)) {
      return res.status(400).json({ error: 'date_to debe ser YYYY-MM-DD.' });
    }

    const rows = await listTransactions({
      limit,
      offset,
      q,
      dateFrom,
      dateTo,
      bookingsOnly,
      includeCanceled,
    });
    const transactions = await Promise.all(
      rows.map(async (tx) => ({
        ...tx,
        refundable_amount:
          tx.type === 'charge' && ['succeeded', 'canceled_booking'].includes(tx.status)
            ? await getRefundableAmount(tx.id)
            : 0,
      }))
    );
    res.json({ transactions });
  } catch (err) {
    next(err);
  }
});

router.get('/occupancy', async (req, res, next) => {
  try {
    const dateFrom = String(req.query.date_from || req.query.from || '').trim();
    const dateTo = String(req.query.date_to || req.query.to || '').trim();

    if (dateFrom && !isDate(dateFrom)) {
      return res.status(400).json({ error: 'date_from debe ser YYYY-MM-DD.' });
    }
    if (dateTo && !isDate(dateTo)) {
      return res.status(400).json({ error: 'date_to debe ser YYYY-MM-DD.' });
    }

    const occupancy = await getOccupancy({ dateFrom, dateTo });
    const reservations = await Promise.all(
      occupancy.reservations.map(async (tx) => ({
        ...tx,
        refundable_amount: await getRefundableAmount(tx.id),
      }))
    );

    res.json({
      ...occupancy,
      reservations,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    const transaction = await cancelReservation(Number(req.params.id));
    res.json({
      transaction: {
        ...transaction,
        refundable_amount: await getRefundableAmount(transaction.id),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const tx = await getTransactionById(Number(req.params.id));
    if (!tx) {
      return res.status(404).json({ error: 'Transacción no encontrada.' });
    }
    res.json({
      transaction: {
        ...tx,
        refundable_amount:
          tx.type === 'charge' && ['succeeded', 'canceled_booking'].includes(tx.status)
            ? await getRefundableAmount(tx.id)
            : 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
