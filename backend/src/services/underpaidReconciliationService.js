'use strict';

/**
 * Underpaid Payment Reconciliation Service (Issue #1039)
 *
 * Handles reconciliation of partial/underpaid payments through:
 * - Automatic partial credit tracking for underpaid transactions
 * - Refund mechanism for payments that need to be returned
 * - Documentation and audit trail of all reconciliation actions
 */

const mongoose = require('mongoose');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const logger = require('../utils/logger');
const lock = require('./distributedLock');

// Shares the same TTL convention as the other callers of the per-student
// balance lock (paymentController.verifyPayment, stellarService.syncPaymentsForSchool).
const STUDENT_BALANCE_LOCK_TTL_MS = parseInt(process.env.STUDENT_BALANCE_LOCK_TTL_MS || '15000', 10);

/**
 * Apply partial credit to an underpaid payment
 * @param {string} paymentId - Payment document ID or txHash
 * @param {number} creditAmount - Amount to credit toward student balance
 * @param {string} creditAppliedBy - User/admin applying the credit
 * @param {string} schoolId - School ID for tenant scope
 * @returns {Promise<object>} Updated payment document
 */
async function applyPartialCredit(paymentId, creditAmount, creditAppliedBy, schoolId) {
  if (!creditAmount || creditAmount <= 0) {
    throw new Error('creditAmount must be a positive number');
  }

  // Find payment by ID or txHash.
  // Guard with isValid() first: passing a non-ObjectId string (e.g. a 64-char
  // Stellar txHash) to findById throws a CastError synchronously, bypassing
  // the intended txHash fallback entirely.
  let payment = mongoose.Types.ObjectId.isValid(paymentId)
    ? await Payment.findById(paymentId)
    : null;
  if (!payment) {
    payment = await Payment.findOne({ txHash: paymentId, schoolId });
  }

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  // Validate that this is an underpaid payment
  if (payment.feeValidationStatus !== 'partial' && payment.feeValidationStatus !== 'underpaid') {
    throw new Error(
      `Payment ${paymentId} is not underpaid (status: ${payment.feeValidationStatus}). ` +
      'Partial credit can only be applied to underpaid transactions.'
    );
  }

  // Guard the read-modify-write of the student's balance with the same
  // per-student distributed lock used by verifyPayment/syncPaymentsForSchool
  // (#1201), so a concurrent payment confirmation for this student can't
  // race this read-modify-write and silently lose one of the two updates.
  const studentLockKey = lock.studentBalanceLockKey(payment.schoolId, payment.studentId);
  const studentLockInfo = await lock.acquire(studentLockKey, STUDENT_BALANCE_LOCK_TTL_MS);
  if (!studentLockInfo) {
    throw new Error(
      `Could not acquire balance lock for student ${payment.studentId} — another update is in progress. Please retry.`
    );
  }
  const { token: studentLockToken } = studentLockInfo;

  let now;
  try {
    // Re-read the student's balance now that the lock is held, so the shortfall
    // check and the write below are both based on up-to-date data.
    const student = await Student.findOne({
      schoolId: payment.schoolId,
      studentId: payment.studentId,
    });

    if (!student) {
      throw new Error(
        `Student ${payment.studentId} not found in school ${payment.schoolId}`
      );
    }

    const shortfall = Math.max(0, student.feeAmount - (student.totalPaid || 0));
    if (creditAmount > shortfall) {
      throw new Error(
        `Credit amount (${creditAmount}) exceeds shortfall (${shortfall}). ` +
        'Partial credit cannot exceed the remaining fee balance.'
      );
    }

    now = new Date();

    // Update payment with credit information
    payment.underpaidReconciliation.status = 'partial_credited';
    payment.underpaidReconciliation.appliedCredit = creditAmount;
    payment.underpaidReconciliation.creditAppliedAt = now;
    payment.underpaidReconciliation.creditAppliedBy = creditAppliedBy;
    await payment.save();

    // Update student's cumulative balance
    const newTotalPaid = (student.totalPaid || 0) + creditAmount;
    const newRemainingBalance = Math.max(0, student.feeAmount - newTotalPaid);
    await Student.findOneAndUpdate(
      { schoolId: payment.schoolId, studentId: payment.studentId },
      {
        totalPaid: parseFloat(newTotalPaid.toFixed(7)),
        remainingBalance: parseFloat(newRemainingBalance.toFixed(7)),
        feePaid: newTotalPaid >= student.feeAmount,
      },
      { new: true }
    );
  } finally {
    await lock.release(studentLockKey, studentLockToken);
  }

  logger.info('[UnderpaidReconciliation] Partial credit applied', {
    paymentId: payment._id,
    txHash: payment.txHash,
    schoolId: payment.schoolId,
    studentId: payment.studentId,
    creditAmount,
    creditAppliedBy,
    timestamp: now.toISOString(),
  });

  return payment;
}

/**
 * Initiate refund for an underpaid payment
 * Marks payment as refund-eligible and creates audit trail
 * @param {string} paymentId - Payment document ID or txHash
 * @param {string} refundInitiatedBy - User/admin initiating the refund
 * @param {string} schoolId - School ID for tenant scope
 * @param {string} refundNote - Optional note about the refund reason
 * @returns {Promise<object>} Updated payment document
 */
