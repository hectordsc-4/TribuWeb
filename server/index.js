require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const { initSchema, pool } = require('./db');
const paymentsRouter = require('./routes/payments');
const transactionsRouter = require('./routes/transactions');
const calendarRouter = require('./routes/calendar');
const webhooksRouter = require('./routes/webhooks');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());

// Webhook ANTES de express.json(): Stripe necesita el body en bruto para verificar la firma
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhooksRouter);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/admin', (_req, res) => {
  res.redirect('/admin/');
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'tpv-stripe', database: 'postgresql' });
  } catch (err) {
    res.status(503).json({ ok: false, service: 'tpv-stripe', database: 'error', error: err.message });
  }
});

app.use('/api/payments', paymentsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/calendar', calendarRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Error interno del servidor',
    code: err.code || undefined,
  });
});

async function start() {
  try {
    await initSchema();
    console.log('PostgreSQL conectado y esquema listo.');
  } catch (err) {
    console.error('No se pudo conectar a PostgreSQL.');
    console.error(err.message);
    console.error('Revisa DATABASE_URL en .env y que el servidor Postgres esté en marcha.');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`TPV Stripe escuchando en http://localhost:${PORT}`);
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.includes('xxxxxxxx')) {
      console.warn('⚠️  Aún no has configurado las claves de Stripe en .env');
    }
  });
}

start();
