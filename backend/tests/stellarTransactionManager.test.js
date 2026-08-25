'use strict';

/**
 * Tests for StellarTransactionManager (Issue #843).
 *
 * All Horizon / Stellar SDK network calls are mocked.
 * Tests cover: constructor validation, buildAndSubmit (normal + seq-retry),
 * submitFeeBump, isFeeBumpEligible, getRecommendedFee, extractResultCode,
 * and createTransactionManager factory.
 */

// ── Environment for config/index.js ──────────────────────────────────────
process.env.MONGO_URI  = process.env.MONGO_URI  || 'mongodb://localhost:27017/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'a'.repeat(32);

// ── Suppress logger noise ──────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// ── withStellarRetry: pass-through ─────────────────────────────────────────
jest.mock('../src/utils/withStellarRetry', () => ({
  withStellarRetry: jest.fn(async (fn) => fn()),
}));

// ── Stellar SDK mock ───────────────────────────────────────────────────────
// All classes are defined inside the factory to avoid hoisting issues.
jest.mock('@stellar/stellar-sdk', () => {
  const mockBuild    = jest.fn();
  const mockAddMemo  = jest.fn();
  const mockSign     = jest.fn();

  class MockTransactionBuilder {
    constructor() {}
    addOperation() { return this; }
    addMemo(m)     { mockAddMemo(m); return this; }
    setTimeout()   { return this; }
    build()        { return mockBuild(); }
  }

  // Static buildFeeBump — replaced by tests via the module handle below
  MockTransactionBuilder.buildFeeBump = jest.fn();

  const MockTransaction = class {
    constructor(_xdr, _passphrase) {}
    hash() { return Buffer.alloc(32, 0xaa); }
    sign(kp) { mockSign(kp); }
  };

  return {
    TransactionBuilder: MockTransactionBuilder,
    Transaction:        MockTransaction,
    Networks:           { TESTNET: 'Test SDF', PUBLIC: 'Public Stellar' },
    BASE_FEE:           100,
    Keypair: {
      fromSecret: (secret) => ({
        publicKey: () => `GPUB_${secret.slice(0, 8)}`,
        secret:    () => secret,
      }),
    },
  };
}, { virtual: true });

// ── stellarConfig mock ─────────────────────────────────────────────────────
const mockLoadAccount       = jest.fn();
const mockFeeStats          = jest.fn();
const mockSubmitTransaction = jest.fn();

jest.mock('../src/config/stellarConfig', () => ({
  server: {
    loadAccount:       (...a) => mockLoadAccount(...a),
    feeStats:          (...a) => mockFeeStats(...a),
    submitTransaction: (...a) => mockSubmitTransaction(...a),
  },
  networkPassphrase: 'Test SDF',
}));

// ── Load module under test ─────────────────────────────────────────────────
const {
  StellarTransactionManager,
  createTransactionManager,
  getRecommendedFee,
  extractResultCode,
} = require('../src/services/stellarTransactionManager');

// Grab the mocked SDK so tests can inspect / configure static methods
const StellarSdk = require('@stellar/stellar-sdk');

// ── Helpers ────────────────────────────────────────────────────────────────
function makeKeypair(id = 'signing') {
  return { publicKey: () => `GPUB_${id}`, secret: () => `SSEC_${id}` };
}

const MOCK_TX = { hash: 'txhash123', ledger: 42, envelope_xdr: 'xdrxdr' };

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadAccount.mockResolvedValue({ id: 'GPUB', sequence: '1000' });
  mockFeeStats.mockResolvedValue({ fee_charged: { p80: '200' } });

  // TransactionBuilder.build() returns a minimal tx object
  const fakeTx = { sign: jest.fn(), hash: () => Buffer.alloc(32) };
  StellarSdk.TransactionBuilder.prototype.build = jest.fn(() => fakeTx);
  // Restore addMemo / setTimeout stubs after clearAllMocks wipes prototype spies
  StellarSdk.TransactionBuilder.prototype.addMemo = jest.fn(function () { return this; });
  StellarSdk.TransactionBuilder.prototype.setTimeout = jest.fn(function () { return this; });
  StellarSdk.TransactionBuilder.prototype.addOperation = jest.fn(function () { return this; });

  mockSubmitTransaction.mockResolvedValue(MOCK_TX);

  const fakeFeeBumpTx = { sign: jest.fn() };
  StellarSdk.TransactionBuilder.buildFeeBump = jest.fn(() => fakeFeeBumpTx);
});

