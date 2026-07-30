'use strict';

// Constant-time string comparison to prevent timing-based token enumeration.
const { timingSafeEqual } = require('crypto');
const { rl } = require('./rateLimiter');

// Minimum token entropy: 32 hex chars = 128-bit key; reject obviously weak tokens.
const MIN_TOKEN_LENGTH = 32;

// Known insecure placeholder values that must never be used in any environment.
// If the configured token matches any of these, the metrics endpoint is disabled
// and (in production) the server refuses to start.
const PLACEHOLDER_TOKENS = new Set([
  'change_me_to_a_secure_random_token',
  'REPLACE_WITH_METRICS_TOKEN',
  'your_metrics_token_here',
  'changeme',
]);

// Dedicated rate-limiter for /metrics — separate from the main API limiter so
// Prometheus scrapes are not throttled by normal API traffic and vice-versa.
// Abuse of the unauthenticated-fast-path is bounded to 60 attempts/minute.
// Uses Redis-backed storage shared across replicas when REDIS_HOST is configured.
const metricsRateLimiter = rl(
  60 * 1000,
  60,
  { error: 'Too many requests to metrics endpoint.', code: 'RATE_LIMIT_EXCEEDED' }
);

function safeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Validate the METRICS_BEARER_TOKEN (or METRICS_TOKEN) at server startup.
 *
 * Called from app.js before the HTTP server binds. In production, a placeholder
 * or missing token causes a fatal exit so the server never exposes an insecure
 * metrics endpoint. In non-production environments, a warning is logged instead.
 *
 * @param {object} opts
 * @param {boolean} [opts.isProduction] — defaults to NODE_ENV === 'production'
 */
function validateMetricsTokenOnStartup({ isProduction } = {}) {
  const production = isProduction !== undefined
    ? isProduction
    : process.env.NODE_ENV === 'production';

  // Accept METRICS_BEARER_TOKEN (preferred) or legacy METRICS_TOKEN.
  const token = process.env.METRICS_BEARER_TOKEN || process.env.METRICS_TOKEN;

  if (!token) {
    const msg =
      '[startup] METRICS_BEARER_TOKEN is not set. ' +
      'The /metrics endpoint will be disabled. ' +
      'Set METRICS_BEARER_TOKEN to a strong random token (openssl rand -hex 32).';
    if (production) {
      // Fatal in production — an unprotected metrics endpoint leaks internals.
      throw new Error(msg);
    }
    // Non-fatal warning in development/test.
    console.warn(msg);
    return;
  }

  if (PLACEHOLDER_TOKENS.has(token)) {
    const msg =
      `[startup] METRICS_BEARER_TOKEN is set to a known insecure placeholder ("${token}"). ` +
      'This token must be rotated before the service handles real traffic. ' +
      'Generate a secure token with: openssl rand -hex 32';
    if (production) {
      throw new Error(msg);
    }
    console.warn(msg);
    return;
  }

  if (token.length < MIN_TOKEN_LENGTH) {
    const msg =
      `[startup] METRICS_BEARER_TOKEN is too short (${token.length} chars, min ${MIN_TOKEN_LENGTH}). ` +
      'Generate a secure token with: openssl rand -hex 32';
    if (production) {
      throw new Error(msg);
    }
    console.warn(msg);
  }
}

function metricsAuth(req, res, next) {
  // Accept METRICS_BEARER_TOKEN (preferred) or legacy METRICS_TOKEN.
  const token = process.env.METRICS_BEARER_TOKEN || process.env.METRICS_TOKEN;

  if (!token) {
    return res.status(500).set('Content-Type', 'text/plain').send(
      '# METRICS_BEARER_TOKEN is not configured — metrics endpoint is disabled.\n'
    );
  }

  if (PLACEHOLDER_TOKENS.has(token)) {
    return res.status(500).set('Content-Type', 'text/plain').send(
      `# METRICS_BEARER_TOKEN is an insecure placeholder — metrics endpoint is disabled.\n` +
      `# Rotate the token with: openssl rand -hex 32\n`
    );
  }

  if (token.length < MIN_TOKEN_LENGTH) {
    return res.status(500).set('Content-Type', 'text/plain').send(
      `# METRICS_BEARER_TOKEN is too short (min ${MIN_TOKEN_LENGTH} chars) — metrics endpoint is disabled.\n`
    );
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.set('WWW-Authenticate', 'Bearer realm="metrics"');
    return res.status(401).set('Content-Type', 'text/plain').send(
      '# Unauthorized: provide Authorization: Bearer <METRICS_BEARER_TOKEN>\n'
    );
  }

  const provided = authHeader.slice(7);
  if (!safeCompare(provided, token)) {
    return res.status(403).set('Content-Type', 'text/plain').send(
      '# Forbidden: invalid metrics token.\n'
    );
  }

  next();
}

module.exports = { metricsAuth, metricsRateLimiter, validateMetricsTokenOnStartup, PLACEHOLDER_TOKENS };
