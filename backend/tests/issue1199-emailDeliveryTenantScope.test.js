'use strict';

/**
 * Tests for issue #1199: updateEmailDeliveryStatus non-recordId branch must call
 * .bypassTenantScope() to avoid always throwing TenantScopeError.
 *
 * Verifies:
 * 1. The recordId branch completes successfully (regression guard).
 * 2. The non-recordId (provider/providerMessageId) branch completes successfully
 *    without throwing TenantScopeError.
 * 3. Both branches call .bypassTenantScope() — confirmed by verifying the mock
 *    chain is exercised.
 * 4. Student delivery status is updated when the returned record has schoolId/studentId.
 */

jest.mock('../src/utils/logger', () => ({
  child: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

// ── TenantScope simulation ───────────────────────────────────────────────────
//
// We replicate the plugin's behaviour: findOneAndUpdate returns a query object
// whose default resolution throws TenantScopeError (simulating the missing
// schoolId check), but .bypassTenantScope() on that query resolves normally.

class TenantScopeError extends Error {
  constructor() {
    super('[TenantScope] Missing schoolId');
    this.name = 'TenantScopeError';
    this.code = 'TENANT_SCOPE_MISSING';
  }
}

/**
 * Build a mock query object that:
 * - Throws TenantScopeError when awaited directly (simulates the plugin guard)
 * - Resolves with `resolvedValue` when .bypassTenantScope() is chained first
 */
function buildMockQuery(resolvedValue) {
  const query = {
    _bypassed: false,
    bypassTenantScope() {
      this._bypassed = true;
      return this;
    },
    then(onFulfilled, onRejected) {
      if (this._bypassed) {
        return Promise.resolve(resolvedValue).then(onFulfilled, onRejected);
      }
      return Promise.reject(new TenantScopeError()).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return this.then(undefined, onRejected);
    },
    finally(fn) {
      return this.then(fn, fn);
    },
  };
  return query;
}

// ── Model mocks ──────────────────────────────────────────────────────────────

const mockFindOneAndUpdate = jest.fn();
jest.mock('../src/models/emailDeliveryModel', () => ({
  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
  create: jest.fn(),
  findOne: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

const mockStudentFindOneAndUpdate = jest.fn().mockResolvedValue({});
jest.mock('../src/models/studentModel', () => ({
  findOneAndUpdate: (...args) => mockStudentFindOneAndUpdate(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const SCHOOL_ID = 'SCH-TEST';
const STUDENT_ID = 'STU-001';

function mockDeliveryRecord(overrides = {}) {
  return {
    _id: 'delivery-001',
    schoolId: SCHOOL_ID,
    studentId: STUDENT_ID,
    provider: 'sendgrid',
    providerMessageId: 'msg-abc-123',
    status: 'sent',
    sentAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

const { updateEmailDeliveryStatus } = require('../src/services/emailDeliveryService');

// ── recordId branch ──────────────────────────────────────────────────────────

describe('updateEmailDeliveryStatus — recordId branch (regression guard)', () => {
  it('completes successfully and returns the updated record', async () => {
    const updated = mockDeliveryRecord({ status: 'delivered' });
    mockFindOneAndUpdate.mockReturnValueOnce(buildMockQuery(updated));

    const result = await updateEmailDeliveryStatus(
      { recordId: 'delivery-001' },
      'delivered',
    );

    expect(result).toEqual(updated);
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'delivery-001' },
      expect.anything(),
      expect.anything(),
    );
  });

  it('calls bypassTenantScope on the query', async () => {
    const updated = mockDeliveryRecord({ status: 'delivered' });
    const mockQuery = buildMockQuery(updated);
    const bypassSpy = jest.spyOn(mockQuery, 'bypassTenantScope');
    mockFindOneAndUpdate.mockReturnValueOnce(mockQuery);

    await updateEmailDeliveryStatus({ recordId: 'delivery-001' }, 'delivered');

    expect(bypassSpy).toHaveBeenCalled();
  });
});

// ── non-recordId branch ──────────────────────────────────────────────────────

describe('updateEmailDeliveryStatus — non-recordId branch (#1199)', () => {
  it('completes successfully without throwing TenantScopeError', async () => {
    const updated = mockDeliveryRecord({ status: 'delivered' });
    mockFindOneAndUpdate.mockReturnValueOnce(buildMockQuery(updated));

    // Before the fix this would reject with TenantScopeError every time.
    await expect(
      updateEmailDeliveryStatus(
        { provider: 'sendgrid', providerMessageId: 'msg-abc-123' },
        'delivered',
      )
    ).resolves.not.toThrow();
  });

  it('returns the updated record when using provider+providerMessageId selector', async () => {
    const updated = mockDeliveryRecord({ status: 'delivered' });
    mockFindOneAndUpdate.mockReturnValueOnce(buildMockQuery(updated));

    const result = await updateEmailDeliveryStatus(
      { provider: 'sendgrid', providerMessageId: 'msg-abc-123' },
      'delivered',
    );

    expect(result).toEqual(updated);
  });

  it('calls bypassTenantScope on the query (not await query directly)', async () => {
    const updated = mockDeliveryRecord({ status: 'bounced' });
    const mockQuery = buildMockQuery(updated);
    const bypassSpy = jest.spyOn(mockQuery, 'bypassTenantScope');
    mockFindOneAndUpdate.mockReturnValueOnce(mockQuery);

    await updateEmailDeliveryStatus(
      { provider: 'sendgrid', providerMessageId: 'msg-abc-123' },
      'bounced',
    );

    expect(bypassSpy).toHaveBeenCalled();
  });

  it('uses the provider+providerMessageId filter (not _id)', async () => {
    const updated = mockDeliveryRecord({ status: 'opened' });
    mockFindOneAndUpdate.mockReturnValueOnce(buildMockQuery(updated));

    await updateEmailDeliveryStatus(
      { provider: 'mailgun', providerMessageId: 'msg-xyz' },
      'opened',
    );

    const callFilter = mockFindOneAndUpdate.mock.calls[0][0];
    expect(callFilter).toEqual({ provider: 'mailgun', providerMessageId: 'msg-xyz' });
    expect(callFilter).not.toHaveProperty('_id');
  });

  it('does not throw when the record is not found (returns null gracefully)', async () => {
    mockFindOneAndUpdate.mockReturnValueOnce(buildMockQuery(null));

    const result = await updateEmailDeliveryStatus(
      { provider: 'sendgrid', providerMessageId: 'nonexistent' },
      'delivered',
    );

    expect(result).toBeNull();
  });
});

// ── Student status side-effect ───────────────────────────────────────────────

describe('updateEmailDeliveryStatus — student status side-effect', () => {
  it('updates student delivery status when record has schoolId and studentId', async () => {
    const updated = mockDeliveryRecord({ status: 'delivered', deliveredAt: new Date() });
    mockFindOneAndUpdate.mockReturnValueOnce(buildMockQuery(updated));

    await updateEmailDeliveryStatus(
      { provider: 'sendgrid', providerMessageId: 'msg-abc-123' },
      'delivered',
      { deliveredAt: updated.deliveredAt },
    );

    expect(mockStudentFindOneAndUpdate).toHaveBeenCalledWith(
      { schoolId: SCHOOL_ID, studentId: STUDENT_ID },
      expect.objectContaining({
        $set: expect.objectContaining({ lastEmailDeliveryStatus: 'delivered' }),
      }),
    );
  });

  it('does not update student status when record is null', async () => {
    mockFindOneAndUpdate.mockReturnValueOnce(buildMockQuery(null));

    await updateEmailDeliveryStatus(
      { provider: 'sendgrid', providerMessageId: 'missing' },
      'delivered',
    );

    expect(mockStudentFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
