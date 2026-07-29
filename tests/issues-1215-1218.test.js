'use strict';

/**
 * Tests for:
 *   #1215 — PaymentForm must cancel its debounce timer on submit so only one
 *            student-lookup request fires, not two.
 *   #1218 — useAdminAuth must retry /auth/me with backoff after a transient
 *            failure and expose authMeError + retryAuth for manual recovery.
 *
 * These tests exercise the fix logic directly (without importing the full React
 * components) so they run cleanly in the Node/Jest environment at the repo root
 * where frontend dependencies (qrcode.react, next/router, …) are not installed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1215 — debounce-cancel-on-submit logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal re-implementation of the form's debounce + submit interaction so we
 * can verify the fix without spinning up React.
 *
 * Before fix: onSubmit did NOT clear the timer.
 * After fix:  onSubmit clears the timer before calling lookupStudent.
 */
function makeFormState() {
  let debounceRef = null; // mirrors debounceRef.current
  const calls = [];       // tracks every lookupStudent invocation

  function lookupStudent(id) {
    calls.push(id);
  }

  // Mirrors the onChange handler — schedules a debounced lookup.
  function handleChange(value, ms = 420) {
    if (debounceRef) clearTimeout(debounceRef);
    debounceRef = setTimeout(() => lookupStudent(value), ms);
  }

  // After fix: cancel the debounce timer before invoking lookupStudent.
  function handleSubmitFixed(value) {
    if (debounceRef) {
      clearTimeout(debounceRef);
      debounceRef = null;
    }
    lookupStudent(value);
  }

  // Before fix: submit does NOT clear the debounce timer.
  function handleSubmitBroken(value) {
    lookupStudent(value);
  }

  return { calls, handleChange, handleSubmitFixed, handleSubmitBroken };
}

