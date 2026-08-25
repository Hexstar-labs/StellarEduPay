'use strict';

/**
 * Unit tests for transactionManager.js
 *
 * Acceptance criteria (from the bug report):
 *  - startSession() returns a session with an active transaction
 *    (i.e. session.startTransaction() is called before the session is returned)
 *  - withTransaction() delegates the transaction lifecycle to the driver's
 *    session.withTransaction() instead of hand-rolling start/commit/abort
 *  - withTransaction() opens a FRESH SESSION per retry attempt — a retried
 *    operation is never re-run on an already-aborted transaction
 *  - a TransientTransactionError on the first attempt is recovered: the second
 *    attempt commits successfully
 *  - isRetryableError() honours ONLY driver error labels and explicit numeric
 *    codes; it never matches error-message substrings, so a non-transient
 *    error whose message merely contains the word "transaction" is NOT retried
 */

// ─── Env ─────────────────────────────────────────────────────────────────────
process.env.MONGO_URI  = 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = 'test-tx-manager-secret';

// ─── Fake session factory ─────────────────────────────────────────────────────
// Mirrors the real MongoDB driver ClientSession API that TransactionManager uses.
// A fresh instance is constructed for every test so calls never bleed between tests.
function makeSession() {
  return {
    startTransaction:  jest.fn(),                            // synchronous in the driver
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    abortTransaction:  jest.fn().mockResolvedValue(undefined),
    endSession:        jest.fn().mockResolvedValue(undefined),
  };
}

// A session that implements the driver's session.withTransaction() contract
// (see the drivers specification): starts a transaction, runs the callback,
// commits; on a TransientTransactionError it aborts and re-runs the callback
// ONCE more on a fresh transaction within the same session; on any other
// error it aborts and propagates immediately. This is exactly how the real
// driver behaves — TransactionManager must be able to rely on it.
function makeDriverSession() {
  const s = makeSession();
  s.withTransaction = jest.fn(async (fn) => {
    let attempts = 0;
    for (;;) {
      attempts++;
      s.startTransaction();
      try {
        const result = await fn(s);
        await s.commitTransaction();
        return result;
      } catch (error) {
        await s.abortTransaction();
        const transient =
          typeof error?.hasErrorLabel === 'function' &&
          error.hasErrorLabel('TransientTransactionError');
        if (transient && attempts < 2) continue;
        throw error;
      }
    }
  });
  return s;
}

function transientError(message = 'WriteConflict during plan execution') {
  const err = new Error(message);
  err.hasErrorLabel = (label) => label === 'TransientTransactionError';
  err.code = 112; // WriteConflict
  return err;
}

// ─── Connection stub ─────────────────────────────────────────────────────────
// TransactionManager calls getConnection().startSession(). We expose a single
// shared stub object so beforeEach can swap out startSession freely.
const mockConnection = {
  startSession: jest.fn(),
};

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../backend/src/utils/logger', () => {
  const noop = () => {};
  const log  = { info: noop, warn: noop, error: noop, debug: noop };
  // transactionManager.js uses `const { logger } = require('../utils/logger')`
  return { logger: Object.assign(log, { child: () => log }) };
});

// database.js is the only external dependency TransactionManager actually calls
// at runtime (getConnection() and TRANSACTION_CONFIG). Mock it entirely so no
// real mongoose/DB is needed.
jest.mock('../backend/src/config/database', () => ({
  // Return the connection stub defined above — the variable is in scope because
  // this factory runs at require-time (post-hoist), not at parse-time.
  getConnection: () => mockConnection,
  TRANSACTION_CONFIG: {
    readConcern:         'majority',
    writeConcern:        1,
    journal:             false,
    transactionTimeoutMs: 30000,
  },
}));

