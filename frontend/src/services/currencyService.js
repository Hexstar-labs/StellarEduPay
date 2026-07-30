/**
 * currencyService.js
 *
 * Front-end cache wrapper around the /payments/rates API endpoint.
 *
 * Each entry is keyed by fiat currency code (e.g. "USD") and is considered
 * fresh for CACHE_TTL_MS milliseconds after it was fetched.
 *
 * ## Fix for issue #1213 — stale `cached` flag
 *
 * The root cause was computing the `cached` flag *after* the async fetch
 * returned, by re-checking the timestamp at that point.  Because even a
 * genuine network round-trip takes non-zero time, the freshness window could
 * have expired by the time the flag was evaluated, making a live fetch look
 * stale.
 *
 * Fix: capture `wasCached` as a boolean synchronously, *before* any I/O,
 * by checking whether the cache holds a still-fresh entry at lookup time.
 * That snapshot travels alongside the result and becomes the `cached` flag
 * regardless of how long the subsequent fetch takes.
 */

import { getConversionRates } from './api';

// How long a cached rate is considered fresh (5 minutes).
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * @typedef {Object} CacheEntry
 * @property {number} fetchedAt  - epoch ms when the rates were fetched
 * @property {Object} rates      - the rates object from the API response
 */

/** @type {Map<string, CacheEntry>} */
const _cache = new Map();

/**
 * Returns true if the cache holds a non-expired entry for the given key.
 *
 * This is the ONLY place freshness is evaluated.  Callers that need to
 * snapshot "was this already cached?" must call this *before* any await.
 *
 * @param {string} key
 * @returns {boolean}
 */
function _isFresh(key) {
  const entry = _cache.get(key);
  if (!entry) return false;
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

/**
 * Fetches and caches conversion rates for the given fiat currency code.
 *
 * Returns an object with shape:
 *   { rates: Object, cached: boolean, fetchedAt: number }
 *
 * `cached` is `true` when the result came from a non-expired in-memory entry
 * and no network request was made; `false` when a live fetch was performed
 * (whether or not the cache was warm before — a live fetch is never "cached").
 *
 * @param {string} [currency="USD"]
 * @returns {Promise<{ rates: Object, cached: boolean, fetchedAt: number }>}
 */
export async function getConversionRatesCached(currency = 'USD') {
  const key = currency.toUpperCase();

  // ── Snapshot freshness BEFORE any async work ──────────────────────────────
  // This is the critical fix for #1213: the `cached` flag reflects whether the
  // cache was fresh at the moment of the call, not at the moment the promise
  // resolves.  A genuine live fetch always sets cached=false even if the fetch
  // completes before the old TTL would have expired on a re-check.
  const wasCached = _isFresh(key);

  if (wasCached) {
    const entry = _cache.get(key);
    return {
      rates: entry.rates,
      cached: true,
      fetchedAt: entry.fetchedAt,
    };
  }

  // Cache miss or stale — perform a live network fetch.
  const { data } = await getConversionRates();

  // Normalise: the API may return { rates: { USD: 0.12 } } or { USD: 0.12 }.
  const rates = data?.rates ?? data ?? {};

  const fetchedAt = Date.now();
  _cache.set(key, { fetchedAt, rates });

  return {
    rates,
    cached: false,   // live fetch — never cached, regardless of timing
    fetchedAt,
  };
}

/**
 * Converts an XLM amount to the target fiat currency using cached rates.
 *
 * @param {number} xlmAmount
 * @param {string} [currency="USD"]
 * @returns {Promise<{ fiatAmount: number|null, rate: number|null, currency: string, cached: boolean }>}
 */
export async function convertXlmToFiat(xlmAmount, currency = 'USD') {
  const { rates, cached } = await getConversionRatesCached(currency);
  const key = currency.toUpperCase();
  const rate = rates?.[key] ?? rates?.USD ?? null;

  if (rate == null || xlmAmount == null || xlmAmount < 0) {
    return { fiatAmount: null, rate: null, currency: key, cached };
  }

  const fiatAmount = parseFloat((xlmAmount * rate).toFixed(2));
  return { fiatAmount, rate, currency: key, cached };
}

/**
 * Resets the in-memory cache.  Exposed for testing only.
 */
export function _resetCache() {
  _cache.clear();
}

/**
 * Returns a snapshot of the current cache.  Exposed for testing only.
 */
export function _getCacheSnapshot() {
  const snapshot = {};
  for (const [key, entry] of _cache.entries()) {
    snapshot[key] = { ...entry };
  }
  return snapshot;
}
