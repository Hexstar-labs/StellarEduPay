'use strict';

const { checkConsistency } = require('./consistencyService');
const School = require('../models/schoolModel');
const logger = require('../utils/logger').child('ConsistencyScheduler');
const { ping, markStarted, markStopped, WORKER_NAMES } = require('./workerHeartbeat');

const INTERVAL_MS = parseInt(process.env.CONSISTENCY_CHECK_INTERVAL_MS, 10) || 5 * 60 * 1000;
let _timer = null;

async function runCheck() {
  try {
    if (!await School.countDocuments({ isActive: true })) {
      // No active schools — still a successful cycle.
      ping(WORKER_NAMES.CONSISTENCY_SCHEDULER);
      return;
    }
    const report = await checkConsistency();
    if (report.mismatchCount > 0) {
      logger.warn(`${report.mismatchCount} mismatch(es) detected`, { mismatches: report.mismatches });
    }
    ping(WORKER_NAMES.CONSISTENCY_SCHEDULER);
  } catch (err) {
    logger.error('Consistency check failed', { error: err.message });
    // Still ping on error so the heartbeat reflects that the scheduler ran
    // (even if the underlying check failed). This prevents false liveness alerts
    // caused by transient upstream errors.
    ping(WORKER_NAMES.CONSISTENCY_SCHEDULER);
  }
}

function startConsistencyScheduler() {
  if (_timer) return;
  markStarted(WORKER_NAMES.CONSISTENCY_SCHEDULER);
  runCheck();
  _timer = setInterval(runCheck, INTERVAL_MS);
}

function stopConsistencyScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    markStopped(WORKER_NAMES.CONSISTENCY_SCHEDULER);
  }
}

module.exports = { startConsistencyScheduler, stopConsistencyScheduler };
