'use strict';

/**
 * Tests for transactionQueueService.
 *
 * Covers: startWorker / stopWorker lifecycle, processTransactionJob business
 * logic (skip if already processed, underpaid rejection, expired intent,
 * missing student, permanent error marking, transient error recovery),
 * and the heartbeat integration.
 *
 * The module caches a worker singleton, so each describe block that needs a
 * fresh worker loads the module in isolation via jest.isolateModules().
 */

// ── Suppress logger noise ──────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// ── transactionQueue mock ──────────────────────────────────────────────────
const mockStartTransactionWorker = jest.fn();
const mockRecoverPendingJobs     = jest.fn().mockResolvedValue();
const mockMarkResolved           = jest.fn().mockResolvedValue();
const mockMarkDead               = jest.fn().mockResolvedValue();
const mockWorkerClose            = jest.fn().mockResolvedValue();

jest.mock('../src/queue/transactionQueue', () => ({
  startTransactionWorker: (...a) => mockStartTransactionWorker(...a),
  recoverPendingJobs:     (...a) => mockRecoverPendingJobs(...a),
  markResolved:           (...a) => mockMarkResolved(...a),
  markDead:               (...a) => mockMarkDead(...a),
}));

// ── stellarService mock ───────────────────────────────────────────────────
const mockVerifyTransaction = jest.fn();
const mockRecordPayment     = jest.fn().mockResolvedValue();

jest.mock('../src/services/stellarService', () => ({
  verifyTransaction: (...a) => mockVerifyTransaction(...a),
  recordPayment:     (...a) => mockRecordPayment(...a),
}));

// ── currencyConversionService mock ────────────────────────────────────────
jest.mock('../src/services/currencyConversionService', () => ({
  captureFiatSnapshot: jest.fn().mockResolvedValue({ rate: 1.0, currency: 'USD' }),
}));

// ── Model mocks ────────────────────────────────────────────────────────────
const mockPaymentFindOne     = jest.fn();
const mockPaymentCreate      = jest.fn().mockResolvedValue({});
const mockPVFindOneAndUpdate = jest.fn().mockResolvedValue({});
const mockPIFindOne          = jest.fn();
const mockPIFindByIdAndUpdate = jest.fn().mockResolvedValue({});
const mockStudentFindOne     = jest.fn();

jest.mock('../src/models/paymentModel', () => ({
  findOne: (...a) => mockPaymentFindOne(...a),
  create:  (...a) => mockPaymentCreate(...a),
}));

jest.mock('../src/models/pendingVerificationModel', () => ({
  findOneAndUpdate: (...a) => mockPVFindOneAndUpdate(...a),
}));

jest.mock('../src/models/paymentIntentModel', () => ({
  findOne:           (...a) => mockPIFindOne(...a),
  findByIdAndUpdate: (...a) => mockPIFindByIdAndUpdate(...a),
}));

jest.mock('../src/models/studentModel', () => ({
  findOne: (...a) => mockStudentFindOne(...a),
}));

// ── correlationId util mock ───────────────────────────────────────────────
jest.mock('../src/utils/correlationId', () => ({
  resolveCorrelationId: (id, txHash) => id || txHash,
}));

// ── workerHeartbeat mock (optional, loaded dynamically) ───────────────────
jest.mock('../src/services/workerHeartbeat', () => ({
  ping:         jest.fn(),
  markStarted:  jest.fn(),
  markStopped:  jest.fn(),
  WORKER_NAMES: { TX_QUEUE_WORKER: 'tx_queue_worker' },
}));

// ── Helpers ────────────────────────────────────────────────────────────────
const SCHOOL_ID = 'school-001';
const TX_HASH   = 'tx' + 'a'.repeat(62);

function makeJob(overrides = {}) {
  return {
    data: {
      txHash:       TX_HASH,
      schoolId:     SCHOOL_ID,
      school:       { stellarAddress: 'GADDR' },
      correlationId: null,
      ...overrides,
    },
  };
}

