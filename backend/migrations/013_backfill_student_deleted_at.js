'use strict';

/**
 * Migration 012: Backfill deletedAt field for all existing students
 * 
 * Sets deletedAt: null for all students that don't have the field.
 * This ensures soft-delete filtering works correctly for all records.
 */

const mongoose = require('mongoose');

const VERSION = '013_backfill_student_deleted_at';

async function up() {
  const db = mongoose.connection.db;
  const result = await db.collection('students').updateMany(
    { deletedAt: { $exists: false } },
    { $set: { deletedAt: null } }
  );
  console.log(`[Migration 012] Backfilled deletedAt for ${result.modifiedCount} students`);
}

async function down() {
  const db = mongoose.connection.db;
  const result = await db.collection('students').updateMany(
    { deletedAt: null },
    { $unset: { deletedAt: '' } }
  );
  console.log(`[Migration 012] Removed deletedAt from ${result.modifiedCount} students`);
}

module.exports = { version: VERSION, up, down };
