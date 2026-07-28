'use strict';

const Outbox = require('../src/models/outboxModel');
const paymentEvents = require('../src/events/paymentEvents');

jest.mock('../src/models/outboxModel', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/events/paymentEvents', () => ({
  emit: jest.fn(),
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

describe('outboxDispatcher dead-letter handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockOutboxBatch(batch) {
    const sort = jest.fn().mockResolvedValue(batch);
    const limit = jest.fn(() => ({ sort }));
    Outbox.find.mockReturnValue({ limit });

    return { limit, sort };
  }

  it('dead-letters exhausted events and still dispatches healthy events in the batch', async () => {
    const exhaustedEvent = {
      _id: 'outbox-dead',
      eventId: 'dead-event',
      eventType: 'payment.failed_permanently',
      payload: { paymentId: 'dead' },
      retryCount: 3,
      lastError: 'listener no longer exists',
    };
    const healthyEvent = {
      _id: 'outbox-healthy',
      eventId: 'healthy-event',
      eventType: 'payment.confirmed',
      payload: { paymentId: 'healthy' },
      retryCount: 0,
    };

    mockOutboxBatch([exhaustedEvent, healthyEvent]);

    await dispatchOutboxEvents();

    expect(Outbox.find).toHaveBeenCalledWith({
      processed: false,
      deadLettered: { $ne: true },
    });
    expect(paymentEvents.emit).toHaveBeenCalledTimes(1);
    expect(paymentEvents.emit).toHaveBeenCalledWith('payment.confirmed', healthyEvent.payload);
    expect(Outbox.findByIdAndUpdate).toHaveBeenCalledWith(
      exhaustedEvent._id,
      expect.objectContaining({
        retryCount: 3,
        lastError: 'listener no longer exists',
        deadLettered: true,
        deadLetterReason: 'max_retries_exhausted',
      })
    );
    expect(Outbox.findByIdAndUpdate).toHaveBeenCalledWith(
      healthyEvent._id,
      expect.objectContaining({
        processed: true,
        processedAt: expect.any(Date),
      })
    );
    expect(mockOutboxLogger.error).toHaveBeenCalledWith(
      'Outbox event exceeded max retries',
      expect.objectContaining({ eventId: 'dead-event', retryCount: 3 })
    );
  });

  it('marks a permanently failing event dead-lettered when its final retry fails', async () => {
    const failingEvent = {
      _id: 'outbox-failing',
      eventId: 'failing-event',
      eventType: 'payment.confirmed',
      payload: { paymentId: 'failing' },
      retryCount: 2,
    };
    const failure = new Error('listener crashed');

    mockOutboxBatch([failingEvent]);
    paymentEvents.emit.mockImplementationOnce(() => {
      throw failure;
    });

    await dispatchOutboxEvents();

    expect(Outbox.findByIdAndUpdate).toHaveBeenCalledWith(
      failingEvent._id,
      expect.objectContaining({
        retryCount: 3,
        lastError: failure.message,
        deadLettered: true,
        deadLetteredAt: expect.any(Date),
        deadLetterReason: 'max_retries_exhausted',
      })
    );
  });
});
