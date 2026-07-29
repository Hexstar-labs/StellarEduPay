'use strict';

/**
 * Tests that the outbox dispatcher does NOT mark an event as processed when
 * an async listener rejects — the event must instead be retried or
 * dead-lettered, preserving the at-least-once delivery guarantee.
 *
 * Acceptance criteria (issue #1050):
 *   "An outbox event whose listener's async portion throws is not marked
 *    processed: true, and is instead retried or routed to the existing
 *    dead-letter/retry mechanism; a test simulates an async listener
 *    rejection and asserts the outbox row remains unprocessed (or is
 *    retried) rather than being marked complete."
 */

const Outbox = require('../src/models/outboxModel');
const paymentEvents = require('../src/events/paymentEvents');

jest.mock('../src/models/outboxModel', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/events/paymentEvents', () => ({
  emit: jest.fn(),
  asyncEmit: jest.fn(),
}));

const mockOutboxLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

jest.mock('../src/utils/logger', () => ({
  child: jest.fn(() => mockOutboxLogger),
}));

const { dispatchOutboxEvents } = require('../src/services/outboxDispatcher');

describe('outboxDispatcher — async listener rejection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockOutboxBatch(batch) {
    const sort = jest.fn().mockResolvedValue(batch);
    const limit = jest.fn(() => ({ sort }));
    Outbox.find.mockReturnValue({ limit });
    return { limit, sort };
  }

  it('retries an event whose async listener rejects', async () => {
    const event = {
      _id: 'outbox-retry',
      eventId: 'retry-event',
      eventType: 'payment.saved',
      payload: { paymentId: 'p1' },
      retryCount: 0,
    };

    mockOutboxBatch([event]);

    // Simulate asyncEmit returning one rejected and one fulfilled result
    paymentEvents.asyncEmit.mockResolvedValue([
      { status: 'rejected', reason: new Error('webhook timeout') },
    ]);

    await dispatchOutboxEvents();

    // The event should NOT be marked processed
    expect(Outbox.findByIdAndUpdate).not.toHaveBeenCalledWith(
      event._id,
      expect.objectContaining({ processed: true }),
    );

    // Instead, retryCount should be incremented with the error message
    expect(Outbox.findByIdAndUpdate).toHaveBeenCalledWith(
      event._id,
      expect.objectContaining({
        retryCount: 1,
        lastError: 'Listener(s) rejected: webhook timeout',
      }),
    );

    // Dead-letter should NOT have been called (retry budget not exhausted)
    expect(Outbox.findByIdAndUpdate).not.toHaveBeenCalledWith(
      event._id,
      expect.objectContaining({ deadLettered: true }),
    );

    expect(mockOutboxLogger.error).not.toHaveBeenCalledWith(
      'Outbox event exceeded max retries',
      expect.anything(),
    );
  });

  it('dead-letters after max retries when async listener keeps rejecting', async () => {
    const event = {
      _id: 'outbox-deadletter-async',
      eventId: 'deadletter-async',
      eventType: 'payment.saved',
      payload: { paymentId: 'p2' },
      retryCount: 2,
    };

    mockOutboxBatch([event]);

    paymentEvents.asyncEmit.mockResolvedValue([
      { status: 'rejected', reason: new Error('persistent webhook failure') },
    ]);

    await dispatchOutboxEvents();

    // Should be dead-lettered (retryCount 2 + 1 = 3 >= MAX_RETRIES)
    expect(Outbox.findByIdAndUpdate).toHaveBeenCalledWith(
      event._id,
      expect.objectContaining({
        retryCount: 3,
        lastError: 'Listener(s) rejected: persistent webhook failure',
        deadLettered: true,
        deadLetteredAt: expect.any(Date),
        deadLetterReason: 'max_retries_exhausted',
      }),
    );

    expect(mockOutboxLogger.error).toHaveBeenCalledWith(
      'Outbox event exceeded max retries',
      expect.objectContaining({ eventId: 'deadletter-async', retryCount: 3 }),
    );
  });

  it('marks event processed when all async listeners resolve', async () => {
    const event = {
      _id: 'outbox-success',
      eventId: 'success-event',
      eventType: 'payment.saved',
      payload: { paymentId: 'p3' },
      retryCount: 0,
    };

    mockOutboxBatch([event]);

    // All listeners succeeded
    paymentEvents.asyncEmit.mockResolvedValue([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: { receiptId: 'r1' } },
    ]);

    await dispatchOutboxEvents();

    // Event should be marked processed
    expect(Outbox.findByIdAndUpdate).toHaveBeenCalledWith(
      event._id,
      expect.objectContaining({
        processed: true,
        processedAt: expect.any(Date),
      }),
    );
  });
});
