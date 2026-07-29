'use strict';

/**
 * Migration 025 — Scope the paymentIntents.memo unique index to schoolId
 *
 * paymentIntentModel.js previously declared `memo` with a global unique:true
 * index. Memos are only guaranteed unique within a school, so two different
 * schools producing the same memo hit a raw duplicate-key error (#1202).
 * Replace the global unique index with a compound { schoolId: 1, memo: 1 }
 * unique index.
 */

const mongoose = require('mongoose');

const VERSION = '025_scope_payment_intent_memo_index';

async function up() {
  const collection = mongoose.connection.collection('paymentintents');

  const indexes = await collection.indexes();
  const globalMemoIndex = indexes.find(
    (idx) => idx.unique && idx.key && Object.keys(idx.key).length === 1 && idx.key.memo !== undefined
  );
  if (globalMemoIndex) {
    await collection.dropIndex(globalMemoIndex.name);
    console.log(`[025] Dropped global unique memo index: ${globalMemoIndex.name}`);
  }

  await collection.createIndex(
    { schoolId: 1, memo: 1 },
    { unique: true, background: true, name: 'schoolId_1_memo_1_unique' }
  );
  console.log('[025] Created compound unique index on paymentintents: { schoolId: 1, memo: 1 }');
}

async function down() {
  const collection = mongoose.connection.collection('paymentintents');

  const indexes = await collection.indexes();
  const compoundIndex = indexes.find((idx) => idx.name === 'schoolId_1_memo_1_unique');
  if (compoundIndex) {
    await collection.dropIndex(compoundIndex.name);
    console.log('[025] Dropped compound unique memo index');
  }

  await collection.createIndex({ memo: 1 }, { unique: true, background: true });
  console.log('[025] Recreated global unique index on paymentintents.memo');
}

module.exports = { version: VERSION, up, down };
