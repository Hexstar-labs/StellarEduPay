'use strict';

/**
 * Tests for services/emailService.js — the payment receipt email wrapper.
 *
 * This file is separate from emailService.test.js which tests the lower-level
 * email/ module. Here we test the receipt-specific sendPaymentReceipt() function:
 * the no-recipient skip path, template rendering delegation, and the pass-through
 * of the sendEmail result.
 */

// ── Suppress logger noise ──────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// ── Mock the unified email module ─────────────────────────────────────────
const mockSendEmail = jest.fn();
jest.mock('../src/services/email', () => ({
  sendEmail: (...a) => mockSendEmail(...a),
}));

// ── Mock the template renderer ────────────────────────────────────────────
const mockRenderEmailTemplate = jest.fn();
jest.mock('../src/utils/templateRenderer', () => ({
  renderEmailTemplate: (...a) => mockRenderEmailTemplate(...a),
}));

// ── Load the module under test ─────────────────────────────────────────────
const { sendPaymentReceipt } = require('../src/services/emailService');

const BASE_OPTS = {
  to:               'parent@example.com',
  studentName:      'Alice Smith',
  amount:           150,
  txHash:           'abc123def456',
  confirmedAt:      new Date('2026-06-01T10:00:00.000Z'),
  remainingBalance: 50,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRenderEmailTemplate.mockReturnValue({ text: 'Receipt text', html: '<p>Receipt</p>' });
  mockSendEmail.mockResolvedValue({ sent: true, messageId: 'msg-1' });
});

// ── No-recipient early return ──────────────────────────────────────────────

describe('sendPaymentReceipt — no recipient', () => {
  it('returns { sent: false, skipped: true } when `to` is absent', async () => {
    const result = await sendPaymentReceipt({ ...BASE_OPTS, to: undefined });
    expect(result).toEqual({ sent: false, skipped: true });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockRenderEmailTemplate).not.toHaveBeenCalled();
  });

  it('returns { sent: false, skipped: true } when `to` is an empty string', async () => {
    const result = await sendPaymentReceipt({ ...BASE_OPTS, to: '' });
    expect(result).toEqual({ sent: false, skipped: true });
  });

  it('returns { sent: false, skipped: true } when `to` is null', async () => {
    const result = await sendPaymentReceipt({ ...BASE_OPTS, to: null });
    expect(result).toEqual({ sent: false, skipped: true });
  });
});

// ── Successful send ────────────────────────────────────────────────────────

describe('sendPaymentReceipt — with recipient', () => {
  it('calls renderEmailTemplate with "receiptEmail" and the correct data', async () => {
    await sendPaymentReceipt(BASE_OPTS);
    expect(mockRenderEmailTemplate).toHaveBeenCalledWith(
      'receiptEmail',
      expect.objectContaining({
        studentName:     'Alice Smith',
        amount:          150,
        txHash:          'abc123def456',
        remainingBalance: 50,
      }),
    );
  });

  it('passes confirmedAt as an ISO string', async () => {
    await sendPaymentReceipt(BASE_OPTS);
    const [, data] = mockRenderEmailTemplate.mock.calls[0];
    expect(typeof data.confirmedAt).toBe('string');
    expect(data.confirmedAt).toMatch(/Z$/); // ISO 8601 UTC
  });

  it('passes an empty string for remainingBalance when balance is 0 (paid in full)', async () => {
    await sendPaymentReceipt({ ...BASE_OPTS, remainingBalance: 0 });
    const [, data] = mockRenderEmailTemplate.mock.calls[0];
    expect(data.remainingBalance).toBe('');
  });

  it('passes the non-zero remainingBalance as-is', async () => {
    await sendPaymentReceipt({ ...BASE_OPTS, remainingBalance: 75 });
    const [, data] = mockRenderEmailTemplate.mock.calls[0];
    expect(data.remainingBalance).toBe(75);
  });

  it('calls sendEmail with the rendered text and html', async () => {
    await sendPaymentReceipt(BASE_OPTS);
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      'parent@example.com',
        subject: 'Payment Receipt for Alice Smith',
        text:    'Receipt text',
        html:    '<p>Receipt</p>',
        category: 'receipt',
      }),
    );
  });

  it('returns the sendEmail result', async () => {
    mockSendEmail.mockResolvedValue({ sent: true, messageId: 'msg-42' });
    const result = await sendPaymentReceipt(BASE_OPTS);
    expect(result).toEqual({ sent: true, messageId: 'msg-42' });
  });

  it('handles a missing confirmedAt gracefully (uses empty string)', async () => {
    await sendPaymentReceipt({ ...BASE_OPTS, confirmedAt: null });
    const [, data] = mockRenderEmailTemplate.mock.calls[0];
    expect(data.confirmedAt).toBe('');
  });

  it('passes through sendEmail failures without swallowing them', async () => {
    mockSendEmail.mockResolvedValue({ sent: false, error: 'SMTP error' });
    const result = await sendPaymentReceipt(BASE_OPTS);
    expect(result.sent).toBe(false);
    expect(result.error).toBe('SMTP error');
  });
});
