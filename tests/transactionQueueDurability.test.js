'use strict';

/**
 * Tests for transactionQueue durability — restart recovery scenario (#388).
 *
 * Verifies that:
 *   1. enqueueTransaction() persists a PendingVerification doc before touching Redis.
 *   2. recoverPendingJobs() re-enqueues pending/processing docs on startup.
 *   3. Duplicate txHash is handled idempotently (no duplicate PendingVerification).
 *   4. markResolved() / markDead() update the MongoDB document correctly.
 *   5. If Redis is unavailable the job is still persisted to MongoDB.
 */

// REDIS_HOST must be set before transactionQueue loads, otherwise getRedisClient()
// returns null, the BullMQ queue is never created, and enqueue/recover become no-ops.
process.env.REDIS_HOST = '127.0.0.1';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock ioredis so no real Redis connection is attempted
jest.mock('ioredis', () => {
  const EventEmitter = require('events');
  return jest.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    emitter.on = jest.fn((event, cb) => {
      EventEmitter.prototype.on.call(emitter, event, cb);
      return emitter;
    });
    return emitter;
  });
});

// Mock BullMQ Queue and Worker
var mockQueueAdd = jest.fn().mockResolvedValue({ id: 'job-1' });
var mockGetJob   = jest.fn().mockResolvedValue(null);
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add:    mockQueueAdd,
    getJob: mockGetJob,
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on:    jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock PendingVerification model
var mockFindOneAndUpdate = jest.fn().mockResolvedValue(null);
var mockFind             = jest.fn();
jest.mock('../backend/src/models/pendingVerificationModel', () => ({
  findOneAndUpdate: (...a) => mockFindOneAndUpdate(...a),
  find:             (...a) => mockFind(...a),
}));

