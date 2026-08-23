'use strict';

/**
 * Tests for bullMQRetryService.
 *
 * Covers: classifyError (delegation to retryContract), queueFailedTransaction
 * (permanent skip, transient queuing, MongoDB upsert), getHealthStatus,
 * getJobsByState (all branches including invalid state), retryJobImmediately,
 * removeJob, cleanupOldJobs, pauseQueue, resumeQueue, getJobDetails,
 * and drainWorker.
 *
 * All external dependencies are fully mocked — no real Redis/BullMQ needed.
 */

// ── Suppress logger noise ──────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// ── transactionRetryQueue mock ─────────────────────────────────────────────
const mockInitializeQueue      = jest.fn();
const mockAddToRetryQueue      = jest.fn();
const mockGetQueueStats        = jest.fn();
const mockGetDLQStats          = jest.fn();
const mockShutdownQueue        = jest.fn();
const mockDrainWorker          = jest.fn();
const mockGetWorker            = jest.fn();

// Queue operation mocks (accessed via queueInstance.queue)
const mockQueueGetJob          = jest.fn();
const mockQueueGetWaiting      = jest.fn().mockResolvedValue([]);
const mockQueueGetActive       = jest.fn().mockResolvedValue([]);
const mockQueueGetCompleted    = jest.fn().mockResolvedValue([]);
const mockQueueGetFailed       = jest.fn().mockResolvedValue([]);
const mockQueueGetDelayed      = jest.fn().mockResolvedValue([]);
const mockQueueClean           = jest.fn().mockResolvedValue(5);
const mockQueuePause           = jest.fn().mockResolvedValue();
const mockQueueResume          = jest.fn().mockResolvedValue();

const mockQueue = {
  getJob:       (...a) => mockQueueGetJob(...a),
  getWaiting:   (...a) => mockQueueGetWaiting(...a),
  getActive:    (...a) => mockQueueGetActive(...a),
  getCompleted: (...a) => mockQueueGetCompleted(...a),
  getFailed:    (...a) => mockQueueGetFailed(...a),
  getDelayed:   (...a) => mockQueueGetDelayed(...a),
  clean:        (...a) => mockQueueClean(...a),
  pause:        (...a) => mockQueuePause(...a),
  resume:       (...a) => mockQueueResume(...a),
};

const QUEUE_NAMES = { RETRY: 'tx-retry', DLQ: 'tx-dlq' };

jest.mock('../src/queue/transactionRetryQueue', () => ({
  initializeQueue:        (...a) => mockInitializeQueue(...a),
  addTransactionToRetryQueue: (...a) => mockAddToRetryQueue(...a),
  getQueueStats:          (...a) => mockGetQueueStats(...a),
  getDLQStats:            (...a) => mockGetDLQStats(...a),
  shutdownQueue:          (...a) => mockShutdownQueue(...a),
  drainWorker:            (...a) => mockDrainWorker(...a),
  getWorker:              (...a) => mockGetWorker(...a),
  config:                 { worker: { concurrency: 5 } },
  QUEUE_NAMES,
}));

// ── PendingVerification mock ───────────────────────────────────────────────
const mockPVFindOneAndUpdate = jest.fn().mockResolvedValue({});
const mockPVAggregate        = jest.fn().mockReturnValue({
  option: jest.fn().mockResolvedValue([{ _id: 'queued', count: 2 }]),
});

jest.mock('../src/models/pendingVerificationModel', () => ({
  findOneAndUpdate: (...a) => mockPVFindOneAndUpdate(...a),
  aggregate:        (...a) => mockPVAggregate(...a),
}));

// ── Load the module under test ─────────────────────────────────────────────
const svc = require('../src/services/bullMQRetryService');

// ── Shared mock queue instance setup ──────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();

  // initializeQueue sets up the singleton; return an object with .queue
  mockInitializeQueue.mockResolvedValue({ queue: mockQueue });
  mockAddToRetryQueue.mockResolvedValue({ id: 'job-1' });

  mockGetQueueStats.mockResolvedValue({
    health: 'healthy',
    metrics: { totalJobs: 10, failedJobs: 1 },
  });
  mockGetDLQStats.mockResolvedValue({
    metrics: { failed: 0 },
  });
  mockDrainWorker.mockResolvedValue({ drained: true, activeJobs: 0, requeuedJobs: 0 });
});

// ── classifyError ──────────────────────────────────────────────────────────

