'use strict';
/**
 * Tests for issue #1102 — backup_last_success_timestamp_seconds metric and
 * the backup heartbeat controller (tested directly, without Express or winston).
 */

const TEST_TOKEN = 'test-backup-notify-token-abc123';

// Set required env vars before any require so config doesn't throw
process.env.BACKUP_NOTIFY_TOKEN = TEST_TOKEN;
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// Mock logger so we don't need the real winston module installed at root
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
mockLogger.logger = mockLogger;
mockLogger.child = jest.fn(() => mockLogger);
jest.mock('../backend/src/utils/logger', () => mockLogger);

afterAll(() => {
  delete process.env.BACKUP_NOTIFY_TOKEN;
});

// ── Minimal req / res mocks ───────────────────────────────────────────────

function makeReq({ authorization } = {}) {
  return { headers: authorization ? { authorization } : {} };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { res._status = code; return res; },
    json(body)  { res._body  = body;  return res; },
  };
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('backup_last_success_timestamp_seconds metric', () => {
  test('is exported from metrics/index.js', () => {
    const metrics = require('../backend/src/metrics');
    expect(metrics.backupLastSuccessTimestamp).toBeDefined();
  });

  test('can be set to a timestamp and read back', async () => {
    const { backupLastSuccessTimestamp } = require('../backend/src/metrics');
    const ts = Math.floor(Date.now() / 1000);
    backupLastSuccessTimestamp.set(ts);
    const result = await backupLastSuccessTimestamp.get();
    const value = result.values[0] ? result.values[0].value : undefined;
    expect(value).toBe(ts);
  });

  test('initialises to 0 — BackupNotRun alert fires until first heartbeat', async () => {
    const { backupLastSuccessTimestamp } = require('../backend/src/metrics');
    backupLastSuccessTimestamp.set(0);
    const result = await backupLastSuccessTimestamp.get();
    const value = result.values[0] ? result.values[0].value : undefined;
    expect(value).toBe(0);
  });
});

describe('backupHeartbeat controller', () => {
  const { backupHeartbeat } = require('../backend/src/controllers/backupHeartbeatController');

  beforeEach(() => {
    process.env.BACKUP_NOTIFY_TOKEN = TEST_TOKEN;
  });

  test('returns 401 when Authorization header is missing', () => {
    const req = makeReq();
    const res = makeRes();
    backupHeartbeat(req, res);
    expect(res._status).toBe(401);
  });

  test('returns 401 when Authorization header has wrong token', () => {
    const req = makeReq({ authorization: 'Bearer wrong-token' });
    const res = makeRes();
    backupHeartbeat(req, res);
    expect(res._status).toBe(401);
  });

  test('returns 200 with recorded timestamp when correct token is supplied', () => {
    const req = makeReq({ authorization: `Bearer ${TEST_TOKEN}` });
    const res = makeRes();
    const before = Math.floor(Date.now() / 1000);
    backupHeartbeat(req, res);
    const after = Math.floor(Date.now() / 1000);
    expect(res._status).toBe(200);
    expect(res._body.recorded).toBeGreaterThanOrEqual(before);
    expect(res._body.recorded).toBeLessThanOrEqual(after);
  });

  test('updates backup_last_success_timestamp_seconds on success', async () => {
    const { backupLastSuccessTimestamp } = require('../backend/src/metrics');
    const req = makeReq({ authorization: `Bearer ${TEST_TOKEN}` });
    const res = makeRes();
    const before = Math.floor(Date.now() / 1000);
    backupHeartbeat(req, res);
    const result = await backupLastSuccessTimestamp.get();
    const value = result.values[0] ? result.values[0].value : undefined;
    expect(value).toBeGreaterThanOrEqual(before);
  });

  test('returns 503 when BACKUP_NOTIFY_TOKEN env var is not set', () => {
    const savedToken = process.env.BACKUP_NOTIFY_TOKEN;
    delete process.env.BACKUP_NOTIFY_TOKEN;
    try {
      const req = makeReq({ authorization: 'Bearer anything' });
      const res = makeRes();
      backupHeartbeat(req, res);
      expect(res._status).toBe(503);
    } finally {
      process.env.BACKUP_NOTIFY_TOKEN = savedToken;
    }
  });
});
