const express = require('express');
const Stripe = require('stripe');
const {
  createTransaction,
  updateTransaction,
  getTransactionById,
  getTransactionByPaymentIntent,
  getRefundableAmount,
  getClosedDay,
} = require('../db');

const router = express.Router();

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.includes('xxxxxxxx')) {
    const err = new Error(
      'Configura STRIPE_SECRET_KEY en el archivo .env con tu clave secreta de prueba.'
    );
    err.status = 500;
    throw err;
  }
  return new Stripe(key);
}

/**
 * Crea un PaymentIntent. Los datos de tarjeta NUNCA llegan a este servidor:
 * el cliente los introduce en Stripe Elements / Payment Element.
 */
function weekdayFromDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('es-ES', { weekday: 'long' }).format(d);
}

function normalizeBooking(booking) {
  if (!booking || typeof booking !== 'object') return null;

  const plazas = Number(booking.plazas);
  const date = String(booking.date || '');
  const timeFrom = String(booking.time_from || booking.timeFrom || '');
  const timeTo = String(booking.time_to || booking.timeTo || '');
  const contactName = String(
    booking.contact_name || booking.contactName || booking.customer_name || booking.customerName || ''
  ).trim();
  const email = String(booking.email || booking.customer_email || booking.customerEmail || '').trim();
  const pricePerPlazaCents = Number(
    booking.price_per_plaza_cents ?? booking.pricePerPlazaCents ?? 0
  );

  if (!contactName) {
    const err = new Error('Indica el nombre de contacto de la reserva.');
    err.status = 400;
    throw err;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error('Indica un email de contacto válido.');
    err.status = 400;
    throw err;
  }
  if (!Number.isInteger(plazas) || plazas < 1) {
    const err = new Error('La reserva debe indicar un número válido de plazas.');
    err.status = 400;
    throw err;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const err = new Error('La fecha de reserva no es válida (YYYY-MM-DD).');
    err.status = 400;
    throw err;
  }
  if (!/^\d{2}:\d{2}$/.test(timeFrom) || !/^\d{2}:\d{2}$/.test(timeTo) || timeFrom >= timeTo) {
    const err = new Error('La franja horaria no es válida (ej. 10:00–12:00).');
    err.status = 400;
    throw err;
  }

  const weekday = weekdayFromDate(date);

  return {
    product: 'chiquipark',
    plazas,
    price_per_plaza_cents: Number.isInteger(pricePerPlazaCents) ? pricePerPlazaCents : null,
    date,
    weekday,
    time_from: timeFrom,
    time_to: timeTo,
    contact_name: contactName,
    customer_name: contactName,
    email,
    canceled: false,
  };
}

