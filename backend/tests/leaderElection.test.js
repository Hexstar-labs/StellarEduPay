'use strict';

/**
 * Tests for leaderElection service.
 *
 * The module uses module-level mutable state and setInterval timers.
 * Each test loads a fresh module instance via jest.isolateModules() to avoid
 * state bleed between tests. The distributedLock dependency is mocked so no
 * real Redis connection is required.
 */

// ── Suppress logger noise ──────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// ── distributedLock mock helpers ───────────────────────────────────────────
// These are reassigned in beforeEach so each isolatedModules load gets its own.
let mockAcquire;
let mockRelease;
let mockRenew;

jest.mock('../src/services/distributedLock', () => ({
  acquire: (...args) => mockAcquire(...args),
  release: (...args) => mockRelease(...args),
  renew:   (...args) => mockRenew(...args),
  studentBalanceLockKey: (schoolId, studentId) => `lock:${schoolId}:${studentId}`,
}));

/** Load a fresh, isolated leaderElection module. */
function loadLE() {
  let le;
  jest.isolateModules(() => {
    le = require('../src/services/leaderElection');
  });
  return le;
}

const LOCK_RESULT = { token: 'tok-1', fencingToken: 1 };

beforeEach(() => {
  jest.useFakeTimers();
  mockAcquire = jest.fn().mockResolvedValue(LOCK_RESULT);
  mockRelease = jest.fn().mockResolvedValue(true);
  mockRenew   = jest.fn().mockResolvedValue(true);
});