// ── Constructor ────────────────────────────────────────────────────────────

describe('StellarTransactionManager constructor', () => {
  it('throws when signingKeypair is not provided', () => {
    expect(() => new StellarTransactionManager({})).toThrow('signingKeypair is required');
  });

  it('throws when called with no arguments', () => {
    expect(() => new StellarTransactionManager()).toThrow('signingKeypair is required');
  });

  it('constructs successfully with a signingKeypair', () => {
    const kp = makeKeypair();
    expect(() => new StellarTransactionManager({ signingKeypair: kp })).not.toThrow();
  });

  it('uses signingKeypair as feeSourceKeypair when feeSourceKeypair is omitted', () => {
    const kp = makeKeypair();
    const mgr = new StellarTransactionManager({ signingKeypair: kp });
    expect(mgr.feeSourceKeypair).toBe(kp);
  });

  it('uses a separate feeSourceKeypair when provided', () => {
    const signing    = makeKeypair('signer');
    const feeSource  = makeKeypair('feesource');
    const mgr = new StellarTransactionManager({ signingKeypair: signing, feeSourceKeypair: feeSource });
    expect(mgr.feeSourceKeypair).toBe(feeSource);
  });

  it('accepts timeoutSeconds and feeMultiplier overrides', () => {
    const kp = makeKeypair();
    const mgr = new StellarTransactionManager({ signingKeypair: kp, timeoutSeconds: 600, feeMultiplier: 3 });
    expect(mgr.timeoutSeconds).toBe(600);
    expect(mgr.feeMultiplier).toBe(3);
  });
});

// ── getRecommendedFee ──────────────────────────────────────────────────────

describe('getRecommendedFee', () => {
  it('returns a fee based on p80 * multiplier', async () => {
    mockFeeStats.mockResolvedValue({ fee_charged: { p80: '200' } });
    const fee = await getRecommendedFee(1);
    expect(fee).toBe(200);
  });

  it('applies the multiplier to p80', async () => {
    mockFeeStats.mockResolvedValue({ fee_charged: { p80: '100' } });
    const fee = await getRecommendedFee(2);
    expect(fee).toBe(200);
  });

  it('falls back to default base fee when feeStats throws', async () => {
    mockFeeStats.mockRejectedValue(new Error('Horizon unavailable'));
    const fee = await getRecommendedFee(1);
    expect(typeof fee).toBe('number');
    expect(fee).toBeGreaterThan(0);
  });
});

// ── extractResultCode ──────────────────────────────────────────────────────

describe('extractResultCode', () => {
  it('extracts the transaction result code from a Horizon error', () => {
    const err = { response: { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } } };
    expect(extractResultCode(err)).toBe('tx_bad_seq');
  });

  it('returns null when error has no response data', () => {
    expect(extractResultCode(new Error('plain'))).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractResultCode(null)).toBeNull();
  });

  it('returns null when result_codes is absent', () => {
    expect(extractResultCode({ response: { data: { extras: {} } } })).toBeNull();
  });
});

// ── isFeeBumpEligible ──────────────────────────────────────────────────────

describe('StellarTransactionManager.isFeeBumpEligible', () => {
  it('returns true for tx_insufficient_fee', () => {
    const err = { response: { data: { extras: { result_codes: { transaction: 'tx_insufficient_fee' } } } } };
    expect(StellarTransactionManager.isFeeBumpEligible(err)).toBe(true);
  });

  it('returns true for tx_bad_min_seq_age_or_gap', () => {
    const err = { response: { data: { extras: { result_codes: { transaction: 'tx_bad_min_seq_age_or_gap' } } } } };
    expect(StellarTransactionManager.isFeeBumpEligible(err)).toBe(true);
  });

  it('returns true when message contains tx_too_late', () => {
    expect(StellarTransactionManager.isFeeBumpEligible({ message: 'tx_too_late occurred' })).toBe(true);
  });

  it('returns false for non-fee errors', () => {
    const err = { response: { data: { extras: { result_codes: { transaction: 'tx_bad_auth' } } } } };
    expect(StellarTransactionManager.isFeeBumpEligible(err)).toBe(false);
  });

  it('returns false for null', () => {
    expect(StellarTransactionManager.isFeeBumpEligible(null)).toBe(false);
  });
});

