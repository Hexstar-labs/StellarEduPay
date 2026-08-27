'use strict';

const nodemailer = require('nodemailer');
const axios = require('axios');

const logger = require('../utils/logger').child('AlertService');

// Severity levels: info, warn, critical
const SEVERITY_LEVELS = {
  info: 0,
  warn: 1,
  critical: 2,
};

// Initialize email transporter (will be null if email config is missing)
let emailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Send an admin alert with optional email and webhook delivery.
 *
 * @param {string} message - Alert message
 * @param {object} options - Configuration options
 * @param {string} [options.severity] - 'info', 'warn', or 'critical' (default: 'warn')
 * @param {object} [options.details] - Additional details to include
 * @param {string} [options.timestamp] - ISO timestamp (default: now)
 */
async function sendAdminAlert(message, options = {}) {
  const {
    severity = 'warn',
    details = {},
    timestamp = new Date().toISOString(),
  } = options;

  // Always log to ensure we have a record
  logger[severity === 'critical' ? 'error' : 'warn'](
    `[ALERT:${severity.toUpperCase()}] ${message}`,
    details
  );

  // Route to delivery channels based on severity
  const deliveryPromises = [];

  // Email alerts for warn and critical
  if (
    (severity === 'warn' || severity === 'critical') &&
    process.env.ADMIN_ALERT_EMAIL &&
    emailTransporter
  ) {
    deliveryPromises.push(
      sendEmailAlert(message, severity, details, timestamp).catch(err => {
        logger.error('[AlertService] Email delivery failed (alert still logged)', {
          reason: err.message,
          severity,
        });
      })
    );
  }

  // Webhook alerts for critical only
  if (severity === 'critical' && process.env.ADMIN_ALERT_WEBHOOK_URL) {
    deliveryPromises.push(
      sendWebhookAlert(message, severity, details, timestamp).catch(err => {
        logger.error('[AlertService] Webhook delivery failed (alert still logged)', {
          reason: err.message,
          severity,
        });
      })
    );
  }

  // Wait for all delivery attempts (failures are logged but don't throw)
  if (deliveryPromises.length > 0) {
    await Promise.all(deliveryPromises);
  }
}

/**
 * Send email alert to configured admin address.
 *
 * @private
 */
async function sendEmailAlert(message, severity, details, timestamp) {
  if (!emailTransporter || !process.env.ADMIN_ALERT_EMAIL) {
    return;
  }

  const severityColor = {
    info: '#3498db',
    warn: '#f39c12',
    critical: '#e74c3c',
  }[severity];

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      <div style="background-color: ${severityColor}; color: white; padding: 20px; margin-bottom: 20px;">
        <h2 style="margin: 0;">Alert: ${severity.toUpperCase()}</h2>
      </div>
      <div style="padding: 20px; background-color: #f5f5f5; border-radius: 4px;">
        <p><strong>Message:</strong></p>
        <p style="background-color: white; padding: 10px; border-left: 3px solid ${severityColor};">
          ${escapeHtml(message)}
        </p>
        ${details && Object.keys(details).length > 0 ? `
          <p><strong>Details:</strong></p>
          <pre style="background-color: white; padding: 10px; overflow-x: auto; border-left: 3px solid ${severityColor};">${escapeHtml(JSON.stringify(details, null, 2))}</pre>
        ` : ''}
        <p style="color: #666; font-size: 12px; margin-top: 20px;">
          Timestamp: ${timestamp}
        </p>
      </div>
    </div>
  `;

  await emailTransporter.sendMail({
    from: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER,
    to: process.env.ADMIN_ALERT_EMAIL,
    subject: `[StellarEduPay Alert] ${severity.toUpperCase()}: ${message.substring(0, 50)}`,
    html,
  });
}

/**
 * Send webhook alert to configured URL.
 *
 * @private
 */
async function sendWebhookAlert(message, severity, details, timestamp) {
  if (!process.env.ADMIN_ALERT_WEBHOOK_URL) {
    return;
  }

  const payload = {
    alertType: 'StellarEduPay',
    severity,
    message,
    details,
    timestamp,
  };

  await axios.post(process.env.ADMIN_ALERT_WEBHOOK_URL, payload, {
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'StellarEduPay/AlertService',
    },
  });
}

/**
 * Escape HTML to prevent injection in emails.
 *
 * @private
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

module.exports = { sendAdminAlert };