afterEach(async () => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

// ── isLeader / getFencingToken defaults ────────────────────────────────────

describe('initial state', () => {
  it('isLeader() returns false before start()', () => {
    const le = loadLE();
    expect(le.isLeader()).toBe(false);
  });

  it('getFencingToken() returns null before start()', () => {
    const le = loadLE();
    expect(le.getFencingToken()).toBeNull();
  });
});

// ── start() — successful election ─────────────────────────────────────────

describe('start() — election won on first attempt', () => {
  it('becomes leader when lock.acquire succeeds', async () => {
    const le = loadLE();
    await le.start();
    expect(le.isLeader()).toBe(true);
  });

  it('stores the fencing token after election', async () => {
    const le = loadLE();
    await le.start();
    expect(le.getFencingToken()).toBe(1);
  });

  it('calls the onElected callback', async () => {
    const le = loadLE();
    const onElected = jest.fn();
    le.register(onElected, null);
    await le.start();
    expect(onElected).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onDemoted callback when elected', async () => {
    const le = loadLE();
    const onDemoted = jest.fn();
    le.register(null, onDemoted);
    await le.start();
    expect(onDemoted).not.toHaveBeenCalled();
  });

  it('start() is idempotent — second call is a no-op', async () => {
    const le = loadLE();
    await le.start();
    await le.start(); // second call
    expect(mockAcquire).toHaveBeenCalledTimes(1);
  });
});

// ── start() — election not won ─────────────────────────────────────────────

describe('start() — initial election not won', () => {
  it('isLeader() returns false when acquire returns null', async () => {
    mockAcquire.mockResolvedValue(null);
    const le = loadLE();
    await le.start();
    expect(le.isLeader()).toBe(false);
  });

  it('does not call onElected when acquire returns null', async () => {
    mockAcquire.mockResolvedValue(null);
    const le = loadLE();
    const onElected = jest.fn();
    le.register(onElected, null);
    await le.start();
    expect(onElected).not.toHaveBeenCalled();
  });

  it('eventually acquires the lock when the periodic timer fires', async () => {
    // First call fails; subsequent calls succeed.
    mockAcquire
      .mockResolvedValueOnce(null)
      .mockResolvedValue(LOCK_RESULT);
    const le = loadLE();
    await le.start();
    expect(le.isLeader()).toBe(false);

    // Advance exactly one acquire interval (default 10 s) and flush the promise queue.
    await jest.advanceTimersByTimeAsync(10_001);
    expect(le.isLeader()).toBe(true);
  });
});

// ── stop() ──────────────────────────────────────────────────────────────────

describe('stop()', () => {
  it('isLeader() returns false after stop()', async () => {
    const le = loadLE();
    await le.start();
    expect(le.isLeader()).toBe(true);
    await le.stop();
    expect(le.isLeader()).toBe(false);
  });

  it('calls the onDemoted callback when stopping as leader', async () => {
    const le = loadLE();
    const onDemoted = jest.fn();
    le.register(null, onDemoted);
    await le.start();
    await le.stop();
    expect(onDemoted).toHaveBeenCalledTimes(1);
  });

  it('does not call onDemoted when stopping as a non-leader', async () => {
    mockAcquire.mockResolvedValue(null);
    const le = loadLE();
    const onDemoted = jest.fn();
    le.register(null, onDemoted);
    await le.start();
    await le.stop();
    expect(onDemoted).not.toHaveBeenCalled();
  });

  it('clears registered callbacks after stop', async () => {
    const le = loadLE();
    const onElected = jest.fn();
    le.register(onElected, null);
    await le.start();
    await le.stop();
    onElected.mockClear();

    // Re-elect — callbacks were cleared, so onElected must NOT fire again
    mockAcquire.mockResolvedValue(LOCK_RESULT);
    await le.start();
    expect(onElected).not.toHaveBeenCalled();
  });
});

// ── register() ────────────────────────────────────────────────────────────

describe('register()', () => {
  it('accepts null callbacks without throwing', () => {
    const le = loadLE();
    expect(() => le.register(null, null)).not.toThrow();
  });

  it('accepts non-function without throwing', () => {
    const le = loadLE();
    expect(() => le.register('not-a-fn', 42)).not.toThrow();
  });

  it('supports multiple registered callbacks — all are called', async () => {
    const le = loadLE();
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    le.register(cb1, null);
    le.register(cb2, null);
    await le.start();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('a throwing onElected callback does not crash the election', async () => {
    const le = loadLE();
    le.register(() => { throw new Error('cb boom'); }, null);
    await expect(le.start()).resolves.not.toThrow();
    expect(le.isLeader()).toBe(true);
  });

  it('a throwing onDemoted callback does not crash stop()', async () => {
    const le = loadLE();
    le.register(null, () => { throw new Error('demote boom'); });
    await le.start();
    await expect(le.stop()).resolves.not.toThrow();
  });
});

// ── Renew / demotion via lock loss ─────────────────────────────────────────

describe('lease renewal and demotion', () => {
  it('remains leader when renew succeeds (after one renew interval)', async () => {
    const le = loadLE();
    await le.start();
    expect(le.isLeader()).toBe(true);

    // Advance one renew interval (default 15 s) and let the timer callback run
    await jest.advanceTimersByTimeAsync(15_001);
    expect(mockRenew).toHaveBeenCalled();
    expect(le.isLeader()).toBe(true);
  });

  it('demotes when lock.renew returns falsy', async () => {
    const le = loadLE();
    await le.start();
    expect(le.isLeader()).toBe(true);

    mockRenew.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(15_001);
    expect(le.isLeader()).toBe(false);
  });

  it('calls onDemoted callback when renewal fails', async () => {
    const le = loadLE();
    const onDemoted = jest.fn();
    le.register(null, onDemoted);
    await le.start();

    mockRenew.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(15_001);
    expect(onDemoted).toHaveBeenCalledTimes(1);
  });

  it('can re-acquire after demotion via the periodic acquire timer', async () => {
    const le = loadLE();
    await le.start();

    // Lose the lock on first renewal
    mockRenew.mockResolvedValue(false);
    await jest.advanceTimersByTimeAsync(15_001);
    expect(le.isLeader()).toBe(false);

    // Next acquire tick should re-elect
    mockAcquire.mockResolvedValue({ token: 'tok-2', fencingToken: 2 });
    await jest.advanceTimersByTimeAsync(10_001);
    expect(le.isLeader()).toBe(true);
    expect(le.getFencingToken()).toBe(2);
  });
});

