'use strict';

/**
 * InboundWebhookNonce — lightweight replay-protection store for inbound webhooks.
 *
 * Each document records a delivery ID that has already been processed.
 * Documents are auto-expired after WEBHOOK_NONCE_TTL_SECONDS (default: 24 hours)
 * which exceeds the timestamp-skew tolerance (5 min) by a large margin, ensuring
 * that any delivery replayed within the tolerance window is correctly rejected.
 *
 * A unique index on `deliveryId` guarantees that concurrent upserts produce a
 * duplicate-key error (11000), which the validateInboundWebhook middleware uses
 * to return a 409 response.
 *
 * This model is intentionally separate from WebhookDelivery (the outbound
 * delivery log).  Inbound replay protection only needs a nonce store; there is
 * no need to satisfy the outbound delivery schema's required fields.
 */

const mongoose = require('mongoose');

const TTL_SECONDS = parseInt(process.env.WEBHOOK_NONCE_TTL_SECONDS, 10) || 86_400; // 24 h

const inboundWebhookNonceSchema = new mongoose.Schema(
  {
    deliveryId: {
      type: String,
      required: true,
      unique: true,   // produces 11000 on duplicate insert
      index: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    // No timestamps — receivedAt is the only time field needed.
    timestamps: false,
    // Minimal collection footprint.
    collection: 'inbound_webhook_nonces',
  }
);

// TTL index — MongoDB automatically removes nonces after the window expires.
inboundWebhookNonceSchema.index({ receivedAt: 1 }, { expireAfterSeconds: TTL_SECONDS });

module.exports = mongoose.model('InboundWebhookNonce', inboundWebhookNonceSchema);
