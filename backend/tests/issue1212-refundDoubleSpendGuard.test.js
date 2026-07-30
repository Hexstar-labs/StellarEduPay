'use strict';

/**
 * Tests for issue #1212: double-refund guard + distributed lock in refundService.
 *
 * Verifies:
 * 1. A second concurrent refund request for the same payment is rejected by the
 *    distributed lock (REFUND_LOCK_CONTENDED).
 * 2. A sequential second refund request is rejected by the ACTIVE_REFUND_STATUSES
 *    guard (REFUND_ALREADY_EXISTS).
 * 3. A failed refund record does NOT block a new refund request.
 * 4. The lock is always released (even when the inner logic throws).
 * 5. refundLockKey produces the expected key format.
 */

jest.mock('../src/utils/logger', () => ({
  child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

// ── Model mocks ──────────────────────────────────────────────────────────────

const mockPaymentFindOne = jest.fn();
jest.mock('../src/models/paymentModel', () => ({
  findOne: (...args) => mockPaymentFindOne(...args),
}));

const mockRefundFindOne = jest.fn();
const mockRefundCreate = jest.fn();
jest.mock('../src/models/refundModel', () => ({
  findOne: (...args) => mockRefundFindOne(...args),
  create: (...args) => mockRefundCreate(...args),
  find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
  findById: jest.fn(),
}));

const mockOutboxCreate = jest.fn().mockResolvedValue({});
jest.mock('../src/models/outboxModel', () => ({
  create: (...args) => mockOutboxCreate(...args),
}));

// ── Distributed lock mock ────────────────────────────────────────────────────
// We need fine-grained control over the lock to simulate contention scenarios.

const mockLockAcquire = jest.fn();
const mockLockRelease = jest.fn().mockResolvedValue(true);
jest.mock('../src/services/distributedLock', () => ({
  acquire: (...args) => mockLockAcquire(...args),
  release: (...args) => mockLockRelease(...args),
  _resetLocalLocks: jest.fn(),
}));

// ── Stellar amount util ──────────────────────────────────────────────────────
jest.mock('../src/utils/stellarAmount', () => ({
  amountsEqual: (a, b) => a === b,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const SCHOOL_ID = 'SCH-TEST';
const TX_HASH = 'abc123txhash';
const STUDENT_ID = 'STU-001';
const AMOUNT = 100;
const REASON = 'duplicate charge';
const INITIATED_BY = 'admin-1';

/** A mock Payment in SUCCESS state. */
function mockSuccessPayment() {
  return {
    schoolId: SCHOOL_ID,
    txHash: TX_HASH,
    studentId: STUDENT_ID,
    amount: AMOUNT,
    status: 'SUCCESS',
    $locals: {},
    save: jest.fn().mockResolvedValue(true),
  };
}

/** A mock Refund document in approval_pending state. */
function mockExistingRefund(status = 'approval_pending') {
  return {
    _id: 'refund-id-001',
    schoolId: SCHOOL_ID,
    originalTxHash: TX_HASH,
    status,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: lock is available
  mockLockAcquire.mockResolvedValue({ token: 'mock-token-1', fencingToken: 1 });
  // Default: payment exists in SUCCESS state
  mockPaymentFindOne.mockResolvedValue(mockSuccessPayment());
  // Default: no existing active refund
  mockRefundFindOne.mockResolvedValue(null);
  // Default: refund creates successfully
  mockRefundCreate.mockResolvedValue({
    _id: 'new-refund-id',
    schoolId: SCHOOL_ID,
    originalTxHash: TX_HASH,
    studentId: STUDENT_ID,
    amount: AMOUNT,
    status: 'approval_pending',
  });
});

// ── Import service ───────────────────────────────────────────────────────────

const {
  initiateRefund,
  refundLockKey,
  ACTIVE_REFUND_STATUSES,
} = require('../src/services/refundService');

// ── refundLockKey ────────────────────────────────────────────────────────────

describe('refundLockKey', () => {
  it('produces the expected key format', () => {
    expect(refundLockKey('SCH-1', 'txhash123')).toBe('refund:lock:SCH-1:txhash123');
  });

  it('includes both schoolId and txHash to scope the lock per-payment per-school', () => {
    const key = refundLockKey(SCHOOL_ID, TX_HASH);
    expect(key).toContain(SCHOOL_ID);
    expect(key).toContain(TX_HASH);
  });
});

// ── ACTIVE_REFUND_STATUSES ───────────────────────────────────────────────────

describe('ACTIVE_REFUND_STATUSES', () => {
  it('contains all non-failed terminal and in-progress statuses', () => {
    expect(ACTIVE_REFUND_STATUSES).toEqual(
      expect.arrayContaining(['approval_pending', 'pending', 'submitted', 'confirmed'])
    );
  });

  it('does NOT contain "failed" (failed refunds should allow a new attempt)', () => {
    expect(ACTIVE_REFUND_STATUSES).not.toContain('failed');
  });
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe('initiateRefund — happy path', () => {
  it('creates and returns a new Refund when no active refund exists', async () => {
    const result = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY);

    expect(result).toMatchObject({ schoolId: SCHOOL_ID, originalTxHash: TX_HASH });
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
    expect(mockOutboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'refund.initiated' }),
    );
  });

  it('acquires the lock with the correct key before doing any work', async () => {
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY);

    const expectedKey = refundLockKey(SCHOOL_ID, TX_HASH);
    expect(mockLockAcquire).toHaveBeenCalledWith(expectedKey, expect.any(Number));
  });

  it('releases the lock after successful completion', async () => {
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY);

    expect(mockLockRelease).toHaveBeenCalledWith(
      refundLockKey(SCHOOL_ID, TX_HASH),
      'mock-token-1'
    );
  });
});

// ── Distributed lock contention ──────────────────────────────────────────────

describe('initiateRefund — distributed lock contention (#1212)', () => {
  it('throws REFUND_LOCK_CONTENDED when lock cannot be acquired', async () => {
    mockLockAcquire.mockResolvedValueOnce(null); // lock held by another replica

    const err = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY)
      .catch(e => e);

    expect(err.code).toBe('REFUND_LOCK_CONTENDED');
    // Neither DB model should have been touched
    expect(mockPaymentFindOne).not.toHaveBeenCalled();
    expect(mockRefundCreate).not.toHaveBeenCalled();
  });

  it('simulates concurrent double-click: two simultaneous calls — exactly one succeeds', async () => {
    // First call gets the lock, second call finds it already held.
    mockLockAcquire
      .mockResolvedValueOnce({ token: 'token-A', fencingToken: 1 }) // call A wins
      .mockResolvedValueOnce(null);                                  // call B is rejected

    const [r1, r2] = await Promise.allSettled([
      initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY),
      initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY),
    ]);

    const succeeded = [r1, r2].filter(r => r.status === 'fulfilled');
    const rejected  = [r1, r2].filter(r => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe('REFUND_LOCK_CONTENDED');
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
  });
});

// ── Active refund guard ──────────────────────────────────────────────────────

describe('initiateRefund — active refund guard (#1212)', () => {
  for (const status of ACTIVE_REFUND_STATUSES) {
    it(`throws REFUND_ALREADY_EXISTS when an existing refund has status "${status}"`, async () => {
      mockRefundFindOne.mockResolvedValueOnce(mockExistingRefund(status));

      const err = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY)
        .catch(e => e);

      expect(err.code).toBe('REFUND_ALREADY_EXISTS');
      expect(err.message).toContain(status);
      expect(err.refundId).toBe('refund-id-001');
      // No new refund should be created
      expect(mockRefundCreate).not.toHaveBeenCalled();
    });
  }

  it('does NOT block when the only existing refund has status "failed"', async () => {
    mockRefundFindOne.mockResolvedValueOnce(null); // failed refunds excluded by the query filter

    const result = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY);

    expect(result).toBeDefined();
    expect(mockRefundCreate).toHaveBeenCalledTimes(1);
  });

  it('queries Refund.findOne with schoolId, originalTxHash, and ACTIVE_REFUND_STATUSES filter', async () => {
    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY);

    expect(mockRefundFindOne).toHaveBeenCalledWith({
      schoolId: SCHOOL_ID,
      originalTxHash: TX_HASH,
      status: { $in: ACTIVE_REFUND_STATUSES },
    });
  });
});

