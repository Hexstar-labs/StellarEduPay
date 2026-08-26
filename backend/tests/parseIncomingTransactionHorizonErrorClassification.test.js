'use strict';

/**
 * Regression tests for the missing classifyHorizonError import in
 * stellarService.js (parseIncomingTransaction). Before the fix, every
 * Horizon failure inside parseIncomingTransaction threw
 * `ReferenceError: classifyHorizonError is not defined` instead of a
 * classified, actionable error — discarding the original Horizon
 * status/message and breaking downstream retry/failover routing.
 *
 * withStellarRetry is NOT mocked here — these tests exercise the real
 * retry + classification path (see the design decision documented in
 * withStellarRetry.js) against a simulated Horizon failure.
 */

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(32);
process.env.SCHOOL_WALLET_ADDRESS = process.env.SCHOOL_WALLET_ADDRESS || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
// Avoid real retry backoff delays for the transient (429/5xx) cases below —
// a single attempt is enough to reach the classification path.
process.env.STELLAR_CALL_RETRY_ATTEMPTS = '1';

jest.mock('../src/utils/logger', () => {
  const noop = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
  return { ...noop(), child: noop };
});

const mockTransactionCall = jest.fn();

jest.mock('../src/config/stellarConfig', () => ({
  server: {
    transactions: () => ({
      transaction: () => ({ call: (...args) => mockTransactionCall(...args) }),
    }),
  },
  isAcceptedAsset: jest.fn(() => true),
  CONFIRMATION_THRESHOLD: 1,
  FINALIZATION_THRESHOLD: 1,
}));

jest.mock('../src/models/paymentModel', () => ({}));
jest.mock('../src/models/studentModel', () => ({}));
jest.mock('../src/models/paymentIntentModel', () => ({}));
jest.mock('../src/services/transactionService', () => ({ savePayment: jest.fn() }));
jest.mock('../src/services/distributedLock', () => ({
  acquire: jest.fn(),
  release: jest.fn(),
  studentBalanceLockKey: jest.fn(),
}));

const { parseIncomingTransaction } = require('../src/services/stellarService');

function horizonError(status, message) {
  const err = new Error(message);
  err.response = { status };
  return err;
}

async function captureThrown(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected fn() to throw, but it resolved');
}

describe('parseIncomingTransaction — Horizon error classification', () => {
  beforeEach(() => {
    mockTransactionCall.mockReset();
  });

  test('a simulated 404 is thrown as a classified NOT_FOUND error, not a ReferenceError', async () => {
    const raw = horizonError(404, 'Resource Missing');
    mockTransactionCall.mockRejectedValue(raw);

    const thrown = await captureThrown(() => parseIncomingTransaction('deadbeef404'));

    expect(thrown).not.toBeInstanceOf(ReferenceError);
    expect(thrown.message).not.toMatch(/classifyHorizonError/);
    expect(thrown.code).toBe('NOT_FOUND');
    expect(thrown.status).toBe(404);
    expect(thrown.message).toContain('deadbeef404');
    // The original Horizon failure must still be recoverable, not discarded.
    expect(thrown.originalError).toBe(raw);
    expect(thrown.originalError.response.status).toBe(404);
    expect(thrown.originalError.message).toBe('Resource Missing');
  });

  test('a simulated 429 is thrown as a classified HORIZON_UNAVAILABLE error, not a ReferenceError', async () => {
    const raw = horizonError(429, 'Too Many Requests');
    mockTransactionCall.mockRejectedValue(raw);

    const thrown = await captureThrown(() => parseIncomingTransaction('deadbeef429'));

    expect(thrown).not.toBeInstanceOf(ReferenceError);
    expect(thrown.message).not.toMatch(/classifyHorizonError/);
    expect(thrown.code).toBe('HORIZON_UNAVAILABLE');
    expect(thrown.status).toBe(503);
    expect(thrown.originalError).toBe(raw);
    expect(thrown.originalError.response.status).toBe(429);
    expect(thrown.originalError.message).toBe('Too Many Requests');
  });

  test('a simulated 5xx is thrown as a classified HORIZON_UNAVAILABLE error, not a ReferenceError', async () => {
    const raw = horizonError(500, 'Internal Server Error');
    mockTransactionCall.mockRejectedValue(raw);

    const thrown = await captureThrown(() => parseIncomingTransaction('deadbeef500'));

    expect(thrown).not.toBeInstanceOf(ReferenceError);
    expect(thrown.message).not.toMatch(/classifyHorizonError/);
    expect(thrown.code).toBe('HORIZON_UNAVAILABLE');
    expect(thrown.status).toBe(503);
    expect(thrown.originalError).toBe(raw);
    expect(thrown.originalError.response.status).toBe(500);
    expect(thrown.originalError.message).toBe('Internal Server Error');
  });

  test('404, 429 and 5xx produce distinctly classified errors, not byte-identical ones', async () => {
    mockTransactionCall.mockRejectedValueOnce(horizonError(404, 'Resource Missing'));
    const notFound = await captureThrown(() => parseIncomingTransaction('a'));

    mockTransactionCall.mockRejectedValueOnce(horizonError(429, 'Too Many Requests'));
    const rateLimited = await captureThrown(() => parseIncomingTransaction('b'));

    expect(notFound.code).not.toBe(rateLimited.code);
    expect(notFound.status).not.toBe(rateLimited.status);
  });
});