describe('classifyError', () => {
  it('returns "permanent" for TX_FAILED', () => {
    expect(svc.classifyError({ code: 'TX_FAILED' })).toBe('permanent');
  });

  it('returns "permanent" for MISSING_MEMO', () => {
    expect(svc.classifyError({ code: 'MISSING_MEMO' })).toBe('permanent');
  });

  it('returns "permanent" for DUPLICATE_TX', () => {
    expect(svc.classifyError({ code: 'DUPLICATE_TX' })).toBe('permanent');
  });

  it('returns "transient" for ETIMEDOUT', () => {
    expect(svc.classifyError({ code: 'ETIMEDOUT' })).toBe('transient');
  });

  it('returns "transient" for STELLAR_NETWORK_ERROR', () => {
    expect(svc.classifyError({ code: 'STELLAR_NETWORK_ERROR' })).toBe('transient');
  });

  it('returns "transient" for an error message matching a pattern', () => {
    expect(svc.classifyError({ message: 'temporary network blip' })).toBe('transient');
  });

  it('returns "unknown" for an unrecognised code', () => {
    expect(svc.classifyError({ code: 'SOMETHING_RANDOM' })).toBe('unknown');
  });

  it('returns "unknown" for null input', () => {
    expect(svc.classifyError(null)).toBe('unknown');
  });
});

// ── queueFailedTransaction ─────────────────────────────────────────────────

