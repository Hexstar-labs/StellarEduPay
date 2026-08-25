'use strict';

/**
 * Migration 012: Add performance indexes to Student collection
 *
 * Ensures { schoolId: 1, class: 1 } and { schoolId: 1, feePaid: 1 } indexes
 * exist for class-based and payment status queries.
 */

const mongoose = require('mongoose');

const VERSION = '012_add_student_indexes';

async function up() {
  const db = mongoose.connection.db;
  const collection = db.collection('students');

  const existingIndexes = await collection.indexes().catch((err) => {
    if (err.code === 26) return [];
    throw err;
  });

  const classIndexExists = existingIndexes.some(
    (i) => i.key && i.key.schoolId === 1 && i.key.class === 1
  );
  if (!classIndexExists) {
    await collection.createIndex({ schoolId: 1, class: 1 });
    console.log('[Migration 012] Created index: { schoolId: 1, class: 1 }');
  }

  const feePaidIndexExists = existingIndexes.some(
    (i) => i.key && i.key.schoolId === 1 && i.key.feePaid === 1
  );
  if (!feePaidIndexExists) {
    await collection.createIndex({ schoolId: 1, feePaid: 1 });
    console.log('[Migration 012] Created index: { schoolId: 1, feePaid: 1 }');
  }
}

async function down() {
  const db = mongoose.connection.db;
  const collection = db.collection('students');

  for (const key of [{ schoolId: 1, class: 1 }, { schoolId: 1, feePaid: 1 }]) {
    try {
      await collection.dropIndex(key);
      console.log(`[Migration 012] Dropped index: ${JSON.stringify(key)}`);
    } catch (err) {
      if (err.code === 27 || err.code === 26) {
        // Index/collection does not exist — no-op
        continue;
      }
      throw err;
    }
  }
}

module.exports = { version: VERSION, up, down };
