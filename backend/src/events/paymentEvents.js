'use strict';

const { EventEmitter } = require('events');

/**
 * Shared event bus for payment lifecycle events.
 *
 * Events:
 *   'payment.saved'  — emitted by transactionService.savePayment after a
 *                      payment record is successfully persisted to MongoDB.
 *                      Payload: the saved Payment document (plain object).
 */
const paymentEvents = new EventEmitter();

// Prevent silent event-loop leaks when many subscribers are registered.
paymentEvents.setMaxListeners(20);

/**
 * Emit an event and await all listener results via Promise.allSettled.
 *
 * Unlike EventEmitter.prototype.emit, which invokes listeners synchronously
 * and ignores any promises they return, this method collects every listener's
 * return value — whether a plain value or a promise — and waits for all of
 * them to settle. This is essential for the outbox dispatcher, which must
 * confirm that every async side-effect (webhook delivery, receipt generation,
 * etc.) completed before marking an outbox event as processed.
 *
 * @param {string} eventType
 * @param {...*} args — arguments forwarded to each listener
 * @returns {Promise<PromiseSettledResult[]>} settled results from every listener
 */
paymentEvents.asyncEmit = async function asyncEmit(eventType, ...args) {
  const listeners = paymentEvents.rawListeners(eventType);
  if (listeners.length === 0) return [];

  const results = await Promise.allSettled(
    listeners.map((listener) => {
      try {
        const result = listener(...args);
        // If the listener returned a promise, wait for it to settle;
        // otherwise wrap the plain value as a fulfilled promise.
        return (result != null && typeof result.then === 'function')
          ? result
          : Promise.resolve(result);
      } catch (err) {
        return Promise.reject(err);
      }
    }),
  );

  return results;
};

module.exports = paymentEvents;
