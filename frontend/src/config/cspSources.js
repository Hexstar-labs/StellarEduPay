/**
 * CSP external-origin allow-list — single source of truth.
 *
 * Both `frontend/next.config.js` (runtime policy) and `tests/csp.test.js`
 * (assertions) import from here, so adding or removing an origin requires
 * editing exactly one file and is automatically reflected in both the deployed
 * CSP header and the test suite.
 *
 * HOW TO ADD A NEW ORIGIN
 * -----------------------
 * 1. Add the full origin (scheme + host, no trailing slash) to the appropriate
 *    array below.
 * 2. That's it — next.config.js and csp.test.js pick it up automatically.
 *
 * Do NOT add 'unsafe-inline' or 'unsafe-eval' to script-src origins.
 * Use a nonce-based approach if a third-party library requires inline scripts.
 */

/** Origins permitted in `connect-src` (fetch / XHR / WebSocket targets). */
const CONNECT_SRC_ORIGINS = [
  'https://horizon-testnet.stellar.org',
  'https://horizon.stellar.org',
];

/** Origins permitted in `style-src` (external stylesheets). */
const STYLE_SRC_ORIGINS = [
  'https://fonts.googleapis.com',
];

/** Origins permitted in `font-src` (external font files). */
const FONT_SRC_ORIGINS = [
  'https://fonts.gstatic.com',
];

module.exports = { CONNECT_SRC_ORIGINS, STYLE_SRC_ORIGINS, FONT_SRC_ORIGINS };