// ── buildAndSubmit ─────────────────────────────────────────────────────────

describe('buildAndSubmit', () => {
  it('returns hash, ledger, and envelope on success', async () => {
    const kp  = makeKeypair();
    const mgr = new StellarTransactionManager({ signingKeypair: kp });
    const result = await mgr.buildAndSubmit(() => {});
    expect(result.hash).toBe('txhash123');
    expect(result.ledger).toBe(42);
    expect(result.envelope).toBe('xdrxdr');
  });

  it('calls addOperations with the TransactionBuilder', async () => {
    const kp  = makeKeypair();
    const mgr = new StellarTransactionManager({ signingKeypair: kp });
    const addOps = jest.fn();
    await mgr.buildAndSubmit(addOps);
    expect(addOps).toHaveBeenCalledTimes(1);
    expect(addOps.mock.calls[0][0]).toBeInstanceOf(StellarSdk.TransactionBuilder);
  });

  it('retries once on tx_bad_seq and succeeds', async () => {
    const seqErr = {
      response: { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } },
      message: 'tx_bad_seq',
    };
    mockSubmitTransaction
      .mockRejectedValueOnce(seqErr)
      .mockResolvedValueOnce({ hash: 'retry-hash', ledger: 43, envelope_xdr: 'xdr2' });

    const kp  = makeKeypair();
    const mgr = new StellarTransactionManager({ signingKeypair: kp });
    const result = await mgr.buildAndSubmit(() => {});
    expect(result.hash).toBe('retry-hash');
    // loadAccount called twice: initial + seq-retry
    expect(mockLoadAccount).toHaveBeenCalledTimes(2);
  });

  it('throws when sequence retry also fails', async () => {
    const seqErr = {
      response: { data: { extras: { result_codes: { transaction: 'tx_bad_seq' } } } },
      message: 'tx_bad_seq',
    };
    mockSubmitTransaction.mockRejectedValue(seqErr);
    const kp  = makeKeypair();
    const mgr = new StellarTransactionManager({ signingKeypair: kp });
    await expect(mgr.buildAndSubmit(() => {})).rejects.toBeDefined();
  });

  it('throws immediately for a non-sequence error without retry', async () => {
    const authErr = {
      response: { data: { extras: { result_codes: { transaction: 'tx_bad_auth' } } } },
      message: 'tx_bad_auth',
    };
    mockSubmitTransaction.mockRejectedValue(authErr);
    const kp  = makeKeypair();
    const mgr = new StellarTransactionManager({ signingKeypair: kp });
    await expect(mgr.buildAndSubmit(() => {})).rejects.toEqual(authErr);
    // loadAccount only once — no seq-retry
    expect(mockLoadAccount).toHaveBeenCalledTimes(1);
  });
});

// ── submitFeeBump ──────────────────────────────────────────────────────────

describe('submitFeeBump', () => {
  it('calls buildFeeBump with the inner transaction and submits', async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: 'bump-hash', ledger: 99 });
    const kp  = makeKeypair();
    const mgr = new StellarTransactionManager({ signingKeypair: kp });
    const result = await mgr.submitFeeBump('inner-xdr', { feeMultiplier: 3 });
    expect(StellarSdk.TransactionBuilder.buildFeeBump).toHaveBeenCalled();
    expect(result.hash).toBe('bump-hash');
    expect(result.ledger).toBe(99);
  });

  it('submits successfully with the default fee multiplier', async () => {
    mockSubmitTransaction.mockResolvedValue({ hash: 'default-bump', ledger: 1 });
    const kp  = makeKeypair();
    const mgr = new StellarTransactionManager({ signingKeypair: kp });
    await expect(mgr.submitFeeBump('xdr')).resolves.toMatchObject({ hash: 'default-bump' });
  });
});

// ── createTransactionManager factory ──────────────────────────────────────

describe('createTransactionManager', () => {
  it('creates a StellarTransactionManager', () => {
    const mgr = createTransactionManager('STEST12345678901234567890123456789012345678901234567890');
    expect(mgr).toBeInstanceOf(StellarTransactionManager);
  });

  it('creates a manager with separate fee source when provided', () => {
    const mgr = createTransactionManager(
      'STEST12345678901234567890123456789012345678901234567890',
      'SFEE0123456789012345678901234567890123456789012345678901',
    );
    expect(mgr.feeSourceKeypair).not.toBe(mgr.signingKeypair);
  });
});
