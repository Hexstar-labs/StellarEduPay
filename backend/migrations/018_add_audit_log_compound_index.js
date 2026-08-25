'use strict';

/**
 * Migration 016 — Add compound index on auditLogs for { schoolId, createdAt }
 * Issue #668: Audit log queries are slow for busy schools without this index
 * 
 * This migration creates a compound index to optimize queries that filter by
 * schoolId and sort by createdAt (descending), which is the common pattern
 * for audit log pagination.
 */

const mongoose = require('mongoose');

const VERSION = '018_add_audit_log_compound_index';

async function up() {
  const db = mongoose.connection.db;
  const collection = db.collection('auditlogs');

  try {
    // Create compound index { schoolId: 1, createdAt: -1 }
    await collection.createIndex(
      { schoolId: 1, createdAt: -1 },
      { name: 'schoolId_1_createdAt_-1' }
    );
    console.log('✓ Created compound index on auditlogs: { schoolId: 1, createdAt: -1 }');
  } catch (err) {
    if (err.code === 85) {
      // Index already exists with different options — drop and recreate
      await collection.dropIndex('schoolId_1_createdAt_-1');
      await collection.createIndex(
        { schoolId: 1, createdAt: -1 },
        { name: 'schoolId_1_createdAt_-1' }
      );
      console.log('✓ Recreated compound index on auditlogs: { schoolId: 1, createdAt: -1 }');
    } else {
      throw err;
    }
  }
}

async function down() {
  const db = mongoose.connection.db;
  const collection = db.collection('auditlogs');

  try {
    await collection.dropIndex('schoolId_1_createdAt_-1');
    console.log('✓ Dropped compound index on auditlogs: { schoolId: 1, createdAt: -1 }');
  } catch (err) {
    if (err.code === 27) {
      // Index doesn't exist — no-op
      console.log('✓ Index does not exist, skipping drop');
    } else {
      throw err;
    }
  }
}

module.exports = { version: VERSION, up, down };
