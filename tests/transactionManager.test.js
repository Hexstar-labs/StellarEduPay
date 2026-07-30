'use strict';

/**
 * Unit tests for transactionManager.js
 *
 * Acceptance criteria (from the bug report):
 *  - startSession() returns a session with an active transaction
 *    (i.e. session.startTransaction() is called before the session is returned)
 *  - withTransaction() commits the session when the operation succeeds
 *  - withTransaction() aborts the session when the operation throws
 *  - commitTransaction() and abortTransaction() succeed when a transaction is
 *    active (i.e. startTransaction was already called)
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

describe('withTransaction()', () => {
  let session;

  beforeEach(() => {
    session = makeSession();
    mockConnection.startSession = jest.fn().mockResolvedValue(session);
  });

  test('calls startTransaction() before invoking the operation', async () => {
    const tm = makeTM();
    let startedBeforeOp = false;
    await tm.withTransaction(async () => {
      startedBeforeOp = session.startTransaction.mock.calls.length === 1;
    });
    expect(startedBeforeOp).toBe(true);
  });

  test('passes the session to the operation callback', async () => {
    const tm = makeTM();
    let receivedSession;
    await tm.withTransaction(async (sess) => { receivedSession = sess; });
    expect(receivedSession).toBe(session);
  });

  test('commits the session when the operation succeeds', async () => {
    const tm = makeTM();
    await tm.withTransaction(async () => 'ok');
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
    expect(session.abortTransaction).not.toHaveBeenCalled();
  });

  test('returns the value produced by the operation', async () => {
    const tm = makeTM();
    const result = await tm.withTransaction(async () => ({ data: 42 }));
    expect(result).toEqual({ data: 42 });
  });

  test('aborts the session when the operation throws', async () => {
    const tm = makeTM();
    await expect(
      tm.withTransaction(async () => { throw new Error('operation failed'); })
    ).rejects.toThrow('operation failed');
    expect(session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(session.commitTransaction).not.toHaveBeenCalled();
  });

  test('re-throws the original error after aborting', async () => {
    const tm = makeTM();
    const boom = new Error('boom');
    await expect(tm.withTransaction(async () => { throw boom; })).rejects.toBe(boom);
  });

  test('leaves no active transactions after a successful run', async () => {
    const tm = makeTM();
    await tm.withTransaction(async () => {});
    expect(tm.getActiveTransactionCount()).toBe(0);
  });

  test('leaves no active transactions after a failed run', async () => {
    const tm = makeTM();
    await expect(
      tm.withTransaction(async () => { throw new Error('err'); })
    ).rejects.toThrow();
    expect(tm.getActiveTransactionCount()).toBe(0);
  });

  test('retries on TransientTransactionError and eventually succeeds', async () => {
    const tm = makeTM({ maxRetries: 3 });
    let attempts = 0;

    const failSession = makeSession();
    const okSession   = makeSession();
    mockConnection.startSession
      .mockResolvedValueOnce(failSession)
      .mockResolvedValueOnce(okSession);

    const transientErr      = new Error('TransientTransactionError occurred');
    transientErr.hasErrorLabel = (label) => label === 'TransientTransactionError';

    const result = await tm.withTransaction(async () => {
      attempts++;
      if (attempts === 1) throw transientErr;
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });
});
