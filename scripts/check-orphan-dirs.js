#!/usr/bin/env node

/**
 * Near-miss sibling directory check
 *
 * Catches artefacts like backend/src/queu-copy/ — a misspelled, unreferenced
 * duplicate of backend/src/queue/ that survived several commits and drifted
 * out of sync with the file it was copied from (see #1266... see issue for
 * the queu-copy incident). A full "is anything in this directory required
 * anywhere in the tree" check is easy to get wrong (dynamic requires,
 * re-exports, entry points) and would produce false positives. Instead this
 * flags the narrower, high-confidence signal that actually caused the
 * incident: a directory name that looks like an editor's "duplicate" action
 * or a stray `cp -r` — either a near-typo of a sibling directory, or a
 * sibling name with a "copy/backup/old/tmp" style suffix stripped off.
 */

const fs = require('fs');
const path = require('path');

const SCAN_ROOT = path.join(__dirname, '../backend/src');

const IGNORED_DIRS = new Set(['node_modules', 'coverage', '.git', 'dist', 'build', '.next']);

// Suffixes (with an optional separator) that mark a directory as a copy of
// another one, e.g. "queu-copy", "utils_bak", "routes.old", "models-tmp2".
const DUPLICATE_SUFFIX_RE = /[-_. ]?(copy|old|backup|bak|dup|tmp|orig|original)\d*$/i;

// Sibling name pairs that happen to be edit-distance-close but are both
// intentional, unrelated directories. Add an entry here (as "a|b", either
// order) if a legitimate pair ever trips this check.
const ALLOWED_NEAR_MISSES = new Set([]);

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function listDirs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !IGNORED_DIRS.has(e.name))
    .map(e => e.name);
}

function walkDirs(dir, out = []) {
  const children = listDirs(dir);
  out.push({ parent: dir, names: children });
  for (const name of children) {
    walkDirs(path.join(dir, name), out);
  }
  return out;
}

function isAllowedPair(a, b) {
  return ALLOWED_NEAR_MISSES.has(`${a}|${b}`) || ALLOWED_NEAR_MISSES.has(`${b}|${a}`);
}

function checkOrphanDirs() {
  const issues = [];
  const groups = walkDirs(SCAN_ROOT);

  for (const { parent, names } of groups) {
    for (let i = 0; i < names.length; i++) {
      for (let j = 0; j < names.length; j++) {
        if (i === j) continue;
        const a = names[i];
        const b = names[j];
        if (isAllowedPair(a, b)) continue;

        const stripped = a.replace(DUPLICATE_SUFFIX_RE, '');
        const isSuffixedCopy = stripped !== a && levenshtein(stripped, b) <= 1;
        const isCloseTypo = levenshtein(a, b) === 1 && Math.min(a.length, b.length) >= 4;

        if (isSuffixedCopy || isCloseTypo) {
          const rel = path.relative(path.join(__dirname, '..'), parent) || '.';
          issues.push(
            `❌ '${a}' looks like a stray duplicate of sibling '${b}' in ${rel}/`
          );
        }
      }
    }
  }

  // Each unordered pair gets reported twice (once from each side); dedupe.
  const unique = [...new Set(issues)];

  if (unique.length > 0) {
    console.error('❌ Near-miss directory check failed!\n');
    unique.forEach(issue => console.error(issue));
    console.error('\nIf this is a false positive, add the pair to ALLOWED_NEAR_MISSES');
    console.error('in scripts/check-orphan-dirs.js. Otherwise, delete the stray directory');
    console.error('(or rename it if it is intentional and unrelated to its sibling).');
    process.exit(1);
  }

  console.log('✅ Near-miss directory check passed! No stray duplicate directories found.');
  process.exit(0);
}

checkOrphanDirs();
