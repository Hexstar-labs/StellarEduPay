'use strict';

const Student = require('../models/studentModel');
const Payment = require('../models/paymentModel');
const School = require('../models/schoolModel');
const ReconciliationReport = require('../models/reconciliationReportModel');
const { checkSchoolConsistency, fetchChainTransactions } = require('./consistencyService');
const logger = require('../utils/logger').child('ReconciliationService');

const INTERVAL_MS = parseInt(process.env.RECONCILIATION_INTERVAL_MS, 10) || 24 * 60 * 60 * 1000;
let _timer = null;

async function reconcileAll(schoolId) {
  const students = await Student.find(schoolId ? { schoolId } : {}).lean();
  let fixed = 0, errors = 0;

  for (const s of students) {
    try {
      const [agg] = await Payment.aggregate([
        { $match: { schoolId: s.schoolId, studentId: s.studentId, status: 'SUCCESS', deletedAt: null } },
        { $group: { _id: null, computedTotal: { $sum: '$amount' } } },
      ]);
      // creditAdjustments are intentional admin-applied manual credits.
      // Including them here ensures the 24-hour reconciliation cycle never
      // treats a partial-credit adjustment as drift and reverts it.
      const paymentTotal = agg?.computedTotal ?? 0;
      const creditAdjustments = s.creditAdjustments || 0;
      const computed = parseFloat((paymentTotal + creditAdjustments).toFixed(7));
      if (Math.abs(computed - (s.totalPaid || 0)) > 0.0000001) {
        logger.warn('Reconciliation mismatch — correcting', { schoolId: s.schoolId, studentId: s.studentId, diff: computed - (s.totalPaid || 0) });
        await Student.findOneAndUpdate(
          { schoolId: s.schoolId, studentId: s.studentId },
          { totalPaid: computed, remainingBalance: Math.max(0, s.feeAmount - computed), feePaid: computed >= s.feeAmount },
        );
        fixed++;
      }
    } catch (err) {
      errors++;
      logger.error('Reconciliation error', { studentId: s.studentId, error: err.message });
    }
  }

  logger.info('Reconciliation complete', { checked: students.length, fixed, errors });
  return { checked: students.length, fixed, errors };
}

function startReconciliationScheduler() {
  if (_timer) return;
  _timer = setInterval(async () => { try { await reconcileAll(); } catch (err) { logger.error('Scheduler error', { error: err.message }); } }, INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}

function stopReconciliationScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

async function generateReconciliationReport(schoolId) {
  try {
    const school = await School.findOne({ schoolId }).lean();
    if (!school) {
      logger.warn('School not found for reconciliation report', { schoolId });
      return null;
    }

    const [dbPayments, chainTxs] = await Promise.all([
      Payment.find({ schoolId, status: 'SUCCESS', deletedAt: null }).lean(),
      fetchChainTransactions(school.stellarAddress),
    ]);

    const dbTotalCredited = dbPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

    let chainTotalReceived = 0;
    for (const tx of chainTxs) {
      const ops = await tx.operations();
      const payOp = ops.records.find(
        (op) => op.type === 'payment' && op.to === school.stellarAddress
      );
      if (payOp) {
        chainTotalReceived += parseFloat(parseFloat(payOp.amount).toFixed(7));
      }
    }

    const drift = Math.abs(chainTotalReceived - dbTotalCredited);
    const driftPercentage = dbTotalCredited > 0 ? (drift / dbTotalCredited) * 100 : 0;
    const threshold = parseFloat(process.env.RECONCILIATION_DRIFT_THRESHOLD || '0.5');
    const alertRaised = driftPercentage > threshold;

    const report = await ReconciliationReport.create({
      schoolId,
      reportedAt: new Date(),
      dbTotalCredited,
      chainTotalReceived,
      drift,
      driftPercentage,
      threshold,
      alertRaised,
      paymentCount: dbPayments.length,
      chainTxCount: chainTxs.length,
      details: {
        schoolName: school.name,
        checkTime: new Date().toISOString(),
      },
    });

    if (alertRaised) {
      logger.warn('Reconciliation drift alert', {
        schoolId,
        drift,
        driftPercentage,
        dbTotal: dbTotalCredited,
        chainTotal: chainTotalReceived,
      });
    }

    return report;
  } catch (err) {
    logger.error('Error generating reconciliation report', { schoolId, error: err.message });
    throw err;
  }
}

async function generateAllReconciliationReports() {
  const schools = await School.find({ isActive: true }).lean();
  const reports = [];

  for (const school of schools) {
    try {
      const report = await generateReconciliationReport(school.schoolId);
      if (report) reports.push(report);
    } catch (err) {
      logger.error('Failed to generate report for school', { schoolId: school.schoolId, error: err.message });
    }
  }

  logger.info('All reconciliation reports generated', { count: reports.length });
  return reports;
}

module.exports = {
  reconcileAll,
  startReconciliationScheduler,
  stopReconciliationScheduler,
  generateReconciliationReport,
  generateAllReconciliationReports,
};
