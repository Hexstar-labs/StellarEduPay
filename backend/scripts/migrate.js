#!/usr/bin/env node
'use strict';

/**
 * Migration CLI (container / deploy entrypoint)
 *
 * Unlike the repo-root scripts/migrate.js (which reaches up into backend/ and
 * is meant for local development from a full checkout), this script lives
 * inside the backend/ tree so it is present in the production Docker image and
 * can be invoked as the deploy-time migration step:
 *
 *   node scripts/migrate.js           # run all pending migrations
 *   node scripts/migrate.js rollback  # roll back the last applied migration
 *
 * It reuses the application's own database connection configuration so pool,
 * timeout and write-concern behaviour matches the running service exactly.
 */

require('dotenv').config();

const db = require('../src/config/database');
const { runMigrations, rollback } = require('../src/services/migrationRunner');

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('[migrate] MONGO_URI is not set');
    process.exit(1);
  }

  await db.connect();

  const command = process.argv[2];
  if (command === 'rollback') {
    await rollback();
  } else {
    await runMigrations();
  }

  await db.disconnect();
}

main().catch(err => {
  if (err instanceof ReferenceError) {
    console.error(
      '[migrate] Migration runner crashed with a ReferenceError — this is a ' +
      'code defect in migrationRunner.js, not an operational migration ' +
      'failure against the database:', err,
    );
  } else {
    console.error('[migrate] Migration run failed:', err);
  }
  process.exit(1);
});
