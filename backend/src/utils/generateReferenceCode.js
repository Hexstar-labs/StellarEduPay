const crypto = require('crypto');
const Payment = require('../models/paymentModel');

/**
 * Generate a unique payment reference code: PAY-XXXXXXXXXX
 * (10 uppercase alphanumeric chars = 36^10 ≈ 3.6 trillion combinations)
 */
async function generateReferenceCode(maxAttempts = 5) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let i = 0; i < maxAttempts; i++) {
    const suffix = Array.from({ length: 10 }, () => chars[crypto.randomInt(0, chars.length)]).join('');
    const code = `PAY-${suffix}`;
    const exists = await Payment.exists({ referenceCode: code });
    if (!exists) return code;
  }
  throw Object.assign(new Error('Failed to generate a unique payment reference code'), { code: 'INTERNAL_ERROR' });
}

module.exports = { generateReferenceCode };
