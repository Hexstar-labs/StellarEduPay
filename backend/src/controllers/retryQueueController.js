'use strict';

const svc = require('../services/bullMQRetryService');
const { asyncHandler } = require('../middleware/errorHandler');

const getStats = asyncHandler(async (req, res) => {
  const data = await svc.getRetryQueueStats();
  res.json({ success: true, data });
});

const getHealth = asyncHandler(async (req, res) => {
  const h = await svc.getHealthStatus();
  res.status(h.healthy ? 200 : 503).json({ success: true, data: h });
});

const getJob = asyncHandler(async (req, res) => {
  const data = await svc.getJobDetails(req.params.jobId);
  res.json({ success: true, data });
});

const getJobs = asyncHandler(async (req, res) => {
  const jobs = await svc.getJobsByState(req.params.state, parseInt(req.query.limit) || 50);
  res.json({ success: true, data: { state: req.params.state, count: jobs.length, jobs } });
});

const manualRetry = asyncHandler(async (req, res) => {
  const data = await svc.retryJobImmediately(req.params.jobId);
  res.json({ success: true, data });
});

const deleteJob = asyncHandler(async (req, res) => {
  const data = await svc.removeJob(req.params.jobId);
  res.json({ success: true, data });
});

const pause = asyncHandler(async (req, res) => {
  const data = await svc.pauseQueue();
  res.json({ success: true, data });
});

const resume = asyncHandler(async (req, res) => {
  const data = await svc.resumeQueue();
  res.json({ success: true, data });
});

const queueTransaction = asyncHandler(async (req, res) => {
  const { transactionHash, studentId, memo, error, metadata } = req.body;
  if (!transactionHash) {
    const err = new Error('transactionHash is required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const data = await svc.queueFailedTransaction(transactionHash, {
    studentId, memo, error: error ? new Error(error.message) : null, metadata,
  });
  res.json({ success: true, data });
});

module.exports = { getStats, getHealth, getJob, getJobs, manualRetry, deleteJob, pause, resume, queueTransaction };
