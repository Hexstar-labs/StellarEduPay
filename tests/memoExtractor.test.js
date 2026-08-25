'use strict';

// Must set required env vars before any module that loads config/index.js
process.env.MONGO_URI = 'mongodb://localhost:27017/test';
process.env.SCHOOL_WALLET_ADDRESS = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// The original memo parsing lived in `backend/src/services/parsers/memoExtractor`
// (extractMemo / extractByType). That module was removed and the logic rewritten
// into `backend/src/utils/stellarMemo.js`, whose public API is
// `decodeMemoToCanonical(value, memoType)`, `normalizeMemoType(memoType)` and
// `isCanonicalMemo(memo)`. This test was rewritten against the current
// implementation, preserving every case the old test covered — in particular the
// per-memo-type parsing (text / id / hash / return / unknown) and the #1118
// guarantees that MEMO_ID and MEMO_HASH decode back to the canonical 8-char
// payment-reference memo rather than matching on a coincidence.
const {
  decodeMemoToCanonical,
  normalizeMemoType,
  isCanonicalMemo,
} = require('../backend/src/utils/stellarMemo');

describe('stellarMemo (formerly memoExtractor)', () => {
  describe('decodeMemoToCanonical — MEMO_TEXT', () => {
    it('should pass a string memo through as the canonical form', () => {
      expect(decodeMemoToCanonical('STU001', 'text')).toBe('STU001');
    });

    it('should trim whitespace from a string memo', () => {
      expect(decodeMemoToCanonical('  STU001  ', 'text')).toBe('STU001');
    });

    it('should accept the SEP-0007 spelling MEMO_TEXT', () => {
      expect(decodeMemoToCanonical('STU001', 'MEMO_TEXT')).toBe('STU001');
    });

    it('should return null for a missing/empty value', () => {
      expect(decodeMemoToCanonical(null, 'text')).toBeNull();
      expect(decodeMemoToCanonical('', 'text')).toBeNull();
    });
  });

  describe('decodeMemoToCanonical — MEMO_ID (#1118)', () => {
    it('should decode MEMO_ID to the canonical payment reference', () => {
      // 12345 decimal === 0x3039 → zero-padded canonical 8-hex form.
      expect(decodeMemoToCanonical('12345', 'id')).toBe('00003039');
    });

    it('should reject a MEMO_ID outside the 32-bit reference space', () => {
      // Exchange-style routing identifiers must not be truncated into a match.
      expect(decodeMemoToCanonical('18446744073709551615', 'id')).toBeNull();
    });

    it('should reject a non-numeric MEMO_ID', () => {
      expect(decodeMemoToCanonical('abc', 'id')).toBeNull();
    });
  });

  describe('decodeMemoToCanonical — MEMO_HASH (#1118)', () => {
    it('should decode a MEMO_HASH carrying a canonical reference', () => {
      // 28 zero padding bytes + the 4-byte tail holding A3F91B2C.
      const value = `${'00'.repeat(28)}a3f91b2c`;
      const result = decodeMemoToCanonical(value, 'hash');
      expect(result).toBe('A3F91B2C');
    });

    it('should reject a MEMO_HASH that is a foreign 32-byte value', () => {
      expect(decodeMemoToCanonical('ab'.repeat(32), 'hash')).toBeNull();
    });

    it('should reject a malformed MEMO_HASH', () => {
      expect(decodeMemoToCanonical('abc123def456', 'hash')).toBeNull();
    });
  });

  describe('decodeMemoToCanonical — rejected / unknown types', () => {
    it('should reject MEMO_RETURN type', () => {
      expect(decodeMemoToCanonical('abc123def456', 'return')).toBeNull();
    });

    it('should reject an unknown memo type', () => {
      expect(decodeMemoToCanonical('something', 'unknown')).toBeNull();
    });
  });

  describe('normalizeMemoType', () => {
    it('should normalise the lowercase spelling', () => {
      expect(normalizeMemoType('text')).toBe('MEMO_TEXT');
      expect(normalizeMemoType('id')).toBe('MEMO_ID');
      expect(normalizeMemoType('hash')).toBe('MEMO_HASH');
    });

    it('should accept the SEP-0007 spelling unchanged', () => {
      expect(normalizeMemoType('MEMO_TEXT')).toBe('MEMO_TEXT');
    });

    it('should return null for an unsupported type', () => {
      expect(normalizeMemoType('return')).toBeNull();
      expect(normalizeMemoType('unknown')).toBeNull();
    });

    it('should return null for a missing type', () => {
      expect(normalizeMemoType(null)).toBeNull();
      expect(normalizeMemoType('')).toBeNull();
    });
  });

  describe('isCanonicalMemo', () => {
    it('should recognise an 8-hex-character canonical memo', () => {
      expect(isCanonicalMemo('A3F91B2C')).toBe(true);
    });

    it('should reject a free-text memo that is not 8 hex chars', () => {
      expect(isCanonicalMemo('STU001')).toBe(false);
    });

    it('should reject a missing memo', () => {
      expect(isCanonicalMemo(null)).toBe(false);
      expect(isCanonicalMemo('')).toBe(false);
    });
  });
});