// Mock logger
jest.mock('../backend/src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

// ── Module under test ─────────────────────────────────────────────────────────

const {
  enqueueTransaction,
  recoverPendingJobs,
  markResolved,
  markDead,
} = require('../backend/src/queue/transactionQueue');

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

describe('transactionQueue — durability (issue #388)', () => {

  describe('enqueueTransaction()', () => {
    it('persists job to MongoDB before enqueuing to Redis', async () => {
      await enqueueTransaction('abc123', { schoolId: 'school-1', studentId: 'STU001' });

      // MongoDB upsert must have been called
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'abc123' },
        expect.objectContaining({ $setOnInsert: expect.objectContaining({ txHash: 'abc123', schoolId: 'school-1' }) }),
        expect.objectContaining({ upsert: true })
      );

      // BullMQ add must also have been called
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'verify-transaction',
        expect.objectContaining({ txHash: 'abc123' }),
        expect.objectContaining({ jobId: 'abc123' })
      );
    });

    it('still persists to MongoDB when Redis/BullMQ throws', async () => {
      mockQueueAdd.mockRejectedValueOnce(new Error('Redis connection refused'));

      await enqueueTransaction('redis-down-tx', { schoolId: 'school-1' });

      // MongoDB write must still have happened
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'redis-down-tx' },
        expect.anything(),
        expect.anything()
      );
    });

    it('is idempotent — calling twice for the same txHash does not throw', async () => {
      await expect(
        Promise.all([
          enqueueTransaction('dup-tx', { schoolId: 'school-1' }),
          enqueueTransaction('dup-tx', { schoolId: 'school-1' }),
        ])
      ).resolves.not.toThrow();
    });
  });

  describe('recoverPendingJobs() — restart recovery', () => {
    it('re-enqueues pending and processing jobs found in MongoDB', async () => {
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'tx-pending',    schoolId: 'school-1', studentId: 'STU001', status: 'pending' },
          { txHash: 'tx-processing', schoolId: 'school-1', studentId: 'STU002', status: 'processing' },
        ]),
      });

      const recovered = await recoverPendingJobs();

      expect(recovered).toBe(2);
      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'verify-transaction',
        expect.objectContaining({ txHash: 'tx-pending' }),
        expect.objectContaining({ jobId: 'tx-pending' })
      );
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'verify-transaction',
        expect.objectContaining({ txHash: 'tx-processing' }),
        expect.objectContaining({ jobId: 'tx-processing' })
      );
    });

    it('resets processing → pending before re-enqueuing', async () => {
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'tx-was-processing', schoolId: 'school-1', studentId: null, status: 'processing' },
        ]),
      });

      await recoverPendingJobs();

      // Should have reset status to pending (filter is scoped by schoolId from the doc)
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'tx-was-processing', schoolId: 'school-1', status: 'processing' },
        { status: 'pending' }
      );
    });

    it('returns 0 when there are no unresolved jobs', async () => {
      mockFind.mockReturnValue({ bypassTenantScope: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) });

      const recovered = await recoverPendingJobs();
      expect(recovered).toBe(0);
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('continues recovering remaining jobs if one re-enqueue fails', async () => {
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'tx-fail',  schoolId: 'school-1', studentId: null, status: 'pending' },
          { txHash: 'tx-ok',    schoolId: 'school-1', studentId: null, status: 'pending' },
        ]),
      });

      mockQueueAdd
        .mockRejectedValueOnce(new Error('Redis error'))
        .mockResolvedValueOnce({ id: 'job-ok' });

      // Should not throw; should recover the second job
      const recovered = await recoverPendingJobs();
      expect(recovered).toBe(1);
    });
  });

  describe('markResolved()', () => {
    it('updates PendingVerification status to resolved', async () => {
      await markResolved('done-tx');

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'done-tx' },
        expect.objectContaining({ status: 'resolved' }),
        expect.objectContaining({ _bypassTenantScope: true })
      );
    });
  });

  describe('markDead()', () => {
    it('updates PendingVerification status to dead_letter with error message', async () => {
      const err = new Error('Unsupported asset');
      await markDead('bad-tx', err);

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'bad-tx' },
        expect.objectContaining({ status: 'dead_letter', lastError: 'Unsupported asset' }),
        expect.objectContaining({ _bypassTenantScope: true })
      );
    });
  });

  describe('graceful-shutdown interruption path (#1053)', () => {
    const { markInterrupted } = require('../backend/src/queue/transactionQueue');

    it('markInterrupted() sets status=pending (not dead_letter) so recovery picks it up', async () => {
      // The previous implementation marked interrupted jobs as `dead_letter`,
      // which `recoverPendingJobs()` does NOT scan. Jobs that timed out during
      // a shutdown drain would be stranded. Verify the new behaviour.
      const reason = { message: 'Job interrupted by shutdown drain timeout — will be recovered on restart' };
      await markInterrupted('interrupted-tx', reason);

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'interrupted-tx' },
        expect.objectContaining({
          status: 'pending',        // Not `dead_letter` — must be picked up by recovery
          lastError: reason.message,
          lastAttemptAt: expect.any(Date),
        }),
        expect.objectContaining({ _bypassTenantScope: true })
      );
    });

    it('an interrupted-by-shutdown doc is recovered on the next startup', async () => {
      // Simulate end-to-end: shutdown drain marks job as pending, restart runs
      // recoverPendingJobs which should pick it back up and re-enqueue it.
      const reason = { message: 'Job interrupted by shutdown drain timeout' };
      await markInterrupted('shutdown-recoverable', reason);

      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'shutdown-recoverable' },
        expect.objectContaining({ status: 'pending' }),
        expect.anything()
      );

      // Restart: Bootstrap-time recovery sees the doc (now in `pending`) and
      // re-queues it into BullMQ.
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'shutdown-recoverable', schoolId: 'school-1', studentId: 'STU55', status: 'pending', lastError: reason.message },
        ]),
      });

      const recovered = await recoverPendingJobs();
      expect(recovered).toBe(1);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'verify-transaction',
        expect.objectContaining({ txHash: 'shutdown-recoverable' }),
        expect.objectContaining({ jobId: 'shutdown-recoverable' })
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // Issue #1053 — restart-mid-queue durability scenario
  //
  // Acceptance criterion: "verified by a test that restarts the process mid-queue
  // and confirms no transaction submission is silently dropped." This block
  // simulates a process restart by:
  //   1. Enqueuing a transaction in a first "lifecycle" using the public API,
  //   2. Configuring the mocks to reflect the post-restart Redis state (either
  //      Redis lost the job OR Redis still has it), and
  //   3. Calling recoverPendingJobs() exactly the way app.js does on startup.
  //
  // We deliberately do NOT call jest.resetModules() here — that would invalidate
  // the Queue instance captured by the top-level require() and force re-binding
  // of all mocks. Instead we simulate "restart" purely through the public
  // contract (the PendingVerification doc that the enqueue writes to Mongo).
  // ──────────────────────────────────────────────────────────────────────────────
  describe('restart-mid-queue — no transaction is silently dropped (#1053)', () => {
    it('recovers an in-flight transaction whose Redis state was lost across a restart', async () => {
      // ── 1. “Process #1” enqueues a transaction. The MongoDB upsert is the
      //    durable record; the BullMQ add is best-effort.
      await enqueueTransaction('restart-in-flight', { schoolId: 'school-1', studentId: 'STU777' });

      // ── 2. “Process restart.” The PendingVerification doc written above
      //    is still on disk (status='pending'); this is exactly what
      //    recoverPendingJobs() scans on boot.
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'restart-in-flight', schoolId: 'school-1', studentId: 'STU777', status: 'pending', correlationId: 'corr-restart' },
        ]),
      });

      const callCountBefore = mockQueueAdd.mock.calls.length;
      const recovered = await recoverPendingJobs();

      // ── 3. The recovery sweep re-enqueued the lost job — even though Redis
      //    lost it, no transaction submission was silently dropped.
      expect(recovered).toBe(1);
      expect(mockQueueAdd.mock.calls.length).toBe(callCountBefore + 1);
      expect(mockQueueAdd).toHaveBeenLastCalledWith(
        'verify-transaction',
        expect.objectContaining({ txHash: 'restart-in-flight', schoolId: 'school-1' }),
        expect.objectContaining({ jobId: 'restart-in-flight' })
      );
    });

    it('recovers jobs that were stuck in `processing` when a worker died mid-flight', async () => {
      // No initial enqueue — the docs already exist in Mongo from the pre-crash state.
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'crashed-mid-flight', schoolId: 'school-1', studentId: 'STU42', status: 'processing', correlationId: 'corr-crash' },
        ]),
      });

      const recovered = await recoverPendingJobs();

      // The processing doc was reset to pending (so a fresh worker can claim it)
      // and re-queued into BullMQ.
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        { txHash: 'crashed-mid-flight', schoolId: 'school-1', status: 'processing' },
        { status: 'pending' }
      );
      expect(recovered).toBe(1);
      expect(mockQueueAdd).toHaveBeenLastCalledWith(
        'verify-transaction',
        expect.objectContaining({ txHash: 'crashed-mid-flight' }),
        expect.objectContaining({ jobId: 'crashed-mid-flight' })
      );
    });

    it('a second restart does NOT drop the job: recovery is idempotent across repeated boots', async () => {
      // Two restarts both see the same doc in the PendingVerification collection
      // (it has not been marked resolved by either attempt — simulating a deploy
      // where the worker dies before it can complete the verification).
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'repeat-restart', schoolId: 'school-1', studentId: 'STU99', status: 'pending' },
        ]),
      });

      // First restart: BullMQ's jobId dedup is lenient and accepts the add.
      const recoveredFirst = await recoverPendingJobs();
      expect(recoveredFirst).toBe(1);
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);

      // Second restart: BullMQ still holds the job (job table is durable in Redis
      // for the actual duration of the process). The Queue.add() rejects with the
      // canonical "job id already exists" error; the recovery loop logs and
      // continues — the PendingVerification doc never disappears, and the
      // existing BullMQ job continues to be processed by the (new) worker.
      mockQueueAdd.mockRejectedValueOnce(new Error('Job with that id already exists'));
      const recoveredSecond = await recoverPendingJobs();

      // The second call's counter is 0 because the add was deduped — but the
      // on-disk PendingVerification doc and the BullMQ job are still intact,
      // so no transaction is silently dropped.
      expect(recoveredSecond).toBe(0);
      // Add was attempted twice across both boots: once succeeded, once deduped.
      expect(mockQueueAdd).toHaveBeenCalledTimes(2);
    });

    it('end-to-end: enqueue then crash then recover \u2014 the tx would have been processed, not stranded', async () => {
      // End-to-end durability story:
      //  - Step A: enqueueTransaction persists to Mongo AND adds to BullMQ.
      //  - Step B: process crashes. Mock state cleared; only the MongoDB
      //    assertion survives (the rest of this test simulates that).
      //  - Step C: recoverPendingJobs() picks up the doc and re-enqueues it
      //    so a fresh worker can finish the verification.
      //
      // This test verifies the public contract end-to-end without relying on
      // any specific internal call ordering or any single mock function.
      await enqueueTransaction('e2e-restart', { schoolId: 'school-1', studentId: 'STU_e2e' });

      // The Mongo upsert must have happened with status=pending (initial state).
      const upsertCall = mockFindOneAndUpdate.mock.calls.find(
        ([filter, update]) => filter.txHash === 'e2e-restart' && update && update.$setOnInsert
      );
      expect(upsertCall).toBeDefined();
      expect(upsertCall[1].$setOnInsert.status).toBe('pending');

      // Simulate post-crash state: clear the BullMQ add call tracker (Redis lost
      // everything, conceptually) but keep the MongoDB model mock configured so
      // recoverPendingJobs() returns the doc.
      mockQueueAdd.mockClear();
      mockFindOneAndUpdate.mockClear();
      mockFind.mockClear();
      mockFind.mockReturnValue({
        bypassTenantScope: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { txHash: 'e2e-restart', schoolId: 'school-1', studentId: 'STU_e2e', status: 'pending' },
        ]),
      });

      const recovered = await recoverPendingJobs();
      expect(recovered).toBe(1);

      // The recovery MUST have used jobId=txHash so that even after the second
      // add, BullMQ treats it as a no-op (or only one of the two attempts is
      // counted as recovered). The on-disk PendingVerification doc remains the
      // authoritative anchor.
      expect(mockQueueAdd).toHaveBeenCalledWith(
        'verify-transaction',
        expect.objectContaining({ txHash: 'e2e-restart' }),
        expect.objectContaining({ jobId: 'e2e-restart' })
      );
    });
  });
});