// ── Lock is always released ──────────────────────────────────────────────────

describe('initiateRefund — lock always released (finally block)', () => {
  it('releases the lock even when Payment lookup throws', async () => {
    mockPaymentFindOne.mockRejectedValueOnce(new Error('DB connection error'));

    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY).catch(() => {});

    expect(mockLockRelease).toHaveBeenCalledWith(
      refundLockKey(SCHOOL_ID, TX_HASH),
      'mock-token-1'
    );
  });

  it('releases the lock even when REFUND_ALREADY_EXISTS is thrown', async () => {
    mockRefundFindOne.mockResolvedValueOnce(mockExistingRefund('pending'));

    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY).catch(() => {});

    expect(mockLockRelease).toHaveBeenCalledWith(
      refundLockKey(SCHOOL_ID, TX_HASH),
      'mock-token-1'
    );
  });

  it('releases the lock even when Refund.create throws', async () => {
    mockRefundCreate.mockRejectedValueOnce(new Error('write failed'));

    await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY).catch(() => {});

    expect(mockLockRelease).toHaveBeenCalledWith(
      refundLockKey(SCHOOL_ID, TX_HASH),
      'mock-token-1'
    );
  });
});

// ── Existing error paths still work ─────────────────────────────────────────

describe('initiateRefund — existing validation paths', () => {
  it('throws PAYMENT_NOT_FOUND when payment does not exist', async () => {
    mockPaymentFindOne.mockResolvedValueOnce(null);

    const err = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, AMOUNT, REASON, INITIATED_BY)
      .catch(e => e);

    expect(err.code).toBe('PAYMENT_NOT_FOUND');
  });

  it('throws AMOUNT_MISMATCH when refund amount differs from payment amount', async () => {
    const err = await initiateRefund(SCHOOL_ID, TX_HASH, STUDENT_ID, 999, REASON, INITIATED_BY)
      .catch(e => e);

    expect(err.code).toBe('AMOUNT_MISMATCH');
  });
});