function makeVerifyResult(overrides = {}) {
  return {
    hash:          TX_HASH,
    memo:          'STU001',
    studentId:     'STU001',
    amount:        100,
    feeAmount:     100,
    assetCode:     'XLM',
    date:          new Date().toISOString(),
    ledger:        1000,
    networkFee:    0.00001,
    senderAddress: 'GSENDER',
    feeValidation: { status: 'exact', message: 'OK', excessAmount: 0 },
    ...overrides,
  };
}

/**
 * Load a fresh isolated copy of transactionQueueService and capture the
 * processor function that startTransactionWorker is called with.
 */
function loadService() {
  let svc;
  let capturedProcessor;

  mockStartTransactionWorker.mockImplementation((fn) => {
    capturedProcessor = fn;
    return { close: mockWorkerClose };
  });

  jest.isolateModules(() => {
    svc = require('../src/services/transactionQueueService');
  });

  return {
    startWorker: svc.startWorker,
    stopWorker:  svc.stopWorker,
    get processor() { return capturedProcessor; },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStartTransactionWorker.mockImplementation((fn) => ({ close: mockWorkerClose }));
  mockPaymentFindOne.mockResolvedValue(null);
  mockPVFindOneAndUpdate.mockResolvedValue({});
  mockPIFindOne.mockResolvedValue(null);
  mockStudentFindOne.mockResolvedValue({ studentId: 'STU001', schoolId: SCHOOL_ID });
  mockVerifyTransaction.mockResolvedValue(makeVerifyResult());
  mockRecoverPendingJobs.mockResolvedValue();
});

// ── startWorker / stopWorker lifecycle ─────────────────────────────────────

describe('startWorker / stopWorker', () => {
  it('startWorker calls startTransactionWorker with a processor function', async () => {
    const { startWorker } = loadService();
    await startWorker();
    expect(mockStartTransactionWorker).toHaveBeenCalledWith(expect.any(Function));
  });

  it('startWorker is idempotent — second call returns cached worker', async () => {
    const { startWorker } = loadService();
    await startWorker();
    await startWorker();
    expect(mockStartTransactionWorker).toHaveBeenCalledTimes(1);
  });

  it('startWorker calls recoverPendingJobs on first start', async () => {
    const { startWorker } = loadService();
    await startWorker();
    expect(mockRecoverPendingJobs).toHaveBeenCalledTimes(1);
  });

  it('startWorker survives recoverPendingJobs throwing', async () => {
    mockRecoverPendingJobs.mockRejectedValue(new Error('recovery failed'));
    const { startWorker } = loadService();
    await expect(startWorker()).resolves.not.toThrow();
  });

  it('stopWorker closes the worker', async () => {
    const { startWorker, stopWorker } = loadService();
    await startWorker();
    await stopWorker();
    expect(mockWorkerClose).toHaveBeenCalled();
  });

  it('stopWorker is safe to call when no worker is running', async () => {
    const { stopWorker } = loadService();
    await expect(stopWorker()).resolves.not.toThrow();
  });
});

// ── processTransactionJob ─────────────────────────────────────────────────

describe('processTransactionJob — skip if already processed', () => {
  it('returns { skipped: true } and calls markResolved when payment already exists', async () => {
    const svc = loadService();
    await svc.startWorker();
    mockPaymentFindOne.mockResolvedValue({ txHash: TX_HASH, schoolId: SCHOOL_ID });

    const result = await svc.processor(makeJob());
    expect(result).toEqual({ skipped: true, txHash: TX_HASH });
    expect(mockMarkResolved).toHaveBeenCalledWith(TX_HASH);
    expect(mockVerifyTransaction).not.toHaveBeenCalled();
  });
});

describe('processTransactionJob — successful processing', () => {
  it('verifies, records, and resolves on success', async () => {
    const svc = loadService();
    await svc.startWorker();
    const result = await svc.processor(makeJob());
    expect(mockVerifyTransaction).toHaveBeenCalledWith(TX_HASH, 'GADDR');
    expect(mockRecordPayment).toHaveBeenCalled();
    expect(mockMarkResolved).toHaveBeenCalledWith(TX_HASH);
    expect(result.success).toBe(true);
    expect(result.txHash).toBe(TX_HASH);
  });
});

