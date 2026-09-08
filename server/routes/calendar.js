const express = require('express');
const {
  listClosedDays,
  getClosedDay,
  upsertClosedDay,
  deleteClosedDay,
  toggleClosedDay,
} = require('../db');

const router = express.Router();

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

router.get('/closed-days', async (req, res, next) => {
  try {
    const dateFrom = String(req.query.date_from || req.query.from || '').trim();
    const dateTo = String(req.query.date_to || req.query.to || '').trim();

    if (dateFrom && !isDate(dateFrom)) {
      return res.status(400).json({ error: 'date_from debe ser YYYY-MM-DD.' });
    }
    if (dateTo && !isDate(dateTo)) {
      return res.status(400).json({ error: 'date_to debe ser YYYY-MM-DD.' });
    }

    const closedDays = await listClosedDays({ dateFrom, dateTo });
    res.json({ closedDays });
  } catch (err) {
    next(err);
  }
});

router.get('/closed-days/:date', async (req, res, next) => {
  try {
    const date = String(req.params.date || '').trim();
    if (!isDate(date)) {
      return res.status(400).json({ error: 'La fecha debe ser YYYY-MM-DD.' });
    }
    const day = await getClosedDay(date);
    res.json({ closed: Boolean(day), day });
  } catch (err) {
    next(err);
  }
});

router.post('/closed-days', async (req, res, next) => {
  try {
    const closedDate = String(req.body.closedDate || req.body.date || '').trim();
    const reason = String(req.body.reason || '').trim() || null;

    if (!isDate(closedDate)) {
      return res.status(400).json({ error: 'Indica una fecha válida (YYYY-MM-DD).' });
    }

    const day = await upsertClosedDay({ closedDate, reason });
    res.status(201).json({ day });
  } catch (err) {
    next(err);
  }
});

router.post('/closed-days/toggle', async (req, res, next) => {
  try {
    const closedDate = String(req.body.closedDate || req.body.date || '').trim();
    const reason = String(req.body.reason || '').trim() || null;

    if (!isDate(closedDate)) {
      return res.status(400).json({ error: 'Indica una fecha válida (YYYY-MM-DD).' });
    }

    const result = await toggleClosedDay({ closedDate, reason });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/closed-days/:date', async (req, res, next) => {
  try {
    const date = String(req.params.date || '').trim();
    if (!isDate(date)) {
      return res.status(400).json({ error: 'La fecha debe ser YYYY-MM-DD.' });
    }
    const day = await deleteClosedDay(date);
    if (!day) {
      return res.status(404).json({ error: 'Ese día no estaba marcado como cerrado.' });
    }
    res.json({ day });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
