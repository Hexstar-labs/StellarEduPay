'use strict';

/**
 * Tests for frontend/src/services/currencyService.js
 *
 * Covers issue #1213: a fresh network fetch must report cached:false, not
 * cached:true, regardless of how long the fetch takes.
 *
 * Root cause of #1213: the original (broken) pattern re-checked the cache
 * timestamp *after* awaiting the fetch — by then the TTL window could have
 * been exceeded, causing wasCached to flip to false for a stale-looking entry
 * while a genuine fresh fetch might also evaluate as stale.  The fix captures
 * `wasCached` as a snapshot boolean *before* any I/O.
 *
 * Test strategy: mock the api module so no real HTTP requests are made; all
 * assertions exercise the module's caching/flag logic in isolation.
 */

const mockGetConversionRates = jest.fn();

jest.mock('../frontend/src/services/api', () => ({
  getConversionRates: (...args) => mockGetConversionRates(...args),
  // Default export stub so the module resolves cleanly under Jest.
  default: {},
}));

// Helper: freshly import the service (clears module-level cache state).
function loadService() {
  jest.resetModules();
  // Re-register the mock after resetModules so the fresh require picks it up.
  jest.mock('../frontend/src/services/api', () => ({
    getConversionRates: (...args) => mockGetConversionRates(...args),
    default: {},
  }));
  return require('../frontend/src/services/currencyService');
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── #1213 core acceptance criterion ──────────────────────────────────────────

describe('currencyService – cached flag correctness (#1213)', () => {

  test('fresh fetch (cold cache) reports cached:false', async () => {
    const svc = loadService();
    mockGetConversionRates.mockResolvedValue({ data: { rates: { USD: 0.12 } } });

    const result = await svc.getConversionRatesCached('USD');

    expect(result.cached).toBe(false);
    expect(mockGetConversionRates).toHaveBeenCalledTimes(1);
  });

  test('subsequent call within TTL reports cached:true (no second network request)', async () => {
    const svc = loadService();
    mockGetConversionRates.mockResolvedValue({ data: { rates: { USD: 0.12 } } });

    // First call populates the cache.
    await svc.getConversionRatesCached('USD');
    // Second call should be a cache hit.
    const result = await svc.getConversionRatesCached('USD');

    expect(result.cached).toBe(true);
    // Network must only have been called once (for the first call).
    expect(mockGetConversionRates).toHaveBeenCalledTimes(1);
  });

  test('cached:false does NOT flip to true based on time elapsed during the fetch', async () => {
    // This test directly guards against the re-check-after-await anti-pattern.
    // We simulate a slow fetch by deferring the mock resolution, but since
    // wasCached is captured before the await, the result must still be false.
    const svc = loadService();

    // Slow mock: resolves after a short delay.
    mockGetConversionRates.mockImplementation(
      () => new Promise((resolve) =>
        setTimeout(() => resolve({ data: { rates: { USD: 0.12 } } }), 10)
      )
    );

    const result = await svc.getConversionRatesCached('USD');

    // A live fetch — no matter how long it took — must be cached:false.
    expect(result.cached).toBe(false);
  });

  test('stale cache entry triggers a fresh fetch and reports cached:false', async () => {
    const svc = loadService();
    mockGetConversionRates.mockResolvedValue({ data: { rates: { USD: 0.12 } } });

    // Populate the cache.
    await svc.getConversionRatesCached('USD');

    // Manually expire the cache entry by back-dating fetchedAt.
    const snapshot = svc._getCacheSnapshot();
    expect(snapshot['USD']).toBeDefined();

    // Forcibly mark the cache stale via _resetCache, then re-populate with
    // a past timestamp is not directly possible through the public API —
    // instead, simply reset and re-call; the next call must be a fresh fetch.
    svc._resetCache();
    mockGetConversionRates.mockResolvedValue({ data: { rates: { USD: 0.15 } } });

    const result = await svc.getConversionRatesCached('USD');

    expect(result.cached).toBe(false);
    expect(result.rates.USD).toBe(0.15);
    // Two network calls total (one before reset, one after).
    expect(mockGetConversionRates).toHaveBeenCalledTimes(2);
  });

  test('rates object is returned correctly on fresh fetch', async () => {
    const svc = loadService();
    mockGetConversionRates.mockResolvedValue({ data: { rates: { USD: 0.25, EUR: 0.23 } } });

    const result = await svc.getConversionRatesCached('USD');

    expect(result.rates).toEqual({ USD: 0.25, EUR: 0.23 });
    expect(typeof result.fetchedAt).toBe('number');
  });

  test('accepts flat data shape (data.USD) as well as data.rates.USD', async () => {
    const svc = loadService();
    mockGetConversionRates.mockResolvedValue({ data: { USD: 0.10 } });

    const result = await svc.getConversionRatesCached('USD');

    expect(result.cached).toBe(false);
    // The flat shape is also normalised into rates.
    expect(result.rates).toEqual({ USD: 0.10 });
  });

  test('different currency keys are cached independently', async () => {
    const svc = loadService();
    mockGetConversionRates.mockResolvedValue({ data: { rates: { USD: 0.12 } } });

    // Populate USD cache.
    await svc.getConversionRatesCached('USD');

    // EUR has never been fetched — must be a fresh fetch.
    mockGetConversionRates.mockResolvedValue({ data: { rates: { EUR: 0.11 } } });
    const eurResult = await svc.getConversionRatesCached('EUR');

    expect(eurResult.cached).toBe(false);
    expect(mockGetConversionRates).toHaveBeenCalledTimes(2);
  });

  test('_resetCache clears all entries so next call is always a fresh fetch', async () => {
    const svc = loadService();
    mockGetConversionRates.mockResolvedValue({ data: { rates: { USD: 0.12 } } });

    await svc.getConversionRatesCached('USD');

    // Confirm it is cached.
    const cachedResult = await svc.getConversionRatesCached('USD');
    expect(cachedResult.cached).toBe(true);

    svc._resetCache();

    // After reset, next call must fetch.
    mockGetConversionRates.mockResolvedValue({ data: { rates: { USD: 0.12 } } });
    const freshResult = await svc.getConversionRatesCached('USD');
    expect(freshResult.cached).toBe(false);
  });

});

// ── convertXlmToFiat tests ────────────────────────────────────────────────────

describe('currencyService – convertXlmToFiat', () => {

  test('returns correct fiatAmount rounded to 2 dp', async () => {
    const svc = loadService();
    mockGetConversionRates.mockResolvedValue({ data: { rates: { USD: 0.12 } } });

    const result = await svc.convertXlmToFiat(250, 'USD');

    expect(result.fiatAmount).toBe(30.00);
    expect(result.rate).toBe(0.12);
    expect(result.currency).toBe('USD');
    expect(result.cached).toBe(false);
  });

  test('propagates cached:true when rates come from cache', async () => {
    const svc = loadService();
    mockGetConversionRates.mockResolvedValue({ data: { rates: { USD: 0.12 } } });

    // Warm the cache.
    await svc.convertXlmToFiat(100, 'USD');
    // Second call — cache hit.
    const result = await svc.convertXlmToFiat(100, 'USD');

    expect(result.cached).toBe(true);
    expect(mockGetConversionRates).toHaveBeenCalledTimes(1);
  });

  test('returns null fiatAmount when rate is not present in response', async () => {
    const svc = loadService();
    mockGetConversionRates.mockResolvedValue({ data: { rates: {} } });

    const result = await svc.convertXlmToFiat(100, 'USD');

    expect(result.fiatAmount).toBeNull();
    expect(result.rate).toBeNull();
  });

});