describe('processTransactionJob — underpaid rejection', () => {
  it('throws an error with code UNDERPAID and does not record payment', async () => {
    const svc = loadService();
    await svc.startWorker();
    mockVerifyTransaction.mockResolvedValue(
      makeVerifyResult({ feeValidation: { status: 'underpaid', message: 'Short by 10 XLM' } }),
    );
    await expect(svc.processor(makeJob())).rejects.toMatchObject({ code: 'UNDERPAID' });
    expect(mockRecordPayment).not.toHaveBeenCalled();
  });
});

describe('processTransactionJob — expired payment intent', () => {
  it('throws and marks intent expired when expiresAt is in the past', async () => {
    const svc = loadService();
    await svc.startWorker();
    mockPIFindOne.mockResolvedValue({
      _id: 'intent-1',
      memo: 'STU001',
      schoolId: SCHOOL_ID,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(svc.processor(makeJob())).rejects.toMatchObject({ code: 'INTENT_EXPIRED' });
    expect(mockPIFindByIdAndUpdate).toHaveBeenCalledWith('intent-1', { status: 'expired' });
  });

  it('does NOT reject when intent has not expired yet', async () => {
    const svc = loadService();
    await svc.startWorker();
    mockPIFindOne.mockResolvedValue({
      _id: 'intent-2',
      memo: 'STU001',
      schoolId: SCHOOL_ID,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await svc.processor(makeJob());
    expect(result.success).toBe(true);
  });
});

describe('processTransactionJob — student not found', () => {
  it('throws with code NOT_FOUND when student is absent', async () => {
    const svc = loadService();
    await svc.startWorker();
    mockStudentFindOne.mockResolvedValue(null);
    await expect(svc.processor(makeJob())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('processTransactionJob — verifyTransaction returns null', () => {
  it('throws with code NOT_FOUND when verify returns null', async () => {
    const svc = loadService();
    await svc.startWorker();
    mockVerifyTransaction.mockResolvedValue(null);
    await expect(svc.processor(makeJob())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ── jobProcessor — permanent error handling ────────────────────────────────

describe('jobProcessor — permanent errors', () => {
  const PERMANENT_CODES = ['TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION', 'UNSUPPORTED_ASSET'];

  it.each(PERMANENT_CODES)('marks job dead for permanent code %s', async (code) => {
    const svc = loadService();
    await svc.startWorker();
    const err = Object.assign(new Error(`permanent: ${code}`), { code });
    mockVerifyTransaction.mockRejectedValue(err);

    await expect(svc.processor(makeJob())).rejects.toMatchObject({ message: expect.stringContaining('[permanent]') });
    expect(mockMarkDead).toHaveBeenCalledWith(TX_HASH, expect.any(Error));
  });

  it('creates a FAILED payment record for a permanent error', async () => {
    const svc = loadService();
    await svc.startWorker();
    const err = Object.assign(new Error('on-chain failure'), { code: 'TX_FAILED' });
    mockVerifyTransaction.mockRejectedValue(err);

    await expect(svc.processor(makeJob())).rejects.toThrow();
    expect(mockPaymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED', txHash: TX_HASH }),
    );
  });
});

describe('jobProcessor — transient errors', () => {
  it('updates lastError but does NOT call markDead for a transient failure', async () => {
    const svc = loadService();
    await svc.startWorker();
    const err = Object.assign(new Error('network blip'), { code: 'ETIMEDOUT' });
    mockVerifyTransaction.mockRejectedValue(err);

    await expect(svc.processor(makeJob())).rejects.toThrow('network blip');
    expect(mockMarkDead).not.toHaveBeenCalled();
    expect(mockPVFindOneAndUpdate).toHaveBeenCalledWith(
      { txHash: TX_HASH },
      expect.objectContaining({ lastError: 'network blip' }),
    );
  });
});