// VersionCounter uses mongoose.model() — stub the whole module so it never
// touches a real DB. TransactionManager doesn't call VersionCounter from
// withTransaction/commitTransaction/abortTransaction paths, but it's imported
// at module load time.
// { virtual: true } is required because mongoose is not installed at the root
// (it lives in backend/node_modules which is also absent in the CI environment).
jest.mock('mongoose', () => ({
  Schema: class {
    constructor() {}
    index() { return this; }
  },
  model:  (name, schema) => ({ findOneAndUpdate: jest.fn(), updateMany: jest.fn(), findOne: jest.fn() }),
  models: {},
}), { virtual: true });

// Also intercept backend's private require path for the same module.
jest.mock('../backend/node_modules/mongoose', () => jest.requireMock('mongoose'), { virtual: true });

// ─── Subject ──────────────────────────────────────────────────────────────────
const {
  TransactionManager,
} = require('../backend/src/services/transactionManager');

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Build an isolated TransactionManager for each test so state doesn't bleed.
function makeTM(opts) {
  return new TransactionManager(opts);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('startSession()', () => {
  let session;

  beforeEach(() => {
    session = makeSession();
    mockConnection.startSession = jest.fn().mockResolvedValue(session);
  });

  test('calls connection.startSession()', async () => {
    const tm = makeTM();
    await tm.startSession();
    expect(mockConnection.startSession).toHaveBeenCalledTimes(1);
  });

  test('calls session.startTransaction() before returning', async () => {
    const tm = makeTM();
    await tm.startSession();
    expect(session.startTransaction).toHaveBeenCalledTimes(1);
  });

  test('passes DEFAULT_TRANSACTION_OPTIONS to startTransaction()', async () => {
    const tm = makeTM();
    await tm.startSession();
    const [opts] = session.startTransaction.mock.calls[0];
    expect(opts).toMatchObject({
      readConcern:    { level: 'majority' },
      writeConcern:   expect.objectContaining({ w: 1 }),
      readPreference: 'primary',
    });
  });

  test('returns an object with the session and a numeric transactionId', async () => {
    const tm = makeTM();
    const result = await tm.startSession();
    expect(result.session).toBe(session);
    expect(typeof result.transactionId).toBe('number');
  });

  test('registers the transaction in activeTransactions', async () => {
    const tm = makeTM();
    await tm.startSession();
    expect(tm.getActiveTransactionCount()).toBe(1);
  });

  test('increments transactionId for each call', async () => {
    const tm = makeTM();
    const s2 = makeSession();
    mockConnection.startSession
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(s2);
    const { transactionId: id1 } = await tm.startSession();
    const { transactionId: id2 } = await tm.startSession();
    expect(id2).toBe(id1 + 1);
  });
});

describe('commitTransaction()', () => {
  let session;

  beforeEach(() => {
    session = makeSession();
    mockConnection.startSession = jest.fn().mockResolvedValue(session);
  });

  test('calls session.commitTransaction()', async () => {
    const tm = makeTM();
    const { session: s, transactionId } = await tm.startSession();
    await tm.commitTransaction(s, transactionId);
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
  });

  test('calls session.endSession() after committing', async () => {
    const tm = makeTM();
    const { session: s, transactionId } = await tm.startSession();
    await tm.commitTransaction(s, transactionId);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  test('removes the transaction from activeTransactions', async () => {
    const tm = makeTM();
    const { session: s, transactionId } = await tm.startSession();
    expect(tm.getActiveTransactionCount()).toBe(1);
    await tm.commitTransaction(s, transactionId);
    expect(tm.getActiveTransactionCount()).toBe(0);
  });

  test('throws INVALID_TRANSACTION when transactionId is unknown', async () => {
    const tm = makeTM();
    const { session: s } = await tm.startSession();
    await expect(tm.commitTransaction(s, 99999)).rejects.toMatchObject({
      code: 'INVALID_TRANSACTION',
    });
  });

  test('returns { success: true } on successful commit', async () => {
    const tm = makeTM();
    const { session: s, transactionId } = await tm.startSession();
    const result = await tm.commitTransaction(s, transactionId);
    expect(result.success).toBe(true);
  });
});

describe('abortTransaction()', () => {
  let session;

  beforeEach(() => {
    session = makeSession();
    mockConnection.startSession = jest.fn().mockResolvedValue(session);
  });

  test('calls session.abortTransaction()', async () => {
    const tm = makeTM();
    const { session: s, transactionId } = await tm.startSession();
    await tm.abortTransaction(s, transactionId);
    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
  });

  test('calls session.endSession() after aborting', async () => {
    const tm = makeTM();
    const { session: s, transactionId } = await tm.startSession();
    await tm.abortTransaction(s, transactionId);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  test('removes the transaction from activeTransactions', async () => {
    const tm = makeTM();
    const { session: s, transactionId } = await tm.startSession();
    await tm.abortTransaction(s, transactionId);
    expect(tm.getActiveTransactionCount()).toBe(0);
  });

  test('returns { success: true } on successful abort', async () => {
    const tm = makeTM();
    const { session: s, transactionId } = await tm.startSession();
    const result = await tm.abortTransaction(s, transactionId);
    expect(result.success).toBe(true);
  });
});

describe('isRetryableError()', () => {
  test('retries when the error carries the TransientTransactionError label', () => {
    const tm = makeTM();
    const err = new Error('whatever');
    err.hasErrorLabel = (l) => l === 'TransientTransactionError';
    expect(tm.isRetryableError(err)).toBe(true);
  });

  test('retries when the error carries the UnknownTransactionCommitResult label', () => {
    const tm = makeTM();
    const err = new Error('whatever');
    err.hasErrorLabel = (l) => l === 'UnknownTransactionCommitResult';
    expect(tm.isRetryableError(err)).toBe(true);
  });

  test.each([112, 189, 261])('retries explicit transient server code %i', (code) => {
    const tm = makeTM();
    expect(tm.isRetryableError({ code })).toBe(true);
  });

  test('does NOT retry an error whose message merely contains "transaction"', () => {
    const tm = makeTM();
    const err = new Error('cannot infer query fields in transaction');
    expect(tm.isRetryableError(err)).toBe(false);
  });

  test('does NOT retry an error whose message merely contains "Lock"', () => {
    const tm = makeTM();
    expect(tm.isRetryableError(new Error('LockBusy: collection is locked'))).toBe(false);
  });

  test('does NOT retry an error whose message contains "WriteConflict" without label or code', () => {
    const tm = makeTM();
    expect(tm.isRetryableError(new Error('WriteConflict in plan executor'))).toBe(false);
  });

  test('does NOT retry a message that literally says "TransientTransactionError" without the label', () => {
    const tm = makeTM();
    const err = new Error('TransientTransactionError occurred'); // text only — no label fn
    expect(tm.isRetryableError(err)).toBe(false);
  });

  test('does not retry generic errors', () => {
    const tm = makeTM();
    expect(tm.isRetryableError(new Error('validation failed'))).toBe(false);
  });

  test('handles null/undefined without throwing', () => {
    const tm = makeTM();
    expect(tm.isRetryableError(null)).toBe(false);
    expect(tm.isRetryableError(undefined)).toBe(false);
  });
});

describe('withTransaction()', () => {
  beforeEach(() => {
    mockConnection.startSession = jest.fn().mockResolvedValue(makeDriverSession());
  });

  test('delegates the transaction lifecycle to session.withTransaction()', async () => {
    const tm = makeTM();
    const session = makeDriverSession();
    mockConnection.startSession.mockResolvedValueOnce(session);

    await tm.withTransaction(async () => 'ok');

    expect(session.withTransaction).toHaveBeenCalledTimes(1);
  });

  test('passes the session to the operation callback', async () => {
    const tm = makeTM();
    const session = makeDriverSession();
    mockConnection.startSession.mockResolvedValueOnce(session);

    let receivedSession;
    await tm.withTransaction(async (sess) => { receivedSession = sess; });
    expect(receivedSession).toBe(session);
  });

  test('returns the value produced by the operation', async () => {
    const tm = makeTM();
    const result = await tm.withTransaction(async () => ({ data: 42 }));
    expect(result).toEqual({ data: 42 });
  });

  test('ends the session after a successful run', async () => {
    const tm = makeTM();
    const session = makeDriverSession();
    mockConnection.startSession.mockResolvedValueOnce(session);

    await tm.withTransaction(async () => 'ok');

    expect(session.endSession).toHaveBeenCalledTimes(1);
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
    expect(session.abortTransaction).not.toHaveBeenCalled();
  });

  test('ends the session after a failed run and re-throws the original error', async () => {
    const tm = makeTM({ maxRetries: 1 });
    const session = makeDriverSession();
    mockConnection.startSession.mockResolvedValueOnce(session);

    const boom = new Error('boom');
    await expect(tm.withTransaction(async () => { throw boom; })).rejects.toBe(boom);

    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  test('leaves no active transactions after success or failure', async () => {
    const tm = makeTM({ maxRetries: 1 });
    await tm.withTransaction(async () => {});
    expect(tm.getActiveTransactionCount()).toBe(0);

    await expect(
      tm.withTransaction(async () => { throw new Error('err'); })
    ).rejects.toThrow();
    expect(tm.getActiveTransactionCount()).toBe(0);
  });

  // ── Acceptance criterion: transient error on attempt #1, commit on #2 ──

  test('recovers from a TransientTransactionError on the first attempt', async () => {
    const tm = makeTM();
    const session = makeDriverSession(); // driver-level retry, same session, fresh transaction
    mockConnection.startSession.mockResolvedValueOnce(session);

    let attempts = 0;
    const result = await tm.withTransaction(async () => {
      attempts++;
      if (attempts === 1) throw transientError();
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(2);
    // The driver started TWO transactions inside withTransaction…
    expect(session.startTransaction).toHaveBeenCalledTimes(2);
    // …aborted the first…
    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
    // …and committed the second.
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
  });

  test('opens a FRESH SESSION for each outer retry once the driver retry is exhausted', async () => {
    const tm = makeTM({ maxRetries: 3, retryDelayMs: 1 });
    const deadSession   = makeDriverSession(); // both driver-internal attempts fail
    const healthySession = makeDriverSession();
    mockConnection.startSession
      .mockResolvedValueOnce(deadSession)
      .mockResolvedValueOnce(healthySession);

    let calls = 0;
    const result = await tm.withTransaction(async () => {
      calls++;
      if (calls <= 2) throw transientError();
      return 'recovered';
    });

    expect(result).toBe('recovered');
    // Two distinct sessions were opened — the retried operation was never
    // re-run against the aborted first session.
    expect(mockConnection.startSession).toHaveBeenCalledTimes(2);
    expect(deadSession.endSession).toHaveBeenCalledTimes(1);
    expect(healthySession.endSession).toHaveBeenCalledTimes(1);
    expect(healthySession.commitTransaction).toHaveBeenCalledTimes(1);
  });

  test('does NOT retry a non-transient error even when its message mentions "transaction"', async () => {
    const tm = makeTM({ maxRetries: 3 });
    const session = makeDriverSession();
    mockConnection.startSession.mockResolvedValueOnce(session);

    const nonTransient = new Error('cannot infer query fields in transaction');
    let calls = 0;
    await expect(
      tm.withTransaction(async () => { calls++; throw nonTransient; })
    ).rejects.toBe(nonTransient);

    expect(calls).toBe(1);                              // no second attempt
    expect(mockConnection.startSession).toHaveBeenCalledTimes(1); // no new session opened
  });

  test('throws the ORIGINAL error after exhausting retries (labels preserved)', async () => {
    const tm = makeTM({ maxRetries: 2, retryDelayMs: 1 });
    const session = makeDriverSession();
    mockConnection.startSession.mockResolvedValue(session);

    const original = transientError('WriteConflict during plan execution and update');
    let calls = 0;
    await expect(
      tm.withTransaction(async () => { calls++; throw original; })
    ).rejects.toBe(original);

    // 2 sessions × up to 2 driver-internal attempts each
    expect(calls).toBe(4);
    expect(mockConnection.startSession).toHaveBeenCalledTimes(2);
  });
});