describe('queueFailedTransaction', () => {
  it('does NOT queue a permanent error — returns queued: false', async () => {
    const result = await svc.queueFailedTransaction('tx-perm', {
      error: { code: 'TX_FAILED', message: 'on-chain failure' },
    });
    expect(result.queued).toBe(false);
    expect(result.reason).toBe('permanent_error');
    expect(mockAddToRetryQueue).not.toHaveBeenCalled();
  });

  it('queues a transient error and returns queued: true', async () => {
    const result = await svc.queueFailedTransaction('tx-trans', {
      studentId: 'STU001',
      error: { code: 'ETIMEDOUT', message: 'timeout' },
    });
    expect(result.queued).toBe(true);
    expect(result.jobId).toBe('job-1');
    expect(mockAddToRetryQueue).toHaveBeenCalledWith(
      'tx-trans',
      'STU001',
      expect.objectContaining({ errorType: 'transient' }),
    );
  });

  it('creates a PendingVerification upsert for transient errors', async () => {
    await svc.queueFailedTransaction('tx-pv', {
      studentId: 'STU002',
      error: { code: 'ETIMEDOUT', message: 'timeout' },
    });
    expect(mockPVFindOneAndUpdate).toHaveBeenCalledWith(
      { txHash: 'tx-pv' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'queued' }),
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  it('queues an unknown error', async () => {
    const result = await svc.queueFailedTransaction('tx-unk', {
      error: { code: 'WEIRD_CODE', message: 'strange' },
    });
    expect(result.queued).toBe(true);
    expect(result.errorType).toBe('unknown');
  });

  it('queues without an error object (error is undefined)', async () => {
    const result = await svc.queueFailedTransaction('tx-noerr', {});
    expect(result.queued).toBe(true);
    expect(result.errorType).toBe('unknown');
  });

  it('propagates exceptions from addTransactionToRetryQueue', async () => {
    mockAddToRetryQueue.mockRejectedValue(new Error('Redis down'));
    await expect(
      svc.queueFailedTransaction('tx-fail', { error: { code: 'ETIMEDOUT' } }),
    ).rejects.toThrow('Redis down');
  });
});

// ── getRetryQueueStats ─────────────────────────────────────────────────────

describe('getRetryQueueStats', () => {
  it('returns combined bullmq, deadLetter, and mongodb stats', async () => {
    const stats = await svc.getRetryQueueStats();
    expect(stats.bullmq).toBeDefined();
    expect(stats.deadLetter).toBeDefined();
    expect(stats.mongodb).toBeDefined();
    expect(stats.systemHealth.queueHealth).toBe('healthy');
  });

  it('throws when getQueueStats throws', async () => {
    mockGetQueueStats.mockRejectedValue(new Error('Redis unavailable'));
    await expect(svc.getRetryQueueStats()).rejects.toThrow('Redis unavailable');
  });
});

// ── getHealthStatus ────────────────────────────────────────────────────────

describe('getHealthStatus', () => {
  it('returns healthy: true when queue is healthy', async () => {
    const health = await svc.getHealthStatus();
    expect(health.healthy).toBe(true);
    expect(health.status).toBe('healthy');
    expect(health.details.redis).toBe('connected');
  });

  it('returns healthy: false with error message when stats throws', async () => {
    mockGetQueueStats.mockRejectedValue(new Error('catastrophic'));
    const health = await svc.getHealthStatus();
    expect(health.healthy).toBe(false);
    expect(health.status).toBe('unhealthy');
    expect(health.error).toBeDefined();
  });
});

// ── getJobsByState ─────────────────────────────────────────────────────────

describe('getJobsByState', () => {
  const MOCK_JOB = {
    id: 'j1',
    data: { transactionHash: 'tx-abc' },
    attemptsMade: 1,
    timestamp: Date.now(),
  };

  it.each(['waiting', 'active', 'completed', 'failed', 'delayed'])(
    'returns jobs for state "%s"', async (state) => {
      const getterMap = {
        waiting:   mockQueueGetWaiting,
        active:    mockQueueGetActive,
        completed: mockQueueGetCompleted,
        failed:    mockQueueGetFailed,
        delayed:   mockQueueGetDelayed,
      };
      getterMap[state].mockResolvedValue([MOCK_JOB]);

      const jobs = await svc.getJobsByState(state);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe('j1');
      expect(jobs[0].transactionHash).toBe('tx-abc');
    },
  );

  it('throws for an invalid state', async () => {
    await expect(svc.getJobsByState('invalid-state')).rejects.toThrow('Invalid state');
  });
});

// ── getJobDetails ──────────────────────────────────────────────────────────

describe('getJobDetails', () => {
  it('returns job details for a found job', async () => {
    const mockJob = {
      id: 'j99',
      data: { transactionHash: 'tx-detail' },
      getState: jest.fn().mockResolvedValue('waiting'),
      progress: 0,
      returnvalue: null,
      failedReason: null,
      attemptsMade: 0,
      opts: { attempts: 10 },
      timestamp: Date.now(),
      processedOn: null,
      finishedOn: null,
    };
    mockQueueGetJob.mockResolvedValue(mockJob);

    const details = await svc.getJobDetails('j99');
    expect(details.jobId).toBe('j99');
    expect(details.transactionHash).toBe('tx-detail');
    expect(details.state).toBe('waiting');
  });

  it('throws with code NOT_FOUND when job does not exist', async () => {
    mockQueueGetJob.mockResolvedValue(null);
    await expect(svc.getJobDetails('missing-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ── retryJobImmediately ────────────────────────────────────────────────────

describe('retryJobImmediately', () => {
  it('retries a failed job', async () => {
    const mockJob = {
      id: 'j-fail',
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(),
    };
    mockQueueGetJob.mockResolvedValue(mockJob);

    const result = await svc.retryJobImmediately('j-fail');
    expect(result.success).toBe(true);
    expect(mockJob.retry).toHaveBeenCalled();
  });

  it('throws with code VALIDATION_ERROR when job is not in failed state', async () => {
    const mockJob = {
      id: 'j-active',
      getState: jest.fn().mockResolvedValue('active'),
    };
    mockQueueGetJob.mockResolvedValue(mockJob);

    await expect(svc.retryJobImmediately('j-active')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws with NOT_FOUND when job does not exist', async () => {
    mockQueueGetJob.mockResolvedValue(null);
    await expect(svc.retryJobImmediately('no-job')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ── removeJob ──────────────────────────────────────────────────────────────

describe('removeJob', () => {
  it('removes an existing job', async () => {
    const mockJob = { id: 'j-rm', remove: jest.fn().mockResolvedValue() };
    mockQueueGetJob.mockResolvedValue(mockJob);

    const result = await svc.removeJob('j-rm');
    expect(result.success).toBe(true);
    expect(mockJob.remove).toHaveBeenCalled();
  });

  it('throws with NOT_FOUND when job does not exist', async () => {
    mockQueueGetJob.mockResolvedValue(null);
    await expect(svc.removeJob('ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ── cleanupOldJobs ────────────────────────────────────────────────────────

describe('cleanupOldJobs', () => {
  it('calls queue.clean and returns count', async () => {
    mockQueueClean.mockResolvedValue(7);
    const result = await svc.cleanupOldJobs(86400000);
    expect(result.cleaned).toBe(7);
    expect(result.maxAge).toBe(86400000);
    expect(mockQueueClean).toHaveBeenCalledWith(86400000, 1000, 'completed');
  });
});

// ── pauseQueue / resumeQueue ───────────────────────────────────────────────

describe('pauseQueue', () => {
  it('pauses the queue and returns success', async () => {
    const result = await svc.pauseQueue();
    expect(result.success).toBe(true);
    expect(result.paused).toBe(true);
    expect(mockQueuePause).toHaveBeenCalled();
  });
});

describe('resumeQueue', () => {
  it('resumes the queue and returns success', async () => {
    const result = await svc.resumeQueue();
    expect(result.success).toBe(true);
    expect(result.paused).toBe(false);
    expect(mockQueueResume).toHaveBeenCalled();
  });
});

// ── drainWorker ───────────────────────────────────────────────────────────

describe('drainWorker', () => {
  it('delegates to transactionRetryQueue.drainWorker when getWorker is defined', async () => {
    mockGetWorker.mockReturnValue({});
    mockDrainWorker.mockResolvedValue({ drained: true, activeJobs: 0, requeuedJobs: 0 });
    const result = await svc.drainWorker();
    expect(result.drained).toBe(true);
  });

  it('returns a default drained result when getWorker is not defined', async () => {
    // Override: getWorker is not a function in the module mock
    const transactionRetryQueue = require('../src/queue/transactionRetryQueue');
    const originalGetWorker = transactionRetryQueue.getWorker;
    transactionRetryQueue.getWorker = undefined;

    const result = await svc.drainWorker();
    expect(result.drained).toBe(true);
    expect(result.activeJobs).toBe(0);

    transactionRetryQueue.getWorker = originalGetWorker;
  });
});
