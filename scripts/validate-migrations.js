#!/usr/bin/env node

/**
 * Migration Numbering Validation Script
 *
 * Ensures all migration files have unique, strictly increasing numeric prefixes.
 * Prevents the issues described in #1037 where duplicate migration numbers
 * created ambiguous execution ordering.
 *
 * As of #1290 it also fails when any file in the repository requires/imports a
 * migration path that does not resolve (e.g. a test pinned to an ordinal that was
 * later renumbered). This catches the gap that the migration-numbering check
 * could not: a dangling reference to a migration by number.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../backend/migrations');
const REPO_ROOT = path.join(__dirname, '..');

// Directories that are never sources of migration references we want to lint.
const IGNORED_DIRS = new Set(['node_modules', 'coverage', '.git', 'dist', 'build', '.next']);

function validateMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js'));

  const migrations = {};
  const issues = [];

  for (const file of files) {
    // Match files like 001_name.js or unnumbered files
    const match = file.match(/^(\d{3})_(.+)\.js$/);

    if (!match) {
      // Unnumbered files should not exist (unless legacy allowed)
      if (!file.match(/^\d{3}_/)) {
        issues.push(`❌ Unnumbered migration file found: ${file}`);
      }
      continue;
    }

    const [, number, name] = match;

    // Check for duplicate numbers
    if (migrations[number]) {
      issues.push(
        `❌ Duplicate migration number ${number}:\n` +
        `   - ${migrations[number]}\n` +
        `   - ${file}`
      );
    } else {
      migrations[number] = file;
    }
  }

  // Check that numbers are sequential (no gaps)
  const numbers = Object.keys(migrations)
    .map(n => parseInt(n, 10))
    .sort((a, b) => a - b);

  if (numbers.length > 0) {
    const firstNum = numbers[0];
    const lastNum = numbers[numbers.length - 1];

    // Check for gaps
    for (let i = firstNum; i <= lastNum; i++) {
      const padded = String(i).padStart(3, '0');
      if (!migrations[padded]) {
        issues.push(`⚠️  Gap detected: Migration ${padded} is missing`);
      }
    }
  }

  // A reference to a migration that no longer resolves is just as bad as a
  // numbering collision: it produces a red suite that looks like a code defect.
  issues.push(...findDanglingMigrationReferences());

  if (issues.length > 0) {
    console.error('❌ Migration validation failed!\n');
    issues.forEach(issue => console.error(issue));
    console.error('\n✅ Migration validation rules:');
    console.error('  • All migration files must be named: NNN_description.js (NNN = 3 digits)');
    console.error('  • Migration numbers must be unique');
    console.error('  • Migration numbers should be sequential (001, 002, 003, ...)');
    console.error('  • No file may require/import a migration path that does not resolve');
    process.exit(1);
  }

  console.log(`✅ Migration validation passed! (${numbers.length} migrations found)`);
  console.log('   Migrations are properly numbered and sequenced.');
  console.log('   No dangling migration references detected.');
  process.exit(0);
}

/**
 * Walk the repository for `require(...)` / `import ... from '...'` literals that
 * reference a migration file by path, and fail if any of those paths do not
 * resolve. References are matched by the `NNN_` prefix segment so the check is
 * independent of directory depth. Bare module specifiers (e.g. `'qrcode.react'`)
 * and dynamic `require(variable)` calls are ignored.
 *
 * @returns {string[]} Human-readable failure messages (empty when clean)
 */
function findDanglingMigrationReferences() {
  const problems = [];
  const files = walk(REPO_ROOT);
  const requireRe = /require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const importRe = /import\s+(?:[^'"`]+\s+from\s+)?['"`]([^'"`]+)['"`]/g;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const refs = collectRefs(content, requireRe).concat(collectRefs(content, importRe));

    for (const ref of refs) {
      if (!isMigrationRef(ref)) continue;
      if (!resolves(ref, path.dirname(file))) {
        problems.push(
          `❌ Dangling migration reference in ${path.relative(REPO_ROOT, file)}:\n` +
          `   '${ref}' does not resolve to a migration file`
        );
      }
    }
  }

  return problems;
}

function collectRefs(content, regex) {
  const out = [];
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(content)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function isMigrationRef(p) {
  if (!p.includes('migrations')) return false;
  return p.split('/').some(seg => /^\d{3}_/.test(seg));
}

function resolves(p, fromDir) {
  // Only relative path references (starting with '.' or '/') point at a file we
  // can stat. Bare specifiers like 'qrcode.react' are skipped.
  if (!p.startsWith('.') && !p.startsWith('/')) return true;
  const abs = path.resolve(fromDir, p);
  return (
    fs.existsSync(abs) ||
    fs.existsSync(`${abs}.js`) ||
    fs.existsSync(`${abs}.json`)
  );
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name)));
    } else if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

validateMigrations();
