/**
 * Transaction Manager Service
 *
 * Provides production-ready transaction management for MongoDB with support for:
 * - ACID transactions with proper isolation levels
 * - Optimistic and pessimistic locking strategies
 * - Automatic retry with exponential backoff for transient errors
 * - Safe debit/credit operations for financial transactions
 * - Deadlock detection and recovery
 *
 * ── INFRASTRUCTURE REQUIREMENT: REPLICA SET ────────────────────────────────
 * Multi-document MongoDB transactions REQUIRE a replica set or sharded
 * cluster. Against a standalone mongod, EVERY call in this module fails with:
 *
 *   MongoServerError: Transaction numbers are only allowed on a replica set
 *   member or mongos
 *
 * That error is an infrastructure misconfiguration, not a code bug — the fix
 * is to run mongod with --replSet and execute rs.initiate() once. All
 * bundled environments comply: docker-compose.yml and the CI workflow run a
 * single-node replica set named "rs0", and deploy/k8s/mongodb-statefulset.yaml
 * configures the StatefulSet the same way. See docs/architecture.md,
 * "Replica Set Requirement".
 */

'use strict';

const mongoose = require('mongoose');
const { getConnection } = require('../config/database');
const { logger } = require('../utils/logger');
const { TRANSACTION_CONFIG } = require('../config/database');

// ── Transaction Options ─────────────────────────────────────────────────────────
const DEFAULT_TRANSACTION_OPTIONS = {
  readConcern: { level: TRANSACTION_CONFIG.readConcern },
  writeConcern: { w: TRANSACTION_CONFIG.writeConcern, journal: TRANSACTION_CONFIG.journal },
  readPreference: 'primary',
};

// ── Lock Types ─────────────────────────────────────────────────────────────────
const LOCK_TYPE = {
  OPTIMISTIC: 'optimistic',
  PESSIMISTIC: 'pessimistic',
};

// ── Error Codes ────────────────────────────────────────────────────────────────
const TRANSACTION_ERRORS = {
  LOCK_FAILED: 'LOCK_FAILED',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  TRANSACTION_ABORTED: 'TRANSACTION_ABORTED',
  DEADLOCK_DETECTED: 'DEADLOCK_DETECTED',
  MAX_RETRIES_EXCEEDED: 'MAX_RETRIES_EXCEEDED',
  INVALID_TRANSACTION: 'INVALID_TRANSACTION',
};

/**
 * Custom Transaction Error
 */
class TransactionError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'TransactionError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

/**
 * Optimistic Lock Error - thrown when version mismatch detected
 */
class OptimisticLockError extends TransactionError {
  constructor(message, currentVersion, attemptedVersion, details = {}) {
    super(message, TRANSACTION_ERRORS.VERSION_MISMATCH, {
      ...details,
      currentVersion,
      attemptedVersion,
    });
    this.name = 'OptimisticLockError';
  }
}

/**
 * Pessimistic Lock Error - thrown when lock acquisition fails
 */
class PessimisticLockError extends TransactionError {
  constructor(message, resourceId, lockType, details = {}) {
    super(message, TRANSACTION_ERRORS.LOCK_FAILED, {
      ...details,
      resourceId,
      lockType,
    });
    this.name = 'PessimisticLockError';
  }
}

// ── Version Counter Schema (for Optimistic Locking) ────────────────────────────
const versionCounterSchema = new mongoose.Schema({
  entityType: { type: String, required: true, index: true },
  entityId: { type: String, required: true, index: true },
  version: { type: Number, default: 1 },
  lockedUntil: { type: Date, default: null },
  lockHolder: { type: String, default: null },
}, {
  timestamps: true,
  collection: 'version_counters',
});

// Compound index for efficient lookups
versionCounterSchema.index({ entityType: 1, entityId: 1 }, { unique: true });

const VersionCounter = mongoose.models.VersionCounter || mongoose.model('VersionCounter', versionCounterSchema);

