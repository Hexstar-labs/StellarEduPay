'use strict';

/**
 * Issue #1287 — Webhook HMAC V2: replay protection, raw-body signing, single
 * clock read.
 *
 * Acceptance criteria tested here:
 *
 * 1. The V2 signature covers the timestamp and delivery-ID as well as the body.
 *    Rewriting the timestamp header after signing fails V2 verification.
 *
 * 2. The signed bytes are the exact bytes transmitted.
 *    A test intercepts the outgoing request and recomputes the HMAC from the
 *    captured raw body, confirming the signature matches.
 *
 * 3. A single clock read produces every timestamp in a delivery.
 *    body.timestamp and the X-StellarEduPay-Timestamp header are derived from
 *    the same epoch value.
 *
 * 4. The documented Node.js verification recipe (from WEBHOOK_INTEGRATION.md)
 *    rejects a delivery whose timestamp header has been rewritten.
 *
 * 5. generateSignatureV2 / verifySignatureV2 unit tests.
 *
 * 6. Both V1 and V2 headers are present during the migration window.
 *
 * 7. _isReplay fails closed when Redis is unavailable (without the local
 *    nonces escape hatch).
 */

const crypto = require('crypto');

// ── Top-level mocks (shared by groups 1–6) ────────────────────────────────────

const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({ post: mockAxiosPost, create: () => ({ post: mockAxiosPost }) }));
jest.mock('uuid', () => ({ v4: () => 'test-delivery-uuid-1287' }));

jest.mock('../backend/src/models/webhookRetryModel', () => ({
  create: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockResolvedValue([]),
  updateOne: jest.fn().mockResolvedValue({}),
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
}));
jest.mock('../backend/src/models/webhookDeliveryModel', () => ({
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../backend/src/models/webhookEndpointModel', () => ({
  find: jest.fn().mockResolvedValue([]),
}));
jest.mock('../backend/src/utils/validateWebhookUrl', () => ({
  validateWebhookUrl: jest.fn().mockResolvedValue({ valid: true }),
  validateResolvedIp: jest.fn().mockReturnValue({ blocked: false }),
}));
jest.mock('../backend/src/utils/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return Object.assign(l, { child: () => l });
});
// Provide a Redis mock that always reports as ready so _isReplay doesn't
// fail closed in the shared tests (groups 1–6). Using jest.fn() so tests in
// group 7 can override the return values without module isolation.
jest.mock('../backend/src/config/redisClient', () => ({
  isRedisReady: jest.fn().mockReturnValue(true),
  getRedisClient: jest.fn().mockReturnValue({
    // SET NX EX: always return '1' (key was set, not a replay)
    set: jest.fn().mockResolvedValue('1'),
  }),
}));

// ── Constants ─────────────────────────────────────────────────────────────────

const SECRET = 'test-secret-for-issue-1287';
const URL = 'https://example.com/webhook-v2';
const EVENT = 'payment.confirmed';
const PAYLOAD = { studentId: 'STU001', amount: 250, txHash: 'abc123' };
const DELIVERY_ID = 'test-delivery-uuid-1287';

// ── Documented Node.js verification recipe (must match WEBHOOK_INTEGRATION.md) ──

