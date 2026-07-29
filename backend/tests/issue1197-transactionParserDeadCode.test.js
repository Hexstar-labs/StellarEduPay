'use strict';

/**
 * Tests for issue #1197: transactionParser.js dead-code removal.
 *
 * Verifies:
 * 1. transactionParser.js no longer exists in the codebase.
 * 2. The parsers/ subdirectory (memoExtractor, amountExtractor) no longer exists.
 * 3. No production source file imports transactionParser or parsers/.
 * 4. Exactly one transaction-parsing implementation exists and is used in production
 *    (stellarService.js handles parsing internally).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC_ROOT = path.resolve(__dirname, '../src');
const SERVICES_DIR = path.resolve(SRC_ROOT, 'services');

describe('#1197 — transactionParser.js dead code removed', () => {
  it('transactionParser.js does not exist in the services directory', () => {
    const filePath = path.join(SERVICES_DIR, 'transactionParser.js');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('parsers/memoExtractor.js does not exist', () => {
    const filePath = path.join(SERVICES_DIR, 'parsers', 'memoExtractor.js');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('parsers/amountExtractor.js does not exist', () => {
    const filePath = path.join(SERVICES_DIR, 'parsers', 'amountExtractor.js');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('parsers/ subdirectory does not exist', () => {
    const dir = path.join(SERVICES_DIR, 'parsers');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('no production source file imports transactionParser', () => {
    // Walk all .js files under src/ and check for any require of transactionParser.
    const allFiles = walkJs(SRC_ROOT);
    const importers = allFiles.filter(f => {
      const content = fs.readFileSync(f, 'utf8');
      return content.includes('transactionParser') || content.includes('TransactionParser');
    });
    expect(importers).toHaveLength(0);
  });

  it('no production source file imports from parsers/', () => {
    const allFiles = walkJs(SRC_ROOT);
    const importers = allFiles.filter(f => {
      const content = fs.readFileSync(f, 'utf8');
      return content.includes('./parsers/') || content.includes('../parsers/');
    });
    expect(importers).toHaveLength(0);
  });

  it('stellarService.js still exists as the canonical transaction parser', () => {
    const stellarService = path.join(SERVICES_DIR, 'stellarService.js');
    expect(fs.existsSync(stellarService)).toBe(true);
  });
});

/**
 * Recursively collect all .js files under a directory (excluding node_modules).
 * @param {string} dir
 * @returns {string[]}
 */
function walkJs(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkJs(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}
