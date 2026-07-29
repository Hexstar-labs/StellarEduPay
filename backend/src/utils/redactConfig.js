'use strict';

const SENSITIVE_KEYS = new Set(['JWT_SECRET', 'WEBHOOK_SECRET', 'MONGO_URI', 'MONGODB_URI', 'SMTP_PASS', 'REDIS_PASSWORD']);

function redactConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  return Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, SENSITIVE_KEYS.has(k) && v !== undefined ? '[REDACTED]' : v]));
}

module.exports = { redactConfig, SENSITIVE_KEYS };
