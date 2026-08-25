"use strict";

/**
 * Test that 404 responses are not cached by the idempotency middleware.
 * 
 * 404 errors can be transient (e.g., transaction not yet visible on Horizon).
 * Caching them for 24 hours prevents successful retries when the resource becomes available.
 */

jest.mock("../src/utils/logger", () => {
  const singleton = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return { child: () => singleton };
});

jest.mock("../src/services/idempotencyStore", () => ({
  getFull: jest.fn(),
  reserve: jest.fn(),
  complete: jest.fn(),
  release: jest.fn(),
  IN_FLIGHT_TTL_MS: 30000,
}));

jest.mock("../src/services/currencyConversionService", () => ({
  convertToLocalCurrency: jest.fn(),
}));

const idempotency = require("../src/middleware/idempotency");
const idempotencyStore = require("../src/services/idempotencyStore");
const logger = require("../src/utils/logger").child();

function makeRes() {
  const res = {};
  res.statusCode = 200;
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
}

async function flushPromises() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe("idempotency middleware — 404 responses are not cached", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    idempotencyStore.getFull.mockResolvedValue(null);
    idempotencyStore.reserve.mockResolvedValue({ reserved: true });
  });

  it("releases the reservation instead of caching a 404 response", async () => {
    const req = {
      headers: { "idempotency-key": "client-key-1" },
      path: "/api/payments/verify",
      body: { txHash: "abc" },
    };
    const res = makeRes();
    const next = jest.fn();
    const middleware = idempotency();

    middleware(req, res, next);
    await flushPromises();

    expect(next).toHaveBeenCalledTimes(1);

    // Simulate the downstream controller returning a 404 (e.g., transaction not found)
    res.status(404).json({ error: "Transaction not found", code: "NOT_FOUND" });
    await flushPromises();

    // Should call release() instead of complete()
    expect(idempotencyStore.release).toHaveBeenCalledWith(expect.any(String));
    expect(idempotencyStore.complete).not.toHaveBeenCalled();

    // Should log the release
    expect(logger.debug).toHaveBeenCalledWith(
      "[Idempotency] release missed",
      expect.any(Object),
    );
  });

  it("caches 2xx responses normally", async () => {
    const req = {
      headers: { "idempotency-key": "client-key-2" },
      path: "/api/payments/verify",
      body: { txHash: "def" },
    };
    const res = makeRes();
    const next = jest.fn();
    const middleware = idempotency();

    middleware(req, res, next);
    await flushPromises();

    expect(next).toHaveBeenCalledTimes(1);

    // Simulate a successful 200 response
    res.status(200).json({ verified: true, hash: "def" });
    await flushPromises();

    // Should call complete() instead of release()
    expect(idempotencyStore.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        responseStatus: 200,
        responseBody: { verified: true, hash: "def" },
      }),
    );
    expect(idempotencyStore.release).not.toHaveBeenCalled();
  });

  it("caches 3xx responses normally", async () => {
    const req = {
      headers: { "idempotency-key": "client-key-3" },
      path: "/api/payments/verify",
      body: { txHash: "ghi" },
    };
    const res = makeRes();
    const next = jest.fn();
    const middleware = idempotency();

    middleware(req, res, next);
    await flushPromises();

    expect(next).toHaveBeenCalledTimes(1);

    // Simulate a 302 redirect response
    res.status(302).json({ redirect: "/new-location" });
    await flushPromises();

    // Should call complete() instead of release()
    expect(idempotencyStore.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        responseStatus: 302,
        responseBody: { redirect: "/new-location" },
      }),
    );
    expect(idempotencyStore.release).not.toHaveBeenCalled();
  });

  it("caches 4xx responses (except 404) normally", async () => {
    const req = {
      headers: { "idempotency-key": "client-key-4" },
      path: "/api/payments/verify",
      body: { txHash: "jkl" },
    };
    const res = makeRes();
    const next = jest.fn();
    const middleware = idempotency();

    middleware(req, res, next);
    await flushPromises();

    expect(next).toHaveBeenCalledTimes(1);

    // Simulate a 400 bad request (permanent error, should be cached)
    res.status(400).json({ error: "Invalid request", code: "VALIDATION_ERROR" });
    await flushPromises();

    // Should call complete() instead of release()
    expect(idempotencyStore.complete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        responseStatus: 400,
        responseBody: { error: "Invalid request", code: "VALIDATION_ERROR" },
      }),
    );
    expect(idempotencyStore.release).not.toHaveBeenCalled();
  });

  it("releases the reservation for 5xx responses", async () => {
    const req = {
      headers: { "idempotency-key": "client-key-5" },
      path: "/api/payments/verify",
      body: { txHash: "mno" },
    };
    const res = makeRes();
    const next = jest.fn();
    const middleware = idempotency();

    middleware(req, res, next);
    await flushPromises();

    expect(next).toHaveBeenCalledTimes(1);

    // Simulate a 500 internal server error
    res.status(500).json({ error: "Internal error" });
    await flushPromises();

    // Should call release() instead of complete()
    expect(idempotencyStore.release).toHaveBeenCalledWith(expect.any(String));
    expect(idempotencyStore.complete).not.toHaveBeenCalled();
  });
});
