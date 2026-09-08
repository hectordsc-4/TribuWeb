const express = require('express');
const Stripe = require('stripe');
const {
  getTransactionByPaymentIntent,
  updateTransaction,
  createTransaction,
} = require('../db');

const router = express.Router();

/**
 * Webhook de Stripe. Actualiza estados sin almacenar datos de tarjeta.
 * El body debe llegar en bruto (express.raw) — se monta así en index.js.
 */
router.post('/', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers['stripe-signature'];

  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.includes('xxxxxxxx')) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY no configurada.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;

  try {
    if (secret && !secret.includes('xxxxxxxx') && signature) {
      event = stripe.webhooks.constructEvent(req.body, signature, secret);
    } else {
      event = typeof req.body === 'string' || Buffer.isBuffer(req.body)
        ? JSON.parse(req.body.toString())
        : req.body;
      console.warn('[webhook] Firma no verificada (configura STRIPE_WEBHOOK_SECRET en producción).');
    }
  } catch (err) {
    console.error('[webhook] Firma inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        const pi = event.data.object;
        const chargeId =
          typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id || null;

        const tx = await getTransactionByPaymentIntent(pi.id);
        if (tx) {
          await updateTransaction(tx.id, {
            status: pi.status,
            stripe_charge_id: chargeId,
          });
        } else {
          await createTransaction({
            stripe_payment_intent_id: pi.id,
            stripe_charge_id: chargeId,
            type: 'charge',
            amount: pi.amount,
            currency: pi.currency,
            status: pi.status,
            description: pi.description,
            customer_email: pi.receipt_email,
            metadata: { via: 'webhook' },
          });
        }
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object;
        console.log(`[webhook] charge.refunded ${charge.id} amount_refunded=${charge.amount_refunded}`);
        break;
      }
      default:
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] Error procesando evento:', err);
    res.status(500).json({ error: 'Error procesando webhook.' });
  }
});

module.exports = router;