router.post('/create-payment-intent', async (req, res, next) => {
  try {
    const stripe = getStripe();
    const {
      amount,
      currency = 'eur',
      description,
      customerEmail,
      customerName,
      booking,
    } = req.body;

    const cents = Number(amount);
    if (!Number.isInteger(cents) || cents < 50) {
      return res.status(400).json({
        error: 'El importe debe ser un entero en céntimos (mínimo 50 = 0,50 EUR).',
      });
    }

    const name = String(
      customerName ||
        booking?.contact_name ||
        booking?.contactName ||
        booking?.customer_name ||
        booking?.customerName ||
        ''
    ).trim();
    const email = String(customerEmail || booking?.email || booking?.customer_email || '').trim();

    const bookingData = normalizeBooking({
      ...(booking || {}),
      contact_name: name,
      email,
    });

    const closed = await getClosedDay(bookingData.date);
    if (closed) {
      return res.status(400).json({
        error: `Tribu está cerrado el ${bookingData.date}${
          closed.reason ? ` (${closed.reason})` : ''
        }. Elige otro día.`,
        code: 'CLOSED_DAY',
      });
    }

    const finalDescription =
      description ||
      (bookingData
        ? `Tribu · ${bookingData.contact_name} · ${bookingData.plazas} plazas · ${bookingData.weekday} ${bookingData.date} · ${bookingData.time_from}–${bookingData.time_to}`
        : undefined);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: cents,
      currency: String(currency).toLowerCase(),
      description: finalDescription,
      receipt_email: bookingData.email,
      automatic_payment_methods: { enabled: true },
      metadata: {
        source: 'tpv-tribu',
        product: bookingData?.product || 'generic',
        customer_name: bookingData.contact_name.slice(0, 40),
        contact_name: bookingData.contact_name.slice(0, 40),
        email: bookingData.email.slice(0, 80),
        plazas: bookingData ? String(bookingData.plazas) : '',
        date: bookingData?.date || '',
        time_from: bookingData?.time_from || '',
        time_to: bookingData?.time_to || '',
        weekday: bookingData?.weekday || '',
      },
    });

    const transaction = await createTransaction({
      stripe_payment_intent_id: paymentIntent.id,
      type: 'charge',
      amount: cents,
      currency: paymentIntent.currency,
      status: paymentIntent.status,
      description: finalDescription || null,
      customer_name: bookingData.contact_name,
      customer_email: bookingData.email,
      metadata: {
        booking: bookingData,
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      transaction,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Confirma en BD el estado tras el pago en el cliente (complementa el webhook).
 */
router.post('/confirm-payment', async (req, res, next) => {
  try {
    const stripe = getStripe();
    const { paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'Falta paymentIntentId.' });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    let transaction = await getTransactionByPaymentIntent(paymentIntentId);

    const chargeId =
      typeof paymentIntent.latest_charge === 'string'
        ? paymentIntent.latest_charge
        : paymentIntent.latest_charge?.id || null;

    if (transaction) {
      transaction = await updateTransaction(transaction.id, {
        status: paymentIntent.status,
        stripe_charge_id: chargeId,
      });
    } else {
      transaction = await createTransaction({
        stripe_payment_intent_id: paymentIntent.id,
        stripe_charge_id: chargeId,
        type: 'charge',
        amount: paymentIntent.amount,
        currency: paymentIntent.currency,
        status: paymentIntent.status,
        description: paymentIntent.description,
        customer_email: paymentIntent.receipt_email,
      });
    }

    res.json({ transaction, paymentIntent: { id: paymentIntent.id, status: paymentIntent.status } });
  } catch (err) {
    next(err);
  }
});

/**
 * Devolución total o parcial. Stripe gestiona el dinero; nosotros solo registramos el resultado.
 */
router.post('/refund', async (req, res, next) => {
  try {
    const stripe = getStripe();
    const { transactionId, amount, reason } = req.body;

    const chargeTx = await getTransactionById(Number(transactionId));
    if (!chargeTx || chargeTx.type !== 'charge') {
      return res.status(404).json({ error: 'Transacción de cargo no encontrada.' });
    }

    if (!['succeeded', 'canceled_booking'].includes(chargeTx.status)) {
      return res.status(400).json({
        error: 'Solo se pueden devolver cargos cobrados o reservas canceladas con pago.',
      });
    }

    if (!chargeTx.stripe_payment_intent_id && !chargeTx.stripe_charge_id) {
      return res.status(400).json({ error: 'La transacción no tiene referencia de Stripe.' });
    }

    const refundable = await getRefundableAmount(chargeTx.id);
    if (refundable <= 0) {
      return res.status(400).json({ error: 'Este cargo ya está totalmente devuelto.' });
    }

    let refundCents = refundable;
    if (amount !== undefined && amount !== null && amount !== '') {
      refundCents = Number(amount);
      if (!Number.isInteger(refundCents) || refundCents < 1) {
        return res.status(400).json({ error: 'El importe de devolución debe ser un entero en céntimos.' });
      }
      if (refundCents > refundable) {
        return res.status(400).json({
          error: `La devolución máxima disponible es ${refundable} céntimos.`,
        });
      }
    }

    const refundParams = {
      amount: refundCents,
      reason: reason || undefined,
      metadata: {
        local_transaction_id: String(chargeTx.id),
      },
    };

    if (chargeTx.stripe_payment_intent_id) {
      refundParams.payment_intent = chargeTx.stripe_payment_intent_id;
    } else {
      refundParams.charge = chargeTx.stripe_charge_id;
    }

    const refund = await stripe.refunds.create(refundParams);

    const refundTx = await createTransaction({
      stripe_payment_intent_id: chargeTx.stripe_payment_intent_id,
      stripe_charge_id: typeof refund.charge === 'string' ? refund.charge : chargeTx.stripe_charge_id,
      stripe_refund_id: refund.id,
      type: 'refund',
      amount: refund.amount,
      currency: refund.currency,
      status: refund.status === 'succeeded' ? 'succeeded' : refund.status,
      description: `Devolución de #${chargeTx.id}${reason ? `: ${reason}` : ''}`,
      customer_name: chargeTx.customer_name,
      customer_email: chargeTx.customer_email,
      parent_transaction_id: chargeTx.id,
      metadata: { reason: reason || null },
    });

    res.json({
      refund: { id: refund.id, status: refund.status, amount: refund.amount },
      transaction: refundTx,
      remainingRefundable: await getRefundableAmount(chargeTx.id),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/config', (_req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    configured: Boolean(
      process.env.STRIPE_SECRET_KEY &&
        !process.env.STRIPE_SECRET_KEY.includes('xxxxxxxx') &&
        process.env.STRIPE_PUBLISHABLE_KEY &&
        !process.env.STRIPE_PUBLISHABLE_KEY.includes('xxxxxxxx')
    ),
  });
});

module.exports = router;