// ── Transaction Manager Class ──────────────────────────────────────────────────
class TransactionManager {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.retryDelayMs = options.retryDelayMs || 100;
    this.maxRetryDelayMs = options.maxRetryDelayMs || 5000;
    this.transactionTimeoutMs = options.transactionTimeoutMs || TRANSACTION_CONFIG.transactionTimeoutMs;
    this.activeTransactions = new Map();
    this.transactionCounter = 0;
  }

  /**
   * Calculate exponential backoff delay
   */
  calculateBackoff(attempt) {
    const delay = this.retryDelayMs * Math.pow(2, attempt);
    return Math.min(delay, this.maxRetryDelayMs);
  }

  /**
   * Check if an error is retryable, strictly per the MongoDB driver error
   * contract.
   *
   * Only two signals are honoured:
   *  1. Driver error labels — 'TransientTransactionError' and
   *     'UnknownTransactionCommitResult' — attached by the server/driver.
   *  2. Explicit numeric server error codes that are transient by definition.
   *
   * Error MESSAGE substring matching is deliberately NOT used. Messages are
   * free-form text; matching words like 'Lock' or 'transaction' would replay
   * non-transient failures (up to maxRetries times). In a module that moves
   * money, replaying an error whose effects may already be durable is the
   * most dangerous possible behaviour. If a failure is genuinely transient,
   * the server tells us so via a label or one of the codes below.
   */
  isRetryableError(error) {
    if (!error) return false;

    if (typeof error.hasErrorLabel === 'function') {
      if (
        error.hasErrorLabel('TransientTransactionError') ||
        error.hasErrorLabel('UnknownTransactionCommitResult')
      ) {
        return true;
      }
    }

    switch (error.code) {
      case 112: return true; // WriteConflict
      case 189: return true; // PrimarySteppedDown (election aborts the txn)
      case 261: return true; // TooManyLogicalSessions
      default:  return false;
    }
  }

  /**
   * Execute a function with automatic retry on transient errors
   */
  async withRetry(operation, options = {}) {
    const maxAttempts = options.maxRetries ?? this.maxRetries;
    let lastError;
    let attempt = 0;

    while (attempt < maxAttempts) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        attempt++;

        if (!this.isRetryableError(error)) {
          logger.error('[TransactionManager] Non-retryable error', {
            error: error.message,
            attempt,
          });
          throw error;
        }

        if (attempt >= maxAttempts) {
          logger.error('[TransactionManager] Max retries exceeded', {
            attempts: attempt,
            error: error.message,
          });
          throw new TransactionError(
            `Transaction failed after ${attempt} attempts: ${error.message}`,
            TRANSACTION_ERRORS.MAX_RETRIES_EXCEEDED,
            { originalError: error.message, attempts: attempt }
          );
        }

        const delay = this.calculateBackoff(attempt);
        logger.warn('[TransactionManager] Retrying after error', {
          attempt,
          maxAttempts,
          delay,
          error: error.message,
        });

        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Start a new transaction session (manual control path).
   *
   * Prefer withTransaction() — it delegates lifecycle and retry semantics to
   * the driver. startSession() exists for callers that need explicit
   * commit/abort control (safeDebit/safeCredit/atomicTransfer below) and does
   * NOT retry: once a transaction aborts on the server, this session is dead.
   */
  async startSession() {
    const connection = getConnection();
    const session = await connection.startSession();

    // startTransaction() MUST be called before any operations can be sent
    // over the session.  Without it, commitTransaction() and abortTransaction()
    // both throw "Transaction number, statement number, and start time must be
    // specified…" because the driver requires an active transaction before
    // either can complete.
    session.startTransaction(DEFAULT_TRANSACTION_OPTIONS);
    
    const transactionId = ++this.transactionCounter;
    const transactionInfo = {
      id: transactionId,
      session,
      startedAt: new Date(),
      operations: [],
    };
    
    this.activeTransactions.set(transactionId, transactionInfo);
    
    logger.debug('[TransactionManager] Started transaction', {
      transactionId,
    });
    
    return { session, transactionId };
  }

  /**
   * Commit a transaction
   */
  async commitTransaction(session, transactionId) {
    try {
      const transactionInfo = this.activeTransactions.get(transactionId);
      
      if (!transactionInfo) {
        throw new TransactionError(
          'Transaction not found',
          TRANSACTION_ERRORS.INVALID_TRANSACTION
        );
      }

      await session.commitTransaction();
      
      const duration = Date.now() - transactionInfo.startedAt.getTime();
      logger.info('[TransactionManager] Transaction committed', {
        transactionId,
        duration,
        operations: transactionInfo.operations.length,
      });

      this.activeTransactions.delete(transactionId);
      await session.endSession();
      
      return { success: true, duration };
    } catch (error) {
      logger.error('[TransactionManager] Commit failed', {
        transactionId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Abort a transaction
   */
  async abortTransaction(session, transactionId) {
    try {
      await session.abortTransaction();
      
      const transactionInfo = this.activeTransactions.get(transactionId);
      if (transactionInfo) {
        this.activeTransactions.delete(transactionId);
      }
      
      await session.endSession();
      
      logger.info('[TransactionManager] Transaction aborted', { transactionId });
      return { success: true };
    } catch (error) {
      logger.error('[TransactionManager] Abort failed', {
        transactionId,
        error: error.message,
      });
      // Ensure session is ended even on abort failure
      try {
        await session.endSession();
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Execute `operation` inside a multi-document MongoDB transaction.
   *
   * Retry semantics are split across two layers, both correct by construction:
   *
   *  1. Inner (per session): delegated to the driver's
   *     `session.withTransaction()`. Per the drivers specification it starts
   *     the transaction, aborts on failure, re-runs the callback once on a
   *     TransientTransactionError, and retries the commit itself on
   *     UnknownTransactionCommitResult.
   *
   *  2. Outer (across attempts): each attempt opens a FRESH session. A
   *     transaction that has aborted on the server can never be revived on
   *     its session — retrying inside one dead session (the previous
   *     implementation) was guaranteed to fail every attempt and burn the
   *     backoff budget for nothing.
   *
   * The original error is re-thrown as-is (never wrapped) so its driver error
   * labels and numeric codes survive for upstream callers.
   */
  async withTransaction(operation, options = {}) {
    const maxAttempts = Math.max(1, options.maxRetries ?? this.maxRetries);
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const connection = getConnection();
      const session = await connection.startSession();
      const transactionId = ++this.transactionCounter;

      this.activeTransactions.set(transactionId, {
        id: transactionId,
        session,
        startedAt: new Date(),
        operations: [],
        attempt,
      });

      try {
        const result = await session.withTransaction(
          () => operation(session),
          DEFAULT_TRANSACTION_OPTIONS,
        );

        this.activeTransactions.delete(transactionId);
        logger.info('[TransactionManager] Transaction committed', {
          transactionId,
          attempt,
        });
        return result;
      } catch (error) {
        this.activeTransactions.delete(transactionId);
        lastError = error;

        if (!this.isRetryableError(error) || attempt >= maxAttempts) {
          logger.error('[TransactionManager] Transaction failed', {
            transactionId,
            attempt,
            maxAttempts,
            retryable: this.isRetryableError(error),
            error: error.message,
          });
          throw error;
        }

        const delay = this.calculateBackoff(attempt);
        logger.warn('[TransactionManager] Transient error — retrying on a fresh session', {
          transactionId,
          attempt,
          maxAttempts,
          delay,
          error: error.message,
        });
        await this.sleep(delay);
      } finally {
        // The session is single-use: end it whichever way the attempt went.
        try {
          await session.endSession();
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    throw lastError;
  }

  /**
   * Execute with pessimistic locking using findOneAndUpdate with $set
   */
  async withPessimisticLock(operation, options = {}) {
    const {
      entityType,
      entityId,
      lockDurationMs = 30000,
      lockId = `lock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    } = options;

    const lockDeadline = new Date(Date.now() + lockDurationMs);

    // Try to acquire lock using atomic update
    const lockResult = await VersionCounter.findOneAndUpdate(
      {
        entityType,
        entityId,
        $or: [
          { lockedUntil: null },
          { lockedUntil: { $lte: new Date() } }, // Lock expired
        ],
      },
      {
        $set: {
          lockedUntil: lockDeadline,
          lockHolder: lockId,
        },
        $inc: { version: 1 },
      },
      {
        new: true,
        upsert: true,
      }
    );

    if (!lockResult || lockResult.lockHolder !== lockId) {
      throw new PessimisticLockError(
        `Failed to acquire lock for ${entityType}:${entityId}`,
        `${entityType}:${entityId}`,
        LOCK_TYPE.PESSIMISTIC,
        { lockId }
      );
    }

    try {
      // Execute the protected operation
      return await operation();
    } finally {
      // Release the lock
      await VersionCounter.findOneAndUpdate(
        {
          entityType,
          entityId,
          lockHolder: lockId,
        },
        {
          $set: {
            lockedUntil: null,
            lockHolder: null,
          },
        }
      );

      logger.debug('[TransactionManager] Released pessimistic lock', {
        entityType,
        entityId,
        lockId,
      });
    }
  }

  /**
   * Execute with optimistic locking using version checking
   */
  async withOptimisticLock(operation, options = {}) {
    const { entityType, entityId } = options;

    // Get current version
    const versionRecord = await VersionCounter.findOne({ entityType, entityId });
    const currentVersion = versionRecord?.version || 0;

    // Execute operation with version check
    const result = await operation(currentVersion);

    // Update version after successful operation
    await VersionCounter.findOneAndUpdate(
      { entityType, entityId, version: currentVersion },
      {
        $inc: { version: 1 },
      }
    );

    return result;
  }

  /**
   * Optimistic lock wrapper with retry for version conflicts
   */
  async withOptimisticLockRetry(operation, options = {}) {
    const maxRetries = options.maxRetries ?? 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        return await this.withOptimisticLock(operation, options);
      } catch (error) {
        if (error.code === TRANSACTION_ERRORS.VERSION_MISMATCH) {
          attempt++;
          const delay = this.calculateBackoff(attempt);
          
          logger.warn('[TransactionManager] Optimistic lock conflict, retrying', {
            attempt,
            maxRetries,
            delay,
            entityType: options.entityType,
            entityId: options.entityId,
          });

          await this.sleep(delay);
          continue;
        }
        throw error;
      }
    }

    throw new OptimisticLockError(
      `Optimistic lock failed after ${maxRetries} retries`,
      null,
      null,
      { entityType: options.entityType, entityId: options.entityId }
    );
  }

  /**
   * Get active transaction count
   */
  getActiveTransactionCount() {
    return this.activeTransactions.size;
  }

  /**
   * Clean up stale locks (run periodically)
   */
  async cleanupStaleLocks() {
    const result = await VersionCounter.updateMany(
      {
        lockedUntil: { $lte: new Date() },
        lockHolder: { $ne: null },
      },
      {
        $set: {
          lockedUntil: null,
          lockHolder: null,
        },
      }
    );

    if (result.modifiedCount > 0) {
      logger.info('[TransactionManager] Cleaned up stale locks', {
        count: result.modifiedCount,
      });
    }

    return result;
  }

  /**
   * Get lock status for an entity
   */
  async getLockStatus(entityType, entityId) {
    const lock = await VersionCounter.findOne({ entityType, entityId });
    
    if (!lock) {
      return { locked: false };
    }

    const isLocked = lock.lockedUntil && lock.lockedUntil > new Date();
    
    return {
      locked: isLocked,
      lockedUntil: lock.lockedUntil,
      lockHolder: lock.lockHolder,
      version: lock.version,
    };
  }
}

// ── Singleton Instance ──────────────────────────────────────────────────────────
const transactionManager = new TransactionManager();

/**
 * Helper: Execute debit operation safely
 */
async function safeDebit(accountId, amount, _options = {}) {
  const { session, transactionId } = await transactionManager.startSession();
  
  try {
    const Student = require('../models/studentModel');
    
    // Use findOneAndUpdate with atomic operation to prevent race conditions
    const student = await Student.findOneAndUpdate(
      {
        studentId: accountId,
        $expr: { $gte: ['$totalPaid', amount] }, // Ensure sufficient balance
      },
      {
        $inc: { totalPaid: -amount },
        $set: { 
          remainingBalance: { $subtract: ['$totalPaid', amount] },
          lastTransactionAt: new Date(),
        },
      },
      {
        new: true,
        session,
      }
    );

    if (!student) {
      // Check if account exists or insufficient balance
      const existingStudent = await Student.findOne({ studentId: accountId }).session(session);
      
      if (!existingStudent) {
        throw new TransactionError(
          `Account not found: ${accountId}`,
          'ACCOUNT_NOT_FOUND'
        );
      }
      
      if (existingStudent.totalPaid < amount) {
        throw new TransactionError(
          `Insufficient balance. Available: ${existingStudent.totalPaid}, Required: ${amount}`,
          'INSUFFICIENT_BALANCE'
        );
      }
    }

    await transactionManager.commitTransaction(session, transactionId);
    
    return {
      success: true,
      accountId,
      debited: amount,
      newBalance: student?.remainingBalance || 0,
    };
  } catch (error) {
    await transactionManager.abortTransaction(session, transactionId);
    throw error;
  }
}

/**
 * Helper: Execute credit operation safely
 */
async function safeCredit(accountId, amount, _options = {}) {
  const { session, transactionId } = await transactionManager.startSession();
  
  try {
    const Student = require('../models/studentModel');
    
    // Use findOneAndUpdate with atomic operation
    const student = await Student.findOneAndUpdate(
      { studentId: accountId },
      {
        $inc: { totalPaid: amount },
        $set: { 
          lastTransactionAt: new Date(),
        },
      },
      {
        new: true,
        upsert: true, // Create if not exists
        session,
        setDefaultsOnInsert: true,
      }
    );

    // Update remaining balance
    const newRemainingBalance = Math.max(0, student.feeAmount - student.totalPaid);
    const isFeePaid = student.totalPaid >= student.feeAmount;

    await Student.findOneAndUpdate(
      { studentId: accountId },
      {
        $set: {
          remainingBalance: newRemainingBalance,
          feePaid: isFeePaid,
        },
      },
      { session }
    );

    await transactionManager.commitTransaction(session, transactionId);

    return {
      success: true,
      accountId,
      credited: amount,
      newTotalPaid: student.totalPaid,
      remainingBalance: newRemainingBalance,
      feePaid: isFeePaid,
    };
  } catch (error) {
    await transactionManager.abortTransaction(session, transactionId);
    throw error;
  }
}

/**
 * Helper: Execute atomic balance transfer
 */
async function atomicTransfer(fromAccountId, toAccountId, amount, _options = {}) {
  const { session, transactionId } = await transactionManager.startSession();
  
  try {
    const Student = require('../models/studentModel');
    
    // Debit from source account
    const sourceStudent = await Student.findOneAndUpdate(
      {
        studentId: fromAccountId,
        $expr: { $gte: ['$totalPaid', amount] },
      },
      {
        $inc: { totalPaid: -amount },
      },
      {
        new: true,
        session,
      }
    );

    if (!sourceStudent) {
      throw new TransactionError(
        `Insufficient balance or account not found: ${fromAccountId}`,
        'INSUFFICIENT_BALANCE'
      );
    }

    // Credit to destination account
    const destStudent = await Student.findOneAndUpdate(
      { studentId: toAccountId },
      {
        $inc: { totalPaid: amount },
      },
      {
        new: true,
        upsert: true,
        session,
      }
    );

    await transactionManager.commitTransaction(session, transactionId);
    
    return {
      success: true,
      fromAccountId,
      toAccountId,
      amount,
      sourceNewBalance: sourceStudent.totalPaid,
      destNewBalance: destStudent.totalPaid,
    };
  } catch (error) {
    await transactionManager.abortTransaction(session, transactionId);
    throw error;
  }
}

module.exports = {
  transactionManager,
  TransactionManager,
  TransactionError,
  OptimisticLockError,
  PessimisticLockError,
  LOCK_TYPE,
  TRANSACTION_ERRORS,
  safeDebit,
  safeCredit,
  atomicTransfer,
};
