'use strict';

/**
 * Regression test — Issue #1039 / partial-credit consistency fix
 *
 * Verifies that a manual partial-credit adjustment applied via
 * applyPartialCredit() is NOT silently reverted by:
 *   (a) checkStudentBalanceConsistency  (5-minute cycle)
 *   (b) reconcileAll                    (24-hour cycle)
 *
 * Strategy: mock the DB layer so we can control exactly what each service
 * sees, then assert that findOneAndUpdate is never called with a totalPaid
 * that discards the credit adjustment.
 */

// ─── Infrastructure mocks (must be before any require) ───────────────────────

// reconciliationService imports logger transitively; stub it out so the test
// does not need winston installed at the root level.
jest.mock('../backend/src/utils/logger', () => {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };
  return Object.assign(log, { child: () => log });
});

// ─── Scenario constants ───────────────────────────────────────────────────────

// One confirmed payment of 50 against a 100 fee, leaving a 50 shortfall.
const PAYMENT_SUM = 50;

// Admin applied a 30-unit manual credit — stored as creditAdjustments on the
// student document after applyPartialCredit() ran.
const CREDIT_ADJUSTMENT = 30;

// Expected post-credit state:
//   totalPaid        = PAYMENT_SUM + CREDIT_ADJUSTMENT = 80
//   remainingBalance = 100 - 80 = 20
const STORED_TOTAL_PAID = PAYMENT_SUM + CREDIT_ADJUSTMENT; // 80
const STORED_REMAINING  = 100 - STORED_TOTAL_PAID;          // 20
const FEE_AMOUNT        = 100;

// ─── Model mocks ─────────────────────────────────────────────────────────────

const mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue({});

jest.mock('../backend/src/models/studentModel', () => ({
  find: jest.fn().mockImplementation(() => ({
    lean: () =>
      Promise.resolve([
        {
          schoolId: 'SCH-TEST',
          studentId: 'STU001',
          feeAmount: FEE_AMOUNT,
          totalPaid: STORED_TOTAL_PAID,
          remainingBalance: STORED_REMAINING,
          creditAdjustments: CREDIT_ADJUSTMENT,
          deletedAt: null,
        },
      ]),
  })),
  findOneAndUpdate: mockStudentFindOneAndUpdate,
}));

jest.mock('../backend/src/models/paymentModel', () => ({
  aggregate: jest.fn().mockResolvedValue([{ computedTotal: PAYMENT_SUM }]),
}));

jest.mock('../backend/src/models/schoolModel', () => ({
  find: jest.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
}));

jest.mock('../backend/src/models/reconciliationReportModel', () => ({
  create: jest.fn().mockResolvedValue({}),
}));

jest.mock('../backend/src/config/stellarConfig', () => ({
  server: {
    transactions: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records: [] }),
          }),
        }),
      }),
    }),
  },
}));

// ─── Subjects under test ──────────────────────────────────────────────────────

const {
  checkStudentBalanceConsistency,
} = require('../backend/src/services/consistencyService');

const { reconcileAll } = require('../backend/src/services/reconciliationService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if Student.findOneAndUpdate was called with a totalPaid value
 * that discards the manual credit (i.e. drops it back to the raw payment sum).
 */
function creditWasReverted() {
  for (const call of mockStudentFindOneAndUpdate.mock.calls) {
    const update = call[1];
    // reconcileAll uses top-level fields; consistencyService also uses top-level.
    const setBlock     = update?.$set ?? update ?? {};
    const appliedTotal = setBlock.totalPaid;
    if (appliedTotal !== undefined && appliedTotal < STORED_TOTAL_PAID - 0.0000001) {
      return true;
    }
  }
  return false;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockStudentFindOneAndUpdate.mockClear();
});

describe('partial credit — consistency job does not revert it', () => {
  test('checkStudentBalanceConsistency sees no drift when creditAdjustments is included', async () => {
    // paymentSum (50) + creditAdjustments (30) = 80 = storedTotal (80)
    // → no drift, no repair write.
    const mismatches = await checkStudentBalanceConsistency('SCH-TEST');

    expect(mismatches).toHaveLength(0);
    expect(mockStudentFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('checkStudentBalanceConsistency does not overwrite totalPaid with the raw payment sum', async () => {
    await checkStudentBalanceConsistency('SCH-TEST');

    expect(creditWasReverted()).toBe(false);
  });
});

describe('partial credit — reconciliation job does not revert it', () => {
  test('reconcileAll sees no drift when creditAdjustments is included', async () => {
    const result = await reconcileAll('SCH-TEST');

    // No mismatch → fixed count is 0.
    expect(result.fixed).toBe(0);
    expect(result.errors).toBe(0);
  });

  test('reconcileAll does not overwrite totalPaid with the raw payment sum', async () => {
    await reconcileAll('SCH-TEST');

    expect(creditWasReverted()).toBe(false);
  });
});

describe('partial credit — both jobs run in sequence', () => {
  test('running consistency then reconciliation leaves the credit intact', async () => {
    await checkStudentBalanceConsistency('SCH-TEST');
    await reconcileAll('SCH-TEST');

    expect(creditWasReverted()).toBe(false);
    // No real drift exists, so neither job should have fired a repair write.
    expect(mockStudentFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('baseline — genuine drift IS still corrected', () => {
  test('a student with stale totalPaid and no credit adjustment is still repaired', async () => {
    // Simulate a student whose stored totalPaid (40) is behind the real
    // payment sum (50) — perhaps a payment was recorded after the last run.
    const Student = require('../backend/src/models/studentModel');
    Student.find.mockImplementationOnce(() => ({
      lean: () =>
        Promise.resolve([
          {
            schoolId: 'SCH-TEST',
            studentId: 'STU001',
            feeAmount: 100,
            totalPaid: 40,      // stale — should be 50
            remainingBalance: 60,
            creditAdjustments: 0,
            deletedAt: null,
          },
        ]),
    }));

    const mismatches = await checkStudentBalanceConsistency('SCH-TEST');

    // storedTotal (40) ≠ computedTotal (50) → drift must be flagged and fixed.
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].type).toBe('student_balance_drift');
    expect(mismatches[0].computedTotal).toBe(50);

    expect(mockStudentFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 'STU001' }),
      expect.objectContaining({ totalPaid: 50 }),
    );
  });
});
