'use strict';

const Refund = require('../models/refundModel');
const Payment = require('../models/paymentModel');
const Outbox = require('../models/outboxModel');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger').child('RefundService');
const { amountsEqual } = require('../utils/stellarAmount');
const lock = require('./distributedLock');

// TTL for the per-payment refund lock. Long enough for the DB operations to
// complete; short enough to auto-expire after a crash without blocking permanently.
const REFUND_LOCK_TTL_MS = 30_000;

// Statuses that represent an active (non-failed) refund. A payment that already
// has one of these is not eligible for a new refund request.
const ACTIVE_REFUND_STATUSES = ['approval_pending', 'pending', 'submitted', 'confirmed'];

/**
 * Return a deterministic Redis key for a given payment refund operation.
 * @param {string} schoolId
 * @param {string} originalTxHash
 */
function refundLockKey(schoolId, originalTxHash) {
  return `refund:lock:${schoolId}:${originalTxHash}`;
}

async function initiateRefund(schoolId, originalTxHash, studentId, amount, reason, initiatedBy) {
  const lockKey = refundLockKey(schoolId, originalTxHash);
  const acquired = await lock.acquire(lockKey, REFUND_LOCK_TTL_MS);
  if (!acquired) {
    const err = new Error('A refund for this payment is already being processed. Please try again shortly.');
    err.code = 'REFUND_LOCK_CONTENDED';
    throw err;
  }

  const { token } = acquired;
  try {
    const payment = await Payment.findOne({ schoolId, txHash: originalTxHash, status: 'SUCCESS' });
    if (!payment) {
      const err = new Error('Original payment not found or not in SUCCESS status');
      err.code = 'PAYMENT_NOT_FOUND';
      throw err;
    }

    if (!amountsEqual(amount, payment.amount)) {
      const err = new Error('Refund amount does not match original payment amount');
      err.code = 'AMOUNT_MISMATCH';
      throw err;
    }

    // Guard: reject if an active (non-failed) refund already exists for this payment.
    const existingRefund = await Refund.findOne({
      schoolId,
      originalTxHash,
      status: { $in: ACTIVE_REFUND_STATUSES },
    });
    if (existingRefund) {
      const err = new Error(`A refund for this payment already exists (status: ${existingRefund.status}, id: ${existingRefund._id})`);
      err.code = 'REFUND_ALREADY_EXISTS';
      err.refundId = existingRefund._id.toString();
      throw err;
    }

    const refund = await Refund.create({
      schoolId,
      originalTxHash,
      studentId,
      amount,
      status: 'approval_pending',
      reason,
      initiatedBy,
    });

    // Update payment status to REFUNDED to reflect the in-flight refund.
    // Uses adminOverride to allow the SUCCESS → REFUNDED transition via the proper
    // .save() path (mirroring how dispute resolution handles payment status sync).
    payment.$locals.adminOverride = true;
    payment.status = 'REFUNDED';
    await payment.save();

    const eventId = uuidv4();
    await Outbox.create({
      eventId,
      eventType: 'refund.initiated',
      aggregateId: originalTxHash,
      aggregateType: 'payment',
      payload: {
        refundId: refund._id.toString(),
        schoolId,
        originalTxHash,
        studentId,
        amount,
        reason,
        initiatedBy,
      },
    });

    logger.info('Refund initiated', { schoolId, originalTxHash, studentId, refundId: refund._id });
    return refund;
  } finally {
    await lock.release(lockKey, token);
  }
}

async function approveRefund(refundId, approvedBy) {
  const refund = await Refund.findById(refundId);
  if (!refund) {
    const err = new Error('Refund not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (refund.status !== 'approval_pending') {
    const err = new Error(`Cannot approve refund in ${refund.status} status`);
    err.code = 'INVALID_STATE';
    throw err;
  }

  if (refund.initiatedBy === approvedBy) {
    const err = new Error('Approval must be by a different operator than the one who initiated the refund');
    err.code = 'SELF_APPROVAL_NOT_ALLOWED';
    throw err;
  }

  const previousStatus = refund.status;
  refund.status = 'pending';
  refund.approvedBy = approvedBy;
  refund.approvedAt = new Date();

  const updated = await refund.save();

  const eventId = uuidv4();
  await Outbox.create({
    eventId,
    eventType: 'refund.approved',
    aggregateId: refund.originalTxHash,
    aggregateType: 'payment',
    payload: {
      refundId: refund._id.toString(),
      schoolId: refund.schoolId,
      originalTxHash: refund.originalTxHash,
      initiatedBy: refund.initiatedBy,
      approvedBy,
      amount: refund.amount,
    },
  });

  logger.info('Refund approved', {
    schoolId: refund.schoolId,
    originalTxHash: refund.originalTxHash,
    refundId: refund._id,
    initiatedBy: refund.initiatedBy,
    approvedBy,
  });

  return updated;
}

async function updateRefundStatus(refundId, newStatus, txHash = null, failureReason = null) {
  const refund = await Refund.findById(refundId);
  if (!refund) {
    const err = new Error('Refund not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const previousStatus = refund.status;
  refund.status = newStatus;

  if (newStatus === 'confirmed' && txHash) {
    refund.refundTxHash = txHash;
    refund.confirmedAt = new Date();
  } else if (newStatus === 'failed' && failureReason) {
    refund.failureReason = failureReason;
    refund.failedAt = new Date();
  }

  const updated = await refund.save();

  const eventId = uuidv4();
  await Outbox.create({
    eventId,
    eventType: 'refund.status_changed',
    aggregateId: refund.originalTxHash,
    aggregateType: 'payment',
    payload: {
      refundId: refund._id.toString(),
      schoolId: refund.schoolId,
      originalTxHash: refund.originalTxHash,
      previousStatus,
      newStatus,
      refundTxHash: refund.refundTxHash,
      failureReason,
    },
  });

  logger.info('Refund status updated', {
    schoolId: refund.schoolId,
    originalTxHash: refund.originalTxHash,
    refundId: refund._id,
    previousStatus,
    newStatus,
  });

  return updated;
}

async function getRefundsByPayment(schoolId, originalTxHash) {
  return Refund.find({ schoolId, originalTxHash }).sort({ createdAt: -1 }).lean();
}

async function getRefundsBySchool(schoolId, status = null) {
  const query = { schoolId };
  if (status) query.status = status;
  return Refund.find(query).sort({ createdAt: -1 }).lean();
}

module.exports = {
  initiateRefund,
  approveRefund,
  updateRefundStatus,
  getRefundsByPayment,
  getRefundsBySchool,
  refundLockKey,
  ACTIVE_REFUND_STATUSES,
};
