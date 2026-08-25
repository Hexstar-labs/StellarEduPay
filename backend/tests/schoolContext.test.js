'use strict';

/**
 * Tests for resolveSchool middleware and school cache invalidation (#1283).
 *
 * Verifies:
 *   1. 0 database queries on cache hit.
 *   2. 1 database query on cache miss, seeding both schoolId and slug keys.
 *   3. Collapsed ID and slug header processing.
 *   4. Immediate maintenanceMode enforcement (503) upon update across cache.
 *   5. Webhook signature generation uses rotated webhookSecret immediately after invalidation.
 *   6. Microbenchmark comparing cache hit vs DB query performance.
 */

const { resolveSchool } = require('../src/middleware/schoolContext');
const School = require('../src/models/schoolModel');
const cache = require('../src/cache');
const schoolCache = require('../src/services/schoolCacheInvalidator');
const { generateSignatureV2 } = require('../src/services/webhookService');

describe('resolveSchool Middleware & Cache Invalidation (#1283)', () => {
  const dummySchool = {
    _id: '507f1f77bcf86cd799439011',
    schoolId: 'SCH-TEST-001',
    name: 'Lincoln High School',
    slug: 'lincoln-high',
    stellarAddress: 'GBXGQ2B45OORQ7POFFB7YUZVSDGVEK67756ZJ74D67756ZJ74D67756Z',
    network: 'testnet',
    isActive: true,
    maintenanceMode: false,
    webhookSecret: 'secret_v1_old_key_12345',
  };

  beforeEach(() => {
    cache.del(cache.KEYS.school('SCH-TEST-001'), cache.KEYS.school('lincoln-high'));
    jest.restoreAllMocks();
  });

  describe('Query Count & Dual-Key Cache Seeding', () => {
    it('executes 1 DB query on cache miss and seeds both schoolId and slug keys', async () => {
      const findOneSpy = jest.spyOn(School, 'findOne').mockReturnValue({
        lean: jest.fn().mockResolvedValue(dummySchool),
      });

      const req = { headers: { 'x-school-id': 'SCH-TEST-001' } };
      const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      await resolveSchool(req, res, next);

      expect(findOneSpy).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
      expect(req.school).toEqual(dummySchool);
      expect(req.schoolId).toBe('SCH-TEST-001');

      // Verify BOTH keys were populated in node-cache
      const cachedById = cache.get(cache.KEYS.school('SCH-TEST-001'));
      const cachedBySlug = cache.get(cache.KEYS.school('lincoln-high'));

      expect(cachedById).toEqual(dummySchool);
      expect(cachedBySlug).toEqual(dummySchool);
    });

    it('executes 0 DB queries on cache hit when using X-School-ID', async () => {
      // Seed cache
      cache.set(cache.KEYS.school('SCH-TEST-001'), dummySchool, 300);

      const findOneSpy = jest.spyOn(School, 'findOne');

      const req = { headers: { 'x-school-id': 'SCH-TEST-001' } };
      const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      await resolveSchool(req, res, next);

      expect(findOneSpy).toHaveBeenCalledTimes(0); // 0 DB queries!
      expect(next).toHaveBeenCalledWith();
      expect(req.school).toEqual(dummySchool);
      expect(req.schoolId).toBe('SCH-TEST-001');
    });

    it('executes 0 DB queries on cache hit when using X-School-Slug after an ID lookup seeded cache', async () => {
      // Seed cache under both keys as done by resolveSchool miss handler
      cache.set(cache.KEYS.school('SCH-TEST-001'), dummySchool, 300);
      cache.set(cache.KEYS.school('lincoln-high'), dummySchool, 300);

      const findOneSpy = jest.spyOn(School, 'findOne');

      const req = { headers: { 'x-school-slug': 'Lincoln-High' } };
      const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      await resolveSchool(req, res, next);

      expect(findOneSpy).toHaveBeenCalledTimes(0); // 0 DB queries!
      expect(next).toHaveBeenCalledWith();
      expect(req.school).toEqual(dummySchool);
    });

    it('returns 400 when neither X-School-ID nor X-School-Slug is provided', async () => {
      const req = { headers: {} };
      const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      await resolveSchool(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'MISSING_SCHOOL_CONTEXT',
      }));
    });

    it('returns 404 when school is not found in DB', async () => {
      jest.spyOn(School, 'findOne').mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });

      const req = { headers: { 'x-school-id': 'SCH-UNKNOWN' } };
      const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      await resolveSchool(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'NOT_FOUND',
      }));
    });

    it('returns 403 when school is inactive in DB', async () => {
      const inactiveSchool = { ...dummySchool, isActive: false };
      jest.spyOn(School, 'findOne').mockReturnValue({
        lean: jest.fn().mockResolvedValue(inactiveSchool),
      });

      const req = { headers: { 'x-school-id': 'SCH-INACTIVE' } };
      const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      await resolveSchool(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'SCHOOL_INACTIVE',
      }));
    });
  });

  describe('Staleness & Invalidation Verification', () => {
    it('maintenanceMode update takes effect immediately on next request after cache invalidation', async () => {
      // 1. Initial hit populates cache
      const normalSchool = { ...dummySchool, maintenanceMode: false };
      const findOneSpy = jest.spyOn(School, 'findOne').mockReturnValue({
        lean: jest.fn().mockResolvedValue(normalSchool),
      });

      const req1 = { headers: { 'x-school-id': 'SCH-TEST-001' } };
      const res1 = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next1 = jest.fn();

      await resolveSchool(req1, res1, next1);
      expect(next1).toHaveBeenCalled();

      // Confirm cache is populated
      expect(cache.get(cache.KEYS.school('SCH-TEST-001'))).toBeDefined();

      // 2. Operator enables maintenance mode (simulated controller write + invalidation)
      const maintenanceSchool = { ...dummySchool, maintenanceMode: true };
      findOneSpy.mockReturnValue({
        lean: jest.fn().mockResolvedValue(maintenanceSchool),
      });

      // Invalidate cache
      schoolCache.invalidate(maintenanceSchool);

      // Cache is now cleared
      expect(cache.get(cache.KEYS.school('SCH-TEST-001'))).toBeUndefined();

      // 3. Next request gets fresh doc with maintenanceMode: true -> 503
      const req2 = { headers: { 'x-school-id': 'SCH-TEST-001' } };
      const res2 = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next2 = jest.fn();

      await resolveSchool(req2, res2, next2);

      expect(res2.status).toHaveBeenCalledWith(503);
      expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'SCHOOL_MAINTENANCE_MODE',
      }));
      expect(next2).not.toHaveBeenCalled();
    });

    it('rotating webhookSecret causes next outbound webhook signature to use new secret without waiting for TTL', async () => {
      const initialSchool = { ...dummySchool, webhookSecret: 'old_secret_123' };
      const findOneSpy = jest.spyOn(School, 'findOne').mockReturnValue({
        lean: jest.fn().mockResolvedValue(initialSchool),
      });

      // Populate cache
      const req1 = { headers: { 'x-school-id': 'SCH-TEST-001' } };
      const res1 = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      await resolveSchool(req1, res1, jest.fn());

      expect(req1.school.webhookSecret).toBe('old_secret_123');

      // Rotate webhookSecret
      const rotatedSchool = { ...dummySchool, webhookSecret: 'new_rotated_secret_999' };
      findOneSpy.mockReturnValue({
        lean: jest.fn().mockResolvedValue(rotatedSchool),
      });

      // Call invalidation
      schoolCache.invalidate(rotatedSchool);

      // Next request gets updated school with rotated secret
      const req2 = { headers: { 'x-school-id': 'SCH-TEST-001' } };
      const res2 = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
      await resolveSchool(req2, res2, jest.fn());

      expect(req2.school.webhookSecret).toBe('new_rotated_secret_999');

      // Verify generated HMAC signature uses the rotated secret
      const timestamp = 1700000000;
      const deliveryId = 'deliv-uuid-123';
      const rawBody = '{"event":"payment.confirmed"}';

      const sigOld = generateSignatureV2(timestamp, deliveryId, rawBody, 'old_secret_123');
      const sigNew = generateSignatureV2(timestamp, deliveryId, rawBody, req2.school.webhookSecret);

      expect(sigNew).not.toEqual(sigOld);
      expect(sigNew).toEqual(generateSignatureV2(timestamp, deliveryId, rawBody, 'new_rotated_secret_999'));
    });
  });

  describe('Microbenchmark Performance', () => {
    it('compares cache hit (0 queries) vs DB lookup performance', async () => {
      cache.set(cache.KEYS.school('SCH-TEST-001'), dummySchool, 300);

      const iterations = 1000;
      const res = { set: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };

      // Benchmark cache hit
      const startCache = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        const req = { headers: { 'x-school-id': 'SCH-TEST-001' } };
        await resolveSchool(req, res, () => {});
      }
      const endCache = process.hrtime.bigint();
      const cacheTotalMs = Number(endCache - startCache) / 1e6;

      // Benchmark mock DB lookup
      jest.spyOn(School, 'findOne').mockReturnValue({
        lean: jest.fn().mockResolvedValue(dummySchool),
      });

      const startDb = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        cache.del(cache.KEYS.school('SCH-TEST-001'), cache.KEYS.school('lincoln-high'));
        const req = { headers: { 'x-school-id': 'SCH-TEST-001' } };
        await resolveSchool(req, res, () => {});
      }
      const endDb = process.hrtime.bigint();
      const dbTotalMs = Number(endDb - startDb) / 1e6;

      console.log(`[Benchmark] ${iterations} resolveSchool calls:`);
      console.log(`  Cache Hits (0 DB queries): ${cacheTotalMs.toFixed(3)} ms (avg ${(cacheTotalMs / iterations).toFixed(4)} ms/call)`);
      console.log(`  Cache Misses (1 DB query): ${dbTotalMs.toFixed(3)} ms (avg ${(dbTotalMs / iterations).toFixed(4)} ms/call)`);

      expect(cacheTotalMs).toBeLessThan(dbTotalMs);
    });
  });
});
