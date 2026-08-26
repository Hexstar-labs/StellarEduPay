/**
 * Migration: Add TTL index to auditLogModel
 * 
 * This migration adds a TTL (time-to-live) index to the AuditLog collection
 * to automatically expire documents after the configured retention period.
 * 
 * Default retention: 730 days (2 years)
 * Configurable via: AUDIT_LOG_TTL_DAYS environment variable
 */

const mongoose = require('mongoose');

const VERSION = '002_add_audit_log_ttl_index';

async function up() {
  const ttlDays = parseInt(process.env.AUDIT_LOG_TTL_DAYS || '730', 10);
  const ttlSeconds = ttlDays * 24 * 60 * 60;

  const db = mongoose.connection;
  const collection = db.collection('auditlogs');

  try {
    // Drop existing TTL index if it exists. getIndexes() throws
    // NamespaceNotFound (code 26) when the collection has never been
    // created (e.g. a fresh database) — that just means there is nothing to
    // drop yet, not a failure.
    let indexes = {};
    try {
      indexes = await collection.getIndexes();
    } catch (error) {
      if (error.code !== 26) throw error;
    }
    for (const [indexName, indexSpec] of Object.entries(indexes)) {
      if (indexSpec.expireAfterSeconds !== undefined) {
        await collection.dropIndex(indexName);
        console.log(`Dropped existing TTL index: ${indexName}`);
      }
    }

    // Create new TTL index
    await collection.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: ttlSeconds }
    );
    console.log(`Created TTL index with ${ttlDays} days retention (${ttlSeconds} seconds)`);
  } catch (error) {
    console.error('Error creating TTL index:', error);
    throw error;
  }
}

async function down() {
  const db = mongoose.connection;
  const collection = db.collection('auditlogs');

  try {
    let indexes = {};
    try {
      indexes = await collection.getIndexes();
    } catch (error) {
      if (error.code !== 26) throw error;
    }
    for (const [indexName, indexSpec] of Object.entries(indexes)) {
      if (indexSpec.expireAfterSeconds !== undefined) {
        await collection.dropIndex(indexName);
        console.log(`Dropped TTL index: ${indexName}`);
      }
    }
  } catch (error) {
    console.error('Error dropping TTL index:', error);
    throw error;
  }
}

module.exports = { version: VERSION, up, down };
