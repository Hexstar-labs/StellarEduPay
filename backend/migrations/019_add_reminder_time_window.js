'use strict';

/**
 * Migration 017 — Add default reminderTimeWindow to all schools
 *
 * Sets schools.settings.reminderTimeWindow to { startHour: 8, endHour: 18 }
 * for schools that have a settings object but no reminderTimeWindow.
 */

const mongoose = require('mongoose');

const VERSION = '019_add_reminder_time_window';

async function up() {
  const db = mongoose.connection.db;
  const result = await db.collection('schools').updateMany(
    { 'settings.reminderTimeWindow': { $exists: false } },
    { $set: { 'settings.reminderTimeWindow': { startHour: 8, endHour: 18 } } }
  );
  console.log(`[Migration 017] Added default reminderTimeWindow to ${result.modifiedCount} schools`);
}

async function down() {
  const db = mongoose.connection.db;
  const result = await db.collection('schools').updateMany(
    {},
    { $unset: { 'settings.reminderTimeWindow': '' } }
  );
  console.log(`[Migration 017] Removed reminderTimeWindow from ${result.modifiedCount} schools`);
}

module.exports = { version: VERSION, up, down };
