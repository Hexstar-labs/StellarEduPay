'use strict';

/**
 * Tests for issue #1198: getPaymentsByStudent requires schoolId scoping.
 *
 * Verifies:
 * 1. getPaymentsByStudent now accepts and applies a schoolId parameter.
 * 2. Querying with a studentId that exists across two schools only returns
 *    the calling school's records (no cross-tenant leak).
 * 3. Calling without a schoolId throws MISSING_SCHOOL_ID instead of silently
 *    performing an unscoped query.
 */

jest.mock('../src/utils/logger', () => ({
  child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));
jest.mock('../src/events/paymentEvents', () => ({ emit: jest.fn() }));
jest.mock('../src/utils/generateReferenceCode', () => ({
  generateReferenceCode: jest.fn().mockResolvedValue('REF-001'),
}));
jest.mock('../src/models/outboxModel', () => ({
  create: jest.fn().mockResolvedValue({}),
}));

// ── Payment model mock ───────────────────────────────────────────────────────

const mockFind = jest.fn();
jest.mock('../src/models/paymentModel', () => ({
  find: (...args) => mockFind(...args),
  create: jest.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a sort→lean chain for the mock. */
function chainResult(value) {
  return {
    sort: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(value),
    }),
  };
}

/** A typical payment record for school A. */
function schoolAPayment() {
  return {
    schoolId: 'SCHOOL-A',
    studentId: 'STU-001',
    txHash: 'hash-school-a',
    amount: 100,
    status: 'SUCCESS',
  };
}

/** A payment for the same studentId but a different school. */
function schoolBPayment() {
  return {
    schoolId: 'SCHOOL-B',
    studentId: 'STU-001', // same studentId — different school
    txHash: 'hash-school-b',
    amount: 200,
    status: 'SUCCESS',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

const { getPaymentsByStudent } = require('../src/services/transactionService');

// ── schoolId required ────────────────────────────────────────────────────────

describe('getPaymentsByStudent — schoolId required', () => {
  it('throws MISSING_SCHOOL_ID when called without schoolId', async () => {
    const err = await getPaymentsByStudent(undefined, 'STU-001').catch(e => e);

    expect(err.code).toBe('MISSING_SCHOOL_ID');
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('throws MISSING_SCHOOL_ID when schoolId is null', async () => {
    const err = await getPaymentsByStudent(null, 'STU-001').catch(e => e);

    expect(err.code).toBe('MISSING_SCHOOL_ID');
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('throws MISSING_SCHOOL_ID when schoolId is empty string', async () => {
    const err = await getPaymentsByStudent('', 'STU-001').catch(e => e);

    expect(err.code).toBe('MISSING_SCHOOL_ID');
    expect(mockFind).not.toHaveBeenCalled();
  });
});

// ── Correct scoping ──────────────────────────────────────────────────────────

describe('getPaymentsByStudent — correct tenant scoping', () => {
  it('queries Payment.find with both schoolId and studentId in the filter', async () => {
    mockFind.mockReturnValueOnce(chainResult([schoolAPayment()]));

    await getPaymentsByStudent('SCHOOL-A', 'STU-001');

    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ schoolId: 'SCHOOL-A', studentId: 'STU-001' })
    );
  });

  it('also filters by deletedAt: null (soft-delete awareness)', async () => {
    mockFind.mockReturnValueOnce(chainResult([schoolAPayment()]));

    await getPaymentsByStudent('SCHOOL-A', 'STU-001');

    expect(mockFind).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: null })
    );
  });

  it('returns only SCHOOL-A records when studentId collides across schools', async () => {
    // The mock simulates the DB correctly applying the filter — only SCHOOL-A's record is returned.
    mockFind.mockReturnValueOnce(chainResult([schoolAPayment()]));

    const results = await getPaymentsByStudent('SCHOOL-A', 'STU-001');

    expect(results).toHaveLength(1);
    expect(results[0].schoolId).toBe('SCHOOL-A');
    expect(results[0].txHash).toBe('hash-school-a');
  });

  it('returns only SCHOOL-B records when querying with SCHOOL-B', async () => {
    mockFind.mockReturnValueOnce(chainResult([schoolBPayment()]));

    const results = await getPaymentsByStudent('SCHOOL-B', 'STU-001');

    expect(results).toHaveLength(1);
    expect(results[0].schoolId).toBe('SCHOOL-B');
    expect(results[0].txHash).toBe('hash-school-b');
  });

  it('does NOT pass a filter containing only studentId (which would be the cross-tenant bug)', async () => {
    mockFind.mockReturnValueOnce(chainResult([]));

    await getPaymentsByStudent('SCHOOL-A', 'STU-001');

    const callFilter = mockFind.mock.calls[0][0];
    // The filter MUST include schoolId; a filter with only studentId is the pre-fix bug.
    expect(callFilter).toHaveProperty('schoolId');
    // schoolId should not be undefined or null
    expect(callFilter.schoolId).toBeTruthy();
  });
});

// ── Return value ─────────────────────────────────────────────────────────────

describe('getPaymentsByStudent — return value', () => {
  it('returns an empty array when no payments exist for the school+student combination', async () => {
    mockFind.mockReturnValueOnce(chainResult([]));

    const results = await getPaymentsByStudent('SCHOOL-A', 'STU-999');

    expect(results).toEqual([]);
  });

  it('returns multiple payments when more than one exists', async () => {
    const payments = [
      { ...schoolAPayment(), txHash: 'hash-1' },
      { ...schoolAPayment(), txHash: 'hash-2' },
    ];
    mockFind.mockReturnValueOnce(chainResult(payments));

    const results = await getPaymentsByStudent('SCHOOL-A', 'STU-001');

    expect(results).toHaveLength(2);
  });
});