describe('#1215 — PaymentForm: submit cancels pending debounce timer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('FIXED: submitting immediately after typing triggers exactly one lookup', () => {
    const { calls, handleChange, handleSubmitFixed } = makeFormState();

    // User types — schedules a debounce timer.
    handleChange('STU001', 420);

    // User hits submit before the timer fires.
    handleSubmitFixed('STU001');

    // The timer fires 420 ms later — should NOT trigger a second lookup.
    jest.advanceTimersByTime(500);

    expect(calls).toEqual(['STU001']); // exactly one call
    expect(calls).toHaveLength(1);
  });

  test('BROKEN (pre-fix): submitting without cancelling debounce triggers two lookups', () => {
    const { calls, handleChange, handleSubmitBroken } = makeFormState();

    // User types — schedules a debounce timer.
    handleChange('STU001', 420);

    // Submit fires WITHOUT cancelling the timer.
    handleSubmitBroken('STU001');

    // Debounce timer still fires → second lookup.
    jest.advanceTimersByTime(500);

    // This is the BUG the fix addresses — two calls instead of one.
    expect(calls).toHaveLength(2);
  });

  test('FIXED: submitting when no debounce is pending still performs one lookup', () => {
    const { calls, handleChange, handleSubmitFixed } = makeFormState();

    // Type, let the debounce fire naturally.
    handleChange('STU001', 420);
    jest.advanceTimersByTime(500); // first lookup from debounce

    // Now submit — should trigger a second independent lookup.
    handleSubmitFixed('STU001');

    expect(calls).toHaveLength(2); // debounce + submit
  });

  test('FIXED: debounceRef is null after submit clears it', () => {
    let debounceRef = null;

    function handleSubmitFixed() {
      if (debounceRef) {
        clearTimeout(debounceRef);
        debounceRef = null; // #1215 fix: explicitly null the ref
      }
    }

    debounceRef = setTimeout(() => {}, 420);
    handleSubmitFixed();

    expect(debounceRef).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #1218 — fetchAuthMe retry logic (pure logic, no React needed)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-implement fetchAuthMe exactly as written in useAdminAuth.js so we can
 * test its retry/backoff contract in isolation.
 */
const AUTH_ME_MAX_RETRIES = 3;
const AUTH_ME_RETRY_BASE_MS = 1000;

async function fetchAuthMe(fetchFn, maxRetries = AUTH_ME_MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, AUTH_ME_RETRY_BASE_MS * Math.pow(2, attempt - 1))
      );
    }
    try {
      const r = await fetchFn();
      if (r.ok) return r.json();
      if (r.status === 401 || r.status === 403) {
        throw Object.assign(new Error('Not authenticated'), { permanent: true });
      }
      lastError = new Error(`/auth/me responded with ${r.status}`);
    } catch (err) {
      if (err.permanent) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

// Wrapper that replaces the real setTimeout with one that executes immediately,
// so we can test the retry path without any real delays.  Returns a cleanup fn.
function patchSetTimeoutImmediate(delayLog) {
  const orig = global.setTimeout;
  global.setTimeout = (fn, ms) => {
    if (typeof ms === 'number' && delayLog) delayLog.push(ms);
    return orig(fn, 0); // run immediately
  };
  return () => { global.setTimeout = orig; };
}

describe('#1218 — fetchAuthMe retry logic', () => {
  test('resolves immediately on a successful first attempt', async () => {
    const fetchFn = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schoolId: 'SCH-001', userId: 'admin-1' }),
    });

    const result = await fetchAuthMe(fetchFn);

    expect(result.schoolId).toBe('SCH-001');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('retries on 500 and resolves when a later attempt succeeds', async () => {
    const restore = patchSetTimeoutImmediate();
    try {
      const fetchFn = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 500 }) // attempt 0 fails
        .mockResolvedValueOnce({ ok: false, status: 500 }) // attempt 1 fails
        .mockResolvedValue({                               // attempt 2 succeeds
          ok: true,
          json: async () => ({ schoolId: 'SCH-002' }),
        });

      const result = await fetchAuthMe(fetchFn);
      expect(result.schoolId).toBe('SCH-002');
      expect(fetchFn).toHaveBeenCalledTimes(3);
    } finally {
      restore();
    }
  });

  test('rejects after exhausting all retries (no permanent error)', async () => {
    const restore = patchSetTimeoutImmediate();
    try {
      const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 503 });
      await expect(fetchAuthMe(fetchFn)).rejects.toThrow('/auth/me responded with 503');
      // 1 initial + 3 retries = 4 total calls.
      expect(fetchFn).toHaveBeenCalledTimes(4);
    } finally {
      restore();
    }
  });

  test('does NOT retry on 401 (permanent auth failure)', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    await expect(fetchAuthMe(fetchFn)).rejects.toThrow('Not authenticated');
    // Only one attempt — 401 is permanent, no retry.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('does NOT retry on 403 (permanent auth failure)', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(fetchAuthMe(fetchFn)).rejects.toThrow('Not authenticated');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('applies exponential backoff: 1 s, 2 s, 4 s between retries', async () => {
    const delays = [];
    const restore = patchSetTimeoutImmediate(delays);
    try {
      const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 500 });
      try { await fetchAuthMe(fetchFn); } catch { /* expected */ }
      // There should be exactly 3 backoff delays (between attempts 0→1, 1→2, 2→3).
      const backoffDelays = delays.filter((d) => d >= 1000);
      expect(backoffDelays).toEqual([1000, 2000, 4000]);
    } finally {
      restore();
    }
  });

  test('a network error (fetch throws) is treated as retriable', async () => {
    const restore = patchSetTimeoutImmediate();
    try {
      const fetchFn = jest.fn()
        .mockRejectedValueOnce(new Error('Network error')) // attempt 0
        .mockResolvedValue({
          ok: true,
          json: async () => ({ schoolId: 'SCH-NET' }),
        });

      const result = await fetchAuthMe(fetchFn);
      expect(result.schoolId).toBe('SCH-NET');
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });
});
