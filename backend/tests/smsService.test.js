'use strict';

/**
 * Tests for smsService.
 *
 * Covers dev-mode fallback (no Twilio credentials), successful send paths,
 * error handling, WhatsApp address normalisation, and isTwilioConfigured().
 *
 * The config module and the twilio package are mocked so no real credentials
 * or network calls are needed.
 */

// ── Suppress logger noise ──────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// ── Config mock — reassigned per describe block ────────────────────────────
let mockConfig = {};

jest.mock('../src/config', () => mockConfig);

// ── Twilio mock ────────────────────────────────────────────────────────────
const mockMessagesCreate = jest.fn();
const mockTwilioClient   = { messages: { create: mockMessagesCreate } };
const mockTwilio         = jest.fn(() => mockTwilioClient);

jest.mock('twilio', () => mockTwilio, { virtual: true });

// ── Helper: load a fresh isolated smsService ──────────────────────────────
function loadService() {
  let svc;
  jest.isolateModules(() => {
    svc = require('../src/services/smsService');
  });
  return svc;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: fully configured Twilio credentials
  mockConfig = {
    TWILIO_ACCOUNT_SID:   'ACtest',
    TWILIO_AUTH_TOKEN:    'authtoken',
    TWILIO_FROM_NUMBER:   '+15005550006',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
  };
});

// ── isTwilioConfigured ─────────────────────────────────────────────────────

describe('isTwilioConfigured', () => {
  it('returns true when all three required credentials are set', () => {
    const svc = loadService();
    expect(svc.isTwilioConfigured()).toBe(true);
  });

  it('returns false when TWILIO_ACCOUNT_SID is missing', () => {
    mockConfig = { ...mockConfig, TWILIO_ACCOUNT_SID: null };
    const svc = loadService();
    expect(svc.isTwilioConfigured()).toBe(false);
  });

  it('returns false when TWILIO_AUTH_TOKEN is missing', () => {
    mockConfig = { ...mockConfig, TWILIO_AUTH_TOKEN: null };
    const svc = loadService();
    expect(svc.isTwilioConfigured()).toBe(false);
  });

  it('returns false when TWILIO_FROM_NUMBER is missing', () => {
    mockConfig = { ...mockConfig, TWILIO_FROM_NUMBER: null };
    const svc = loadService();
    expect(svc.isTwilioConfigured()).toBe(false);
  });
});

// ── sendSms — dev-mode fallback ────────────────────────────────────────────

describe('sendSms — dev-mode (no credentials)', () => {
  it('returns { sent: false } without calling Twilio when SID is absent', async () => {
    mockConfig = { TWILIO_ACCOUNT_SID: null, TWILIO_AUTH_TOKEN: null, TWILIO_FROM_NUMBER: null };
    const svc = loadService();
    const result = await svc.sendSms('+447700900000', 'hello');
    expect(result).toEqual({ sent: false });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('returns { sent: false } when FROM_NUMBER is absent even if SID/token are set', async () => {
    mockConfig = { ...mockConfig, TWILIO_FROM_NUMBER: null };
    const svc = loadService();
    const result = await svc.sendSms('+447700900000', 'hello');
    expect(result).toEqual({ sent: false });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});

// ── sendSms — successful send ──────────────────────────────────────────────

describe('sendSms — with credentials', () => {
  it('calls Twilio messages.create with correct params', async () => {
    mockMessagesCreate.mockResolvedValue({ sid: 'SM123' });
    const svc = loadService();
    const result = await svc.sendSms('+447700900000', 'fee reminder');
    expect(mockTwilio).toHaveBeenCalledWith('ACtest', 'authtoken');
    expect(mockMessagesCreate).toHaveBeenCalledWith({
      from: '+15005550006',
      to:   '+447700900000',
      body: 'fee reminder',
    });
    expect(result).toEqual({ sent: true, sid: 'SM123' });
  });

  it('returns { sent: false, error } when Twilio throws', async () => {
    mockMessagesCreate.mockRejectedValue(new Error('Invalid phone number'));
    const svc = loadService();
    const result = await svc.sendSms('+000', 'test');
    expect(result.sent).toBe(false);
    expect(result.error).toBe('Invalid phone number');
  });

  it('reuses the lazily-created Twilio client on subsequent calls', async () => {
    mockMessagesCreate.mockResolvedValue({ sid: 'SM1' });
    const svc = loadService();
    await svc.sendSms('+1', 'msg1');
    await svc.sendSms('+2', 'msg2');
    // twilio() constructor should be called only once
    expect(mockTwilio).toHaveBeenCalledTimes(1);
  });
});

// ── sendWhatsApp — dev-mode fallback ──────────────────────────────────────

describe('sendWhatsApp — dev-mode (no credentials)', () => {
  it('returns { sent: false } when TWILIO_WHATSAPP_FROM is absent', async () => {
    mockConfig = { ...mockConfig, TWILIO_WHATSAPP_FROM: null };
    const svc = loadService();
    const result = await svc.sendWhatsApp('+447700900001', 'whatsapp msg');
    expect(result).toEqual({ sent: false });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('returns { sent: false } when credentials are absent', async () => {
    mockConfig = { TWILIO_ACCOUNT_SID: null, TWILIO_AUTH_TOKEN: null, TWILIO_FROM_NUMBER: null, TWILIO_WHATSAPP_FROM: null };
    const svc = loadService();
    const result = await svc.sendWhatsApp('+447700900001', 'whatsapp msg');
    expect(result).toEqual({ sent: false });
  });
});

// ── sendWhatsApp — successful send ────────────────────────────────────────

describe('sendWhatsApp — with credentials', () => {
  it('prefixes "whatsapp:" to a plain E.164 number', async () => {
    mockMessagesCreate.mockResolvedValue({ sid: 'WA456' });
    const svc = loadService();
    const result = await svc.sendWhatsApp('+447700900001', 'hi');
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'whatsapp:+447700900001' }),
    );
    expect(result).toEqual({ sent: true, sid: 'WA456' });
  });

  it('does not double-prefix a number already starting with "whatsapp:"', async () => {
    mockMessagesCreate.mockResolvedValue({ sid: 'WA789' });
    const svc = loadService();
    await svc.sendWhatsApp('whatsapp:+447700900001', 'hi');
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'whatsapp:+447700900001' }),
    );
  });

  it('uses the configured TWILIO_WHATSAPP_FROM as sender', async () => {
    mockMessagesCreate.mockResolvedValue({ sid: 'WA1' });
    const svc = loadService();
    await svc.sendWhatsApp('+1', 'test');
    expect(mockMessagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'whatsapp:+14155238886' }),
    );
  });

  it('returns { sent: false, error } when Twilio throws', async () => {
    mockMessagesCreate.mockRejectedValue(new Error('Rate limit exceeded'));
    const svc = loadService();
    const result = await svc.sendWhatsApp('+1', 'msg');
    expect(result.sent).toBe(false);
    expect(result.error).toBe('Rate limit exceeded');
  });
});
