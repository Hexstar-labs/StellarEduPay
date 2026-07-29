#!/usr/bin/env node
/**
 * check-version-drift.js
 *
 * Fails if any shared dependency's declared major version differs between the
 * root package.json and any workspace package.json (backend, frontend).
 *
 * Usage:
 *   node scripts/check-version-drift.js
 *
 * Exit codes:
 *   0 — no major-version drift detected
 *   1 — one or more drift violations found
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Parse major version from a semver range string (e.g. "^8.0.0" → 8). */
function parseMajor(range) {
  if (!range) return null;
  // Strip leading range specifiers: ^, ~, >=, <=, =, >, <, whitespace
  const cleaned = range.replace(/^[~^>=<\s]+/, '').trim();
  const match = cleaned.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Read and parse a package.json file, returning its combined dependencies map. */
function readDeps(pkgPath) {
  const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return Object.assign(
    {},
    raw.dependencies || {},
    raw.devDependencies || {},
    raw.peerDependencies || {}
  );
}

const workspaces = [
  { label: 'backend', pkgPath: path.join(ROOT, 'backend', 'package.json') },
  { label: 'frontend', pkgPath: path.join(ROOT, 'frontend', 'package.json') },
];

const rootDeps = readDeps(path.join(ROOT, 'package.json'));

let violations = 0;

for (const ws of workspaces) {
  if (!fs.existsSync(ws.pkgPath)) {
    continue;
  }
  const wsDeps = readDeps(ws.pkgPath);

  for (const [pkg, wsRange] of Object.entries(wsDeps)) {
    if (!(pkg in rootDeps)) continue; // package not in root — no drift to detect

    const rootMajor = parseMajor(rootDeps[pkg]);
    const wsMajor = parseMajor(wsRange);

    if (rootMajor === null || wsMajor === null) continue; // non-semver range, skip

    if (rootMajor !== wsMajor) {
      console.error(
        `[version-drift] MISMATCH: "${pkg}" — root declares major ${rootMajor} ` +
          `(${rootDeps[pkg]}), ${ws.label} declares major ${wsMajor} (${wsRange})`
      );
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(
    `\n${violations} major-version drift violation(s) found. ` +
      'Align the version ranges in the affected package.json files and re-run.'
  );
  process.exit(1);
} else {
  console.log('check-version-drift: no major-version drift detected.');
}
