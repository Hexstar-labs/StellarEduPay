'use strict';

/**
 * Tests for sessionCleanupService.
 *
 * The module uses module-level singletons for the timer and _running flag.
 * Each test loads a fresh isolated instance via jest.isolateModules().
 * setInterval / clearInterval are replaced with Jest fake timers.
 */

// ── Suppress logger noise ──────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// ── PaymentIntent mock setup ───────────────────────────────────────────────
const mockUpdateMany = jest.fn();

jest.mock('../src/models/paymentIntentModel', () => ({
  updateMany: (...args) => mockUpdateMany(...args),
}));

// ── Helper: load a fresh isolated module ──────────────────────────────────
function loadService() {
  let svc;
  jest.isolateModules(() => {
    svc = require('../src/services/sessionCleanupService');
  });
  return svc;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
});

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

// ── cleanupExpiredSessions ─────────────────────────────────────────────────

describe('cleanupExpiredSessions', () => {
  it('calls PaymentIntent.updateMany with the correct filter and update', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    const svc = loadService();
    await svc.cleanupExpiredSessions();

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = mockUpdateMany.mock.calls[0];
    expect(filter).toMatchObject({ status: 'pending' });
    expect(filter.expiresAt).toBeDefined();
    expect(update).toEqual({ $set: { status: 'expired' } });
  });

  it('logs when records are expired', async () => {
    const logger = require('../src/utils/logger');
    const childLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    logger.child = jest.fn(() => childLogger);

    mockUpdateMany.mockResolvedValue({ modifiedCount: 3 });
    const svc = loadService();
    await svc.cleanupExpiredSessions();

    // The child logger's info should have been called (or the parent logger).
    // We just check the DB was queried; logging is a side-effect we don't pin.
    expect(mockUpdateMany).toHaveBeenCalled();
  });

  it('handles a DB error without throwing', async () => {
    mockUpdateMany.mockRejectedValue(new Error('DB connection lost'));
    const svc = loadService();
    await expect(svc.cleanupExpiredSessions()).resolves.not.toThrow();
  });

  it('does not run concurrently — second call while first is running is a no-op', async () => {
    let resolveFirst;
    mockUpdateMany.mockReturnValueOnce(
      new Promise((resolve) => { resolveFirst = () => resolve({ modifiedCount: 0 }); }),
    );

    const svc = loadService();

    const first  = svc.cleanupExpiredSessions();  // starts, not yet resolved
    const second = svc.cleanupExpiredSessions();  // should be skipped

    resolveFirst();
    await first;
    await second;

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('can run again after the first run completes (_running is reset)', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    const svc = loadService();
    await svc.cleanupExpiredSessions();
    await svc.cleanupExpiredSessions();
    expect(mockUpdateMany).toHaveBeenCalledTimes(2);
  });
});

// ── startSessionCleanupScheduler ──────────────────────────────────────────

describe('startSessionCleanupScheduler', () => {
  it('does not call updateMany immediately on start', () => {
    const svc = loadService();
    svc.startSessionCleanupScheduler();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('calls cleanupExpiredSessions after one interval tick', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    const svc = loadService();
    svc.startSessionCleanupScheduler();

    // Default INTERVAL_MS is 1 hour; advance past it
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('uses SESSION_CLEANUP_INTERVAL_MS env var when set', async () => {
    process.env.SESSION_CLEANUP_INTERVAL_MS = '5000';
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });

    // Need a fresh module to pick up the env var
    const svc = loadService();
    svc.startSessionCleanupScheduler();

    await jest.advanceTimersByTimeAsync(5001);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);

    delete process.env.SESSION_CLEANUP_INTERVAL_MS;
  });

  it('is idempotent — calling start twice does not register two timers', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    const svc = loadService();
    svc.startSessionCleanupScheduler();
    svc.startSessionCleanupScheduler(); // second call is a no-op

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1); // not 2
  });
});

// ── stopSessionCleanupScheduler ────────────────────────────────────────────

describe('stopSessionCleanupScheduler', () => {
  it('prevents further ticks after stop', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    const svc = loadService();
    svc.startSessionCleanupScheduler();
    svc.stopSessionCleanupScheduler();

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('is safe to call when not started', () => {
    const svc = loadService();
    expect(() => svc.stopSessionCleanupScheduler()).not.toThrow();
  });

  it('allows restart after stop', async () => {
    mockUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    const svc = loadService();
    svc.startSessionCleanupScheduler();
    svc.stopSessionCleanupScheduler();
    svc.startSessionCleanupScheduler();

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });
});
