'use strict';

/**
 * Migration 024: Add underpaidReconciliation field to payments
 *
 * Adds support for underpaid payment reconciliation tracking.
 * This field tracks partial credits and refunds for payments that are below the required fee.
 */

const mongoose = require('mongoose');

const VERSION = '024_add_underpaid_reconciliation_field';

async function up() {
  const db = mongoose.connection.db;

  // Initialize underpaidReconciliation field on all existing payments
  const result = await db.collection('payments').updateMany(
    { underpaidReconciliation: { $exists: false } },
    {
      $set: {
        underpaidReconciliation: {
          status: 'pending',
          appliedCredit: 0,
          creditAppliedAt: null,
          creditAppliedBy: null,
          refundTxHash: null,
          refundInitiatedAt: null,
          refundCompletedAt: null,
          refundNote: null,
        },
      },
    }
  );

  console.log(`[Migration 024] Added underpaidReconciliation field to ${result.modifiedCount} payments`);
}

async function down() {
  const db = mongoose.connection.db;

  const result = await db.collection('payments').updateMany(
    { underpaidReconciliation: { $exists: true } },
    { $unset: { underpaidReconciliation: '' } }
  );

  console.log(`[Migration 024] Removed underpaidReconciliation field from ${result.modifiedCount} payments`);
}

module.exports = { version: VERSION, up, down };
