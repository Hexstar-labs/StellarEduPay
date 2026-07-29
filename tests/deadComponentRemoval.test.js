'use strict';

/**
 * Acceptance-criteria tests for the removal of three dead frontend components:
 *   - PaymentTable.jsx
 *   - TransactionCard.jsx
 *   - AuditLog.jsx
 *
 * These components had no live imports anywhere in the application.
 * TransactionCard duplicated dispute/payment logic already present in the
 * maintained PaymentForm component, with weaker input validation.
 *
 * Each test asserts:
 *   1. The file no longer exists on disk.
 *   2. No source file in the frontend imports it.
 */

const fs   = require('fs');
const path = require('path');

const FRONTEND_SRC = path.join(__dirname, '../frontend/src');
const COMPONENTS   = path.join(FRONTEND_SRC, 'components');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively collect all .js/.jsx files under a directory.
 */
function collectSourceFiles(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, results);
    } else if (/\.[jt]sx?$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Returns every frontend source file that contains an import of `componentName`
 * (matches both default and named import styles, with or without extension).
 */
function filesImporting(componentName) {
  const re = new RegExp(`import[^'"]+['"][^'"]*${componentName}['"]`, 'i');
  return collectSourceFiles(FRONTEND_SRC).filter((file) =>
    re.test(fs.readFileSync(file, 'utf8'))
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Dead component removal — PaymentTable', () => {
  const filePath = path.join(COMPONENTS, 'PaymentTable.jsx');

  it('PaymentTable.jsx does not exist on disk', () => {
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('no frontend source file imports PaymentTable', () => {
    expect(filesImporting('PaymentTable')).toHaveLength(0);
  });
});

describe('Dead component removal — TransactionCard', () => {
  const filePath = path.join(COMPONENTS, 'TransactionCard.jsx');

  it('TransactionCard.jsx does not exist on disk', () => {
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('no frontend source file imports TransactionCard', () => {
    expect(filesImporting('TransactionCard')).toHaveLength(0);
  });
});

describe('Dead component removal — AuditLog (component)', () => {
  const filePath = path.join(COMPONENTS, 'AuditLog.jsx');

  it('AuditLog.jsx does not exist on disk', () => {
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('no frontend source file imports the AuditLog component', () => {
    // Only match the component file path, not the backend model or service names.
    const re = /import[^'"]+['"][^'"]*components\/AuditLog['"]/i;
    const importing = collectSourceFiles(FRONTEND_SRC).filter((file) =>
      re.test(fs.readFileSync(file, 'utf8'))
    );
    expect(importing).toHaveLength(0);
  });
});
