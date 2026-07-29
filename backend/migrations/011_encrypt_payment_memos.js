'use strict';

/**
 * Migration 011 — Memo encryption backfill (HISTORICAL NO-OP).
 *
 * This migration was written to backfill AES-256-GCM encrypted memos for the
 * MEMO_ENCRYPTION_KEY feature. That feature has since been permanently removed
 * because AES-256-GCM output (IV + ciphertext + auth tag, base64url-encoded)
 * always exceeds Stellar's hard 28-byte MEMO_TEXT limit, silently breaking the
 * exact-match memo lookups used for student payment matching.
 *
 * The encryption code (backend/src/utils/memoEncryption.js), its call sites in
 * paymentModel.js, and the MEMO_ENCRYPTION_KEY startup guard in config/index.js
 * have all been removed. This file is kept as a historical record so that the
 * migration runner (which tracks applied migrations by version string) continues
 * to treat 011 as already-applied and does not attempt a re-run.
 *
 * No database writes are performed by either up() or down().
 */

const VERSION = '011_encrypt_payment_memos';

async function up() {
  console.log('[011] Memo encryption migration is a historical no-op — feature was removed. Skipping.');
}

async function down() {
  console.log('[011] down() is a no-op — memo encryption feature has been permanently removed.');
}

module.exports = { version: VERSION, up, down };