function verifyWebhookV2(rawBody, headers, secret) {
  const TOLERANCE_S = 300;
  const ts = parseInt(headers['x-stellaredupay-timestamp'], 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_S) {
    return { valid: false, reason: 'timestamp out of tolerance' };
  }
  const deliveryId = headers['x-stellaredupay-delivery-id'] || '';
  const [, provided] = (headers['x-stellaredupay-signature-v2'] || '').split('sha256=');
  if (!provided) return { valid: false, reason: 'missing V2 signature' };
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString();
  const signingBase = `${ts}.${deliveryId}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(signingBase).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) {
    return { valid: false, reason: 'signature length mismatch' };
  }
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { valid: false, reason: 'signature mismatch' };
  }
  return { valid: true };
}

// ── Load service after mocks ──────────────────────────────────────────────────

const {
  generateSignatureV2,
  verifySignatureV2,
  fireWebhook,
  _resetNonces,
} = require('../backend/src/services/webhookService');

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockAxiosPost.mockResolvedValue({ status: 200 });
  _resetNonces();
  delete process.env.WEBHOOK_REPLAY_NONCES_LOCAL;
  // Re-set the Redis mock to "always ready, not a replay" after clearAllMocks
  const redisClient = require('../backend/src/config/redisClient');
  redisClient.isRedisReady.mockReturnValue(true);
  redisClient.getRedisClient.mockReturnValue({ set: jest.fn().mockResolvedValue('1') });
});

afterAll(() => {
  delete process.env.WEBHOOK_REPLAY_NONCES_LOCAL;
});

// ─────────────────────────────────────────────────────────────────────────────
//  1. generateSignatureV2 / verifySignatureV2 unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('#1287 — generateSignatureV2 / verifySignatureV2', () => {
  const TS = 1711532400;
  const DID = 'delivery-abc-123';
  const RAW = '{"event":"payment.confirmed","timestamp":"2024-03-27T10:00:00.000Z","data":{}}';

  it('produces a 64-character hex digest', () => {
    const sig = generateSignatureV2(TS, DID, RAW, SECRET);
    expect(typeof sig).toBe('string');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches a manual HMAC-SHA256 over `timestamp.deliveryId.rawBody`', () => {
    const signingBase = `${TS}.${DID}.${RAW}`;
    const expected = crypto.createHmac('sha256', SECRET).update(signingBase).digest('hex');
    expect(generateSignatureV2(TS, DID, RAW, SECRET)).toBe(expected);
  });

  it('changes when the timestamp changes', () => {
    const sig1 = generateSignatureV2(TS, DID, RAW, SECRET);
    const sig2 = generateSignatureV2(TS + 1, DID, RAW, SECRET);
    expect(sig1).not.toBe(sig2);
  });

  it('changes when the delivery-ID changes', () => {
    const sig1 = generateSignatureV2(TS, DID, RAW, SECRET);
    const sig2 = generateSignatureV2(TS, 'different-id', RAW, SECRET);
    expect(sig1).not.toBe(sig2);
  });

  it('changes when the body changes', () => {
    const sig1 = generateSignatureV2(TS, DID, RAW, SECRET);
    const sig2 = generateSignatureV2(TS, DID, RAW + ' ', SECRET);
    expect(sig1).not.toBe(sig2);
  });

  it('verifySignatureV2 returns true for a valid signature', () => {
    const sig = generateSignatureV2(TS, DID, RAW, SECRET);
    expect(verifySignatureV2(TS, DID, RAW, sig, SECRET)).toBe(true);
  });

  it('verifySignatureV2 returns false when timestamp is tampered', () => {
    const sig = generateSignatureV2(TS, DID, RAW, SECRET);
    expect(verifySignatureV2(TS + 999, DID, RAW, sig, SECRET)).toBe(false);
  });

  it('verifySignatureV2 returns false when delivery-ID is tampered', () => {
    const sig = generateSignatureV2(TS, DID, RAW, SECRET);
    expect(verifySignatureV2(TS, 'attacker-fresh-id', RAW, sig, SECRET)).toBe(false);
  });

  it('verifySignatureV2 returns false when body is tampered', () => {
    const sig = generateSignatureV2(TS, DID, RAW, SECRET);
    const tampered = RAW.replace('"payment.confirmed"', '"payment.failed"');
    expect(verifySignatureV2(TS, DID, tampered, sig, SECRET)).toBe(false);
  });

  it('verifySignatureV2 returns false for wrong secret', () => {
    const sig = generateSignatureV2(TS, DID, RAW, SECRET);
    expect(verifySignatureV2(TS, DID, RAW, sig, 'wrong-secret')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. V2 signature covers timestamp: replay with rewritten timestamp is rejected
// ─────────────────────────────────────────────────────────────────────────────

describe('#1287 — replay with rewritten timestamp is rejected by V2 verification', () => {
  it('captured delivery replayed with a fresh timestamp fails V2 verification', async () => {
    await fireWebhook(URL, EVENT, PAYLOAD, SECRET);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);

    const [, rawBodyArg, config] = mockAxiosPost.mock.calls[0];

    // Extract what was sent
    const sentRawBody = typeof rawBodyArg === 'string' ? rawBodyArg : JSON.stringify(rawBodyArg);
    const sentHeaders = config.headers;
    const originalTs = sentHeaders['X-StellarEduPay-Timestamp'];
    const sigV2Header = sentHeaders['X-StellarEduPay-Signature-V2'];
    const deliveryId = sentHeaders['X-StellarEduPay-Delivery-ID'];

    // Verify the original delivery passes (sanity check)
    const legitResult = verifyWebhookV2(sentRawBody, {
      'x-stellaredupay-timestamp': originalTs,
      'x-stellaredupay-delivery-id': deliveryId,
      'x-stellaredupay-signature-v2': sigV2Header,
    }, SECRET);
    expect(legitResult.valid).toBe(true);

    // Attacker rewrites the timestamp to a fresh value — simulates the attack
    const attackerTs = String(parseInt(originalTs, 10) + 100);

    const replayResult = verifyWebhookV2(sentRawBody, {
      'x-stellaredupay-timestamp': attackerTs,
      'x-stellaredupay-delivery-id': deliveryId,
      'x-stellaredupay-signature-v2': sigV2Header,
    }, SECRET);
    expect(replayResult.valid).toBe(false);
    expect(replayResult.reason).toBe('signature mismatch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. Intercepted raw body HMAC test — signed bytes === transmitted bytes
// ─────────────────────────────────────────────────────────────────────────────

describe('#1287 — signed bytes are the exact bytes transmitted', () => {
  it('V2 signature computed from captured rawBody matches the header', async () => {
    await fireWebhook(URL, EVENT, PAYLOAD, SECRET);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);

    const [, rawBodyArg, config] = mockAxiosPost.mock.calls[0];
    const capturedRawBody = typeof rawBodyArg === 'string' ? rawBodyArg : JSON.stringify(rawBodyArg);

    const ts = config.headers['X-StellarEduPay-Timestamp'];
    const did = config.headers['X-StellarEduPay-Delivery-ID'];
    const headerV2 = config.headers['X-StellarEduPay-Signature-V2'];

    // Recompute from the exact captured bytes
    const signingBase = `${ts}.${did}.${capturedRawBody}`;
    const recomputed = `sha256=${crypto.createHmac('sha256', SECRET).update(signingBase).digest('hex')}`;

    expect(recomputed).toBe(headerV2);
  });

  it('V1 signature computed from captured rawBody (parsed back) matches the V1 header', async () => {
    await fireWebhook(URL, EVENT, PAYLOAD, SECRET);
    const [, rawBodyArg, config] = mockAxiosPost.mock.calls[0];

    const capturedRawBody = typeof rawBodyArg === 'string' ? rawBodyArg : JSON.stringify(rawBodyArg);
    const parsedBody = JSON.parse(capturedRawBody);

    const headerV1 = config.headers['X-StellarEduPay-Signature'];
    const recomputed = `sha256=${crypto.createHmac('sha256', SECRET).update(JSON.stringify(parsedBody)).digest('hex')}`;

    expect(recomputed).toBe(headerV1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. Single clock read: body.timestamp and header timestamp agree
// ─────────────────────────────────────────────────────────────────────────────

describe('#1287 — single clock read: body.timestamp and header timestamp are consistent', () => {
  it('body.timestamp ISO string matches the unix timestamp in the header (same second)', async () => {
    await fireWebhook(URL, EVENT, PAYLOAD, SECRET);
    const [, rawBodyArg, config] = mockAxiosPost.mock.calls[0];

    const capturedRawBody = typeof rawBodyArg === 'string' ? rawBodyArg : JSON.stringify(rawBodyArg);
    const parsedBody = JSON.parse(capturedRawBody);

    const headerTs = parseInt(config.headers['X-StellarEduPay-Timestamp'], 10);
    const bodyTs = Math.floor(new Date(parsedBody.timestamp).getTime() / 1000);

    expect(bodyTs).toBe(headerTs);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. Docs recipe test — documented Node.js recipe matches implementation
// ─────────────────────────────────────────────────────────────────────────────

describe('#1287 — documented Node.js V2 recipe accepts valid and rejects replayed deliveries', () => {
  it('documented recipe accepts a freshly signed delivery', async () => {
    await fireWebhook(URL, EVENT, PAYLOAD, SECRET);
    const [, rawBodyArg, config] = mockAxiosPost.mock.calls[0];

    const rawBody = typeof rawBodyArg === 'string' ? rawBodyArg : JSON.stringify(rawBodyArg);
    const headers = {
      'x-stellaredupay-timestamp': config.headers['X-StellarEduPay-Timestamp'],
      'x-stellaredupay-delivery-id': config.headers['X-StellarEduPay-Delivery-ID'],
      'x-stellaredupay-signature-v2': config.headers['X-StellarEduPay-Signature-V2'],
    };

    expect(verifyWebhookV2(rawBody, headers, SECRET)).toEqual({ valid: true });
  });

  it('documented recipe rejects when timestamp header is rewritten (replay attack)', async () => {
    await fireWebhook(URL, EVENT, PAYLOAD, SECRET);
    const [, rawBodyArg, config] = mockAxiosPost.mock.calls[0];

    const rawBody = typeof rawBodyArg === 'string' ? rawBodyArg : JSON.stringify(rawBodyArg);
    // Attacker keeps body + V2 signature but rewrites timestamp to a fresh value
    const origTs = parseInt(config.headers['X-StellarEduPay-Timestamp'], 10);
    const replayTs = String(origTs + 100); // attacker supplies a fresh timestamp
    const headers = {
      'x-stellaredupay-timestamp': replayTs,
      'x-stellaredupay-delivery-id': config.headers['X-StellarEduPay-Delivery-ID'],
      'x-stellaredupay-signature-v2': config.headers['X-StellarEduPay-Signature-V2'],
    };

    const result = verifyWebhookV2(rawBody, headers, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature mismatch');
  });

  it('documented recipe rejects when delivery-ID is rewritten', async () => {
    await fireWebhook(URL, EVENT, PAYLOAD, SECRET);
    const [, rawBodyArg, config] = mockAxiosPost.mock.calls[0];

    const rawBody = typeof rawBodyArg === 'string' ? rawBodyArg : JSON.stringify(rawBodyArg);
    const headers = {
      'x-stellaredupay-timestamp': config.headers['X-StellarEduPay-Timestamp'],
      'x-stellaredupay-delivery-id': 'attacker-minted-fresh-id',
      'x-stellaredupay-signature-v2': config.headers['X-StellarEduPay-Signature-V2'],
    };

    const result = verifyWebhookV2(rawBody, headers, SECRET);
    expect(result.valid).toBe(false);
  });

  it('documented recipe rejects a stale timestamp (outside 5-minute window)', async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600); // 1 hour ago
    const rawBody = '{"event":"payment.confirmed","data":{}}';
    const signingBase = `${staleTs}.${DELIVERY_ID}.${rawBody}`;
    const staleSig = `sha256=${crypto.createHmac('sha256', SECRET).update(signingBase).digest('hex')}`;

    const headers = {
      'x-stellaredupay-timestamp': staleTs,
      'x-stellaredupay-delivery-id': DELIVERY_ID,
      'x-stellaredupay-signature-v2': staleSig,
    };

    const result = verifyWebhookV2(rawBody, headers, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('timestamp out of tolerance');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. Both V1 and V2 headers are present during migration window
// ─────────────────────────────────────────────────────────────────────────────

describe('#1287 — both V1 and V2 signature headers are emitted during migration window', () => {
  it('fireWebhook sends X-StellarEduPay-Signature (V1) and X-StellarEduPay-Signature-V2', async () => {
    await fireWebhook(URL, EVENT, PAYLOAD, SECRET);
    const [, , config] = mockAxiosPost.mock.calls[0];

    expect(config.headers).toHaveProperty('X-StellarEduPay-Signature');
    expect(config.headers).toHaveProperty('X-StellarEduPay-Signature-V2');
    expect(config.headers['X-StellarEduPay-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(config.headers['X-StellarEduPay-Signature-V2']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('V1 and V2 signatures are different values (they cover different inputs)', async () => {
    await fireWebhook(URL, EVENT, PAYLOAD, SECRET);
    const [, , config] = mockAxiosPost.mock.calls[0];

    expect(config.headers['X-StellarEduPay-Signature'])
      .not.toBe(config.headers['X-StellarEduPay-Signature-V2']);
  });

  it('no signature headers are emitted when no secret is provided', async () => {
    await fireWebhook(URL, EVENT, PAYLOAD);
    const [, , config] = mockAxiosPost.mock.calls[0];

    expect(config.headers).not.toHaveProperty('X-StellarEduPay-Signature');
    expect(config.headers).not.toHaveProperty('X-StellarEduPay-Signature-V2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. _isReplay fails closed when Redis is unavailable
// ─────────────────────────────────────────────────────────────────────────────

describe('#1287 — _isReplay fails closed when Redis is unavailable', () => {
  let redisReadyMock;

  beforeEach(() => {
    delete process.env.WEBHOOK_REPLAY_NONCES_LOCAL;
    _resetNonces();
    // Grab the mocked redisClient module to control isRedisReady
    const redisClient = require('../backend/src/config/redisClient');
    redisReadyMock = redisClient;
  });

  afterEach(() => {
    delete process.env.WEBHOOK_REPLAY_NONCES_LOCAL;
    // Restore Redis as ready so other tests are not affected
    const redisClient = require('../backend/src/config/redisClient');
    redisClient.isRedisReady.mockReturnValue(true);
    redisClient.getRedisClient.mockReturnValue({ set: jest.fn().mockResolvedValue('1') });
  });

  it('fireWebhook treats delivery as a replay when Redis is not ready', async () => {
    // Override the mocked redisClient to report Redis as not ready
    redisReadyMock.isRedisReady.mockReturnValue(false);
    redisReadyMock.getRedisClient.mockReturnValue(null);

    // Use a unique delivery ID to ensure this is not a _localNonces replay
    const result = await fireWebhook(URL, EVENT, PAYLOAD, SECRET, 'delivery-no-redis-fail-closed');

    // Without the escape hatch, _isReplay returns true (fail closed)
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/[Rr]eplay/);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('fireWebhook allows delivery when WEBHOOK_REPLAY_NONCES_LOCAL=true and Redis is down', async () => {
    process.env.WEBHOOK_REPLAY_NONCES_LOCAL = 'true';
    mockAxiosPost.mockResolvedValue({ status: 200 });

    // Override the mocked redisClient to report Redis as not ready
    redisReadyMock.isRedisReady.mockReturnValue(false);
    redisReadyMock.getRedisClient.mockReturnValue(null);

    const result = await fireWebhook(URL, EVENT, PAYLOAD, SECRET, 'delivery-local-nonces-escape');

    expect(result.success).toBe(true);
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
  });
});
