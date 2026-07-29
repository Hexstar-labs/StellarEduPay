'use strict';

/**
 * Issue #1175 — Route File Coverage Check
 *
 * Dynamically inspects every *.js file under backend/src/routes/ and asserts
 * that each one is both required AND mounted inside backend/src/app.js.
 *
 * This is a CI guard to prevent future routes from being written but forgotten
 * in the app's route-mounting block (the exact class of bug fixed in #1175
 * where auditRoutes existed but was never mounted, causing 404s on GET /api/audit).
 */

const fs = require('fs');
const path = require('path');

// ── Collect all route files ───────────────────────────────────────────────────

const ROUTES_DIR = path.resolve(__dirname, '../backend/src/routes');
const APP_JS     = path.resolve(__dirname, '../backend/src/app.js');

// Files that intentionally do not need to be mounted as standalone route groups
// (e.g. internal helpers, sub-routers mounted by another route file, etc.)
const EXCLUDE = new Set([
  // retryQueueRoutes.js is mounted conditionally at runtime via
  // config/retryQueueSetup.js → initializeRetryQueue(app) when Redis is
  // available. It is NOT directly required in app.js.
  'retryQueueRoutes.js',
]);

function getRouteFiles() {
  return fs
    .readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.js') && !EXCLUDE.has(f))
    .map(f => ({ filename: f, basename: path.basename(f, '.js') }));
}

// ── Read app.js once ──────────────────────────────────────────────────────────

const appContent = fs.readFileSync(APP_JS, 'utf8');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if app.js contains a require() call for the route module.
 * Matches both:
 *   require('./routes/<basename>')
 *   require('./routes/<basename>.js')
 */
function isRequired(basename) {
  const pattern = new RegExp(
    `require\\s*\\(\\s*['"]\\./routes/${basename}(?:\\.js)?['"]\\s*\\)`,
  );
  return pattern.test(appContent);
}

/**
 * Returns true if app.js contains an app.use() call that mounts the route.
 * Matches: app.use('/api/...', <basename>)  — flexible about leading whitespace
 * and quote style.
 *
 * We derive the variable name from the require() call because some route files
 * use a different variable name from the file name
 * (e.g. `const metricsRoute = require('./routes/metricsRoute')`).
 */
function isMounted(basename) {
  // Extract the variable name used in the require assignment, e.g.
  //   const fooRoutes = require('./routes/fooRoutes')  →  'fooRoutes'
  const requirePattern = new RegExp(
    `const\\s+(\\w+)\\s*=\\s*require\\s*\\(\\s*['"]\\./routes/${basename}(?:\\.js)?['"]\\s*\\)`,
  );
  const match = appContent.match(requirePattern);
  const varName = match ? match[1] : basename;

  // Check app.use(<string>, <varName>) — generic mount check
  const mountPattern = new RegExp(
    `app\\.use\\s*\\([^)]*,\\s*${varName}\\s*\\)`,
  );
  return mountPattern.test(appContent);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('#1175 — all route files must be required and mounted in app.js', () => {
  const routeFiles = getRouteFiles();

  // Sanity check: the scanner found some route files
  test('route scanner found at least one route file', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  describe('each route file is required in app.js', () => {
    routeFiles.forEach(({ filename, basename }) => {
      test(`${filename} is required`, () => {
        expect(isRequired(basename)).toBe(true);
      });
    });
  });

  describe('each route file is mounted via app.use() in app.js', () => {
    routeFiles.forEach(({ filename, basename }) => {
      test(`${filename} is mounted`, () => {
        expect(isMounted(basename)).toBe(true);
      });
    });
  });

  // Aggregate report for CI — lists every missing file in one failure message
  test('no route files are missing from app.js (aggregate check)', () => {
    const notRequired = routeFiles.filter(({ basename }) => !isRequired(basename));
    const notMounted  = routeFiles.filter(({ basename }) => !isMounted(basename));

    const messages = [];
    if (notRequired.length > 0) {
      messages.push(
        `Route files NOT required in app.js:\n  ${notRequired.map(r => r.filename).join('\n  ')}`,
      );
    }
    if (notMounted.length > 0) {
      messages.push(
        `Route files NOT mounted in app.js:\n  ${notMounted.map(r => r.filename).join('\n  ')}`,
      );
    }

    if (messages.length > 0) {
      throw new Error(messages.join('\n\n'));
    }
  });
});
