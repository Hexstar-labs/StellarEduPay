'use strict';

const { metricsAuth, validateMetricsTokenOnStartup, PLACEHOLDER_TOKENS } = require('../backend/src/middleware/metricsAuth');

const STRONG_TOKEN = 'a'.repeat(32); // exactly 32 chars — minimum length

function makeReq(authHeader) {
  return { headers: authHeader ? { authorization: authHeader } : {} };
}

function makeRes() {
  let _status;
  const res = {
    status: jest.fn().mockImplementation((s) => { _status = s; return res; }),
    set:    jest.fn().mockReturnThis(),
    send:   jest.fn().mockReturnThis(),
    _getStatus: () => _status,
    _getSendArg: () => res.send.mock.calls[0]?.[0] ?? '',
  };
  return res;
}

const originalEnv = {
  METRICS_TOKEN: process.env.METRICS_TOKEN,
  METRICS_BEARER_TOKEN: process.env.METRICS_BEARER_TOKEN,
};

afterEach(() => {
  if (originalEnv.METRICS_TOKEN === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = originalEnv.METRICS_TOKEN;

  if (originalEnv.METRICS_BEARER_TOKEN === undefined) delete process.env.METRICS_BEARER_TOKEN;
  else process.env.METRICS_BEARER_TOKEN = originalEnv.METRICS_BEARER_TOKEN;
});

// ── metricsAuth middleware ────────────────────────────────────────────────────

describe('metricsAuth', () => {
  test('returns 500 when METRICS_TOKEN is not set', () => {
    delete process.env.METRICS_TOKEN;
    delete process.env.METRICS_BEARER_TOKEN;
    const res = makeRes();
    metricsAuth(makeReq(), res, jest.fn());
    expect(res._getStatus()).toBe(500);
  });

  test('returns 500 when METRICS_TOKEN is shorter than 32 chars', () => {
    delete process.env.METRICS_BEARER_TOKEN;
    process.env.METRICS_TOKEN = 'short';
    const res = makeRes();
    metricsAuth(makeReq(), res, jest.fn());
    expect(res._getStatus()).toBe(500);
  });

  test('returns 401 when no Authorization header', () => {
    delete process.env.METRICS_BEARER_TOKEN;
    process.env.METRICS_TOKEN = STRONG_TOKEN;
    const res = makeRes();
    metricsAuth(makeReq(), res, jest.fn());
    expect(res._getStatus()).toBe(401);
  });

  test('returns 403 when wrong token provided', () => {
    delete process.env.METRICS_BEARER_TOKEN;
    process.env.METRICS_TOKEN = STRONG_TOKEN;
    const res = makeRes();
    metricsAuth(makeReq(`Bearer ${'b'.repeat(32)}`), res, jest.fn());
    expect(res._getStatus()).toBe(403);
  });

  test('calls next() when correct METRICS_TOKEN provided', () => {
    delete process.env.METRICS_BEARER_TOKEN;
    process.env.METRICS_TOKEN = STRONG_TOKEN;
    const next = jest.fn();
    metricsAuth(makeReq(`Bearer ${STRONG_TOKEN}`), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('returns 401 when Authorization does not start with Bearer', () => {
    delete process.env.METRICS_BEARER_TOKEN;
    process.env.METRICS_TOKEN = STRONG_TOKEN;
    const res = makeRes();
    metricsAuth(makeReq(`Basic ${STRONG_TOKEN}`), res, jest.fn());
    expect(res._getStatus()).toBe(401);
  });

  // ── METRICS_BEARER_TOKEN support ─────────────────────────────────────────

  test('METRICS_BEARER_TOKEN takes precedence over METRICS_TOKEN', () => {
    process.env.METRICS_BEARER_TOKEN = STRONG_TOKEN;
    process.env.METRICS_TOKEN = 'b'.repeat(32); // different token
    const next = jest.fn();
    // Correct token is METRICS_BEARER_TOKEN
    metricsAuth(makeReq(`Bearer ${STRONG_TOKEN}`), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('calls next() when correct METRICS_BEARER_TOKEN provided', () => {
    delete process.env.METRICS_TOKEN;
    process.env.METRICS_BEARER_TOKEN = STRONG_TOKEN;
    const next = jest.fn();
    metricsAuth(makeReq(`Bearer ${STRONG_TOKEN}`), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  // ── Placeholder token rejection ───────────────────────────────────────────

  test('returns 500 when METRICS_TOKEN is the known placeholder', () => {
    delete process.env.METRICS_BEARER_TOKEN;
    process.env.METRICS_TOKEN = 'change_me_to_a_secure_random_token';
    const res = makeRes();
    metricsAuth(makeReq(`Bearer change_me_to_a_secure_random_token`), res, jest.fn());
    expect(res._getStatus()).toBe(500);
  });

  test('returns 500 when METRICS_BEARER_TOKEN is the prometheus.yml placeholder', () => {
    process.env.METRICS_BEARER_TOKEN = 'REPLACE_WITH_METRICS_TOKEN';
    const res = makeRes();
    metricsAuth(makeReq(`Bearer REPLACE_WITH_METRICS_TOKEN`), res, jest.fn());
    expect(res._getStatus()).toBe(500);
  });

  test('placeholder rejection message references token rotation', () => {
    delete process.env.METRICS_BEARER_TOKEN;
    process.env.METRICS_TOKEN = 'change_me_to_a_secure_random_token';
    const res = makeRes();
    metricsAuth(makeReq(`Bearer change_me_to_a_secure_random_token`), res, jest.fn());
    expect(res._getSendArg()).toMatch(/placeholder|insecure|Rotate/i);
  });
});

// ── validateMetricsTokenOnStartup ────────────────────────────────────────────

describe('validateMetricsTokenOnStartup', () => {
  test('throws in production when token is missing', () => {
    delete process.env.METRICS_TOKEN;
    delete process.env.METRICS_BEARER_TOKEN;
    expect(() => validateMetricsTokenOnStartup({ isProduction: true })).toThrow(/METRICS_BEARER_TOKEN/);
  });

  test('does NOT throw in non-production when token is missing (warns instead)', () => {
    delete process.env.METRICS_TOKEN;
    delete process.env.METRICS_BEARER_TOKEN;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => validateMetricsTokenOnStartup({ isProduction: false })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('METRICS_BEARER_TOKEN'));
    warnSpy.mockRestore();
  });

  test('throws in production when METRICS_BEARER_TOKEN is the placeholder', () => {
    process.env.METRICS_BEARER_TOKEN = 'change_me_to_a_secure_random_token';
    delete process.env.METRICS_TOKEN;
    expect(() => validateMetricsTokenOnStartup({ isProduction: true })).toThrow(/placeholder/i);
  });

  test('throws in production when METRICS_TOKEN is the prometheus.yml placeholder', () => {
    delete process.env.METRICS_BEARER_TOKEN;
    process.env.METRICS_TOKEN = 'REPLACE_WITH_METRICS_TOKEN';
    expect(() => validateMetricsTokenOnStartup({ isProduction: true })).toThrow(/placeholder/i);
  });

  test('does NOT throw in production when METRICS_BEARER_TOKEN is valid', () => {
    process.env.METRICS_BEARER_TOKEN = STRONG_TOKEN;
    delete process.env.METRICS_TOKEN;
    expect(() => validateMetricsTokenOnStartup({ isProduction: true })).not.toThrow();
  });

  test('does NOT throw in production when METRICS_TOKEN is valid (legacy)', () => {
    delete process.env.METRICS_BEARER_TOKEN;
    process.env.METRICS_TOKEN = STRONG_TOKEN;
    expect(() => validateMetricsTokenOnStartup({ isProduction: true })).not.toThrow();
  });

  test('throws in production when token is too short', () => {
    process.env.METRICS_BEARER_TOKEN = 'short';
    delete process.env.METRICS_TOKEN;
    expect(() => validateMetricsTokenOnStartup({ isProduction: true })).toThrow(/too short/i);
  });

  test('PLACEHOLDER_TOKENS set contains the legacy value', () => {
    expect(PLACEHOLDER_TOKENS.has('change_me_to_a_secure_random_token')).toBe(true);
  });

  test('PLACEHOLDER_TOKENS set contains the prometheus.yml value', () => {
    expect(PLACEHOLDER_TOKENS.has('REPLACE_WITH_METRICS_TOKEN')).toBe(true);
  });
});