async function initiateRefund(paymentId, refundInitiatedBy, schoolId, refundNote = null) {
  // Find payment by ID or txHash (same isValid() guard as applyPartialCredit)
  let payment = mongoose.Types.ObjectId.isValid(paymentId)
    ? await Payment.findById(paymentId)
    : null;
  if (!payment) {
    payment = await Payment.findOne({ txHash: paymentId, schoolId });
  }

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  // Validate that this is an underpaid payment
  if (payment.feeValidationStatus !== 'partial' && payment.feeValidationStatus !== 'underpaid') {
    throw new Error(
      `Payment ${paymentId} is not underpaid (status: ${payment.feeValidationStatus}). ` +
      'Refunds can only be initiated for underpaid transactions.'
    );
  }

  const now = new Date();

  // Mark as refund-initiated (actual refund transaction would update this to refund_completed)
  payment.underpaidReconciliation.status = 'refund_initiated';
  payment.underpaidReconciliation.refundInitiatedAt = now;
  payment.underpaidReconciliation.refundNote = refundNote;
  await payment.save();

  logger.info('[UnderpaidReconciliation] Refund initiated', {
    paymentId: payment._id,
    txHash: payment.txHash,
    schoolId: payment.schoolId,
    studentId: payment.studentId,
    amount: payment.amount,
    refundInitiatedBy,
    refundNote,
    timestamp: now.toISOString(),
  });

  return payment;
}

/**
 * Complete refund for an underpaid payment
 * Called when refund transaction is confirmed on-chain
 * @param {string} paymentId - Payment document ID or txHash
 * @param {string} refundTxHash - Stellar transaction hash of the refund
 * @param {string} schoolId - School ID for tenant scope
 * @returns {Promise<object>} Updated payment document
 */
async function completeRefund(paymentId, refundTxHash, schoolId) {
  if (!refundTxHash) {
    throw new Error('refundTxHash is required to complete refund');
  }

  // Find payment by ID or txHash, always scoped to schoolId so that a
  // caller cannot act on a payment belonging to a different tenant —
  // matching the isolation pattern used by applyPartialCredit and
  // initiateRefund in this file.
  let payment = mongoose.Types.ObjectId.isValid(paymentId)
    ? await Payment.findOne({ _id: paymentId, schoolId })
    : null;
  if (!payment) {
    payment = await Payment.findOne({ txHash: paymentId, schoolId });
  }

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  const now = new Date();

  // Update refund completion status
  payment.underpaidReconciliation.status = 'refund_completed';
  payment.underpaidReconciliation.refundTxHash = refundTxHash;
  payment.underpaidReconciliation.refundCompletedAt = now;
  await payment.save();

  logger.info('[UnderpaidReconciliation] Refund completed', {
    paymentId: payment._id,
    originalTxHash: payment.txHash,
    refundTxHash,
    schoolId: payment.schoolId,
    studentId: payment.studentId,
    amount: payment.amount,
    timestamp: now.toISOString(),
  });

  return payment;
}

/**
 * Get underpaid payments pending reconciliation for a school
 * @param {string} schoolId - School ID
 * @param {object} options - Query options
 * @returns {Promise<array>} Array of pending underpaid payments
 */
async function getPendingUnderpaidPayments(schoolId, options = {}) {
  const {
    studentId = null,
    limit = 50,
    skip = 0,
  } = options;

  const query = {
    schoolId,
    feeValidationStatus: { $in: ['partial', 'underpaid'] },
    status: 'SUCCESS',
    deletedAt: null,
    'underpaidReconciliation.status': 'pending',
  };

  if (studentId) {
    query.studentId = studentId;
  }

  const payments = await Payment.find(query)
    .sort({ confirmedAt: -1 })
    .skip(skip)
    .limit(limit);

  return payments;
}

/**
 * Get reconciliation summary for underpaid payments
 * @param {string} schoolId - School ID
 * @returns {Promise<object>} Summary statistics
 */
async function getUnderpaidReconciliationSummary(schoolId) {
  const stats = await Payment.aggregate([
    {
      $match: {
        schoolId,
        feeValidationStatus: { $in: ['partial', 'underpaid'] },
        status: 'SUCCESS',
        deletedAt: null,
      },
    },
    {
      $facet: {
        byReconciliationStatus: [
          {
            $group: {
              _id: '$underpaidReconciliation.status',
              count: { $sum: 1 },
              totalAmount: { $sum: '$amount' },
            },
          },
        ],
        totalStats: [
          {
            $group: {
              _id: null,
              totalUnderpaid: { $sum: 1 },
              totalAmount: { $sum: '$amount' },
              avgShortfall: {
                $avg: {
                  $cond: [
                    { $eq: ['$feeValidationStatus', 'partial'] },
                    { $subtract: ['$feeAmount', '$amount'] },
                    0,
                  ],
                },
              },
            },
          },
        ],
      },
    },
  ]);

  return {
    byReconciliationStatus: stats[0]?.byReconciliationStatus || [],
    totalStats: stats[0]?.totalStats?.[0] || {},
  };
}

module.exports = {
  applyPartialCredit,
  initiateRefund,
  completeRefund,
  getPendingUnderpaidPayments,
  getUnderpaidReconciliationSummary,
};
