// Parses Stellar / Horizon errors from Axios error objects and maps them to
// user-facing messages.  All message text is owned by errorMessages.js — this
// module handles the *detection* logic (code lookup, keyword fallback) only,
// so every form displays identical wording for the same underlying failure.
// See #1216.

import { getErrorMessage } from "./errorMessages";

const STELLAR_STATUS_URL = "https://status.stellar.org";

// Maps an error code (either a Stellar SDK result code like "tx_insufficient_fee"
// or a backend-defined code like "HORIZON_UNREACHABLE") to whether we should
// surface the Stellar status-page URL alongside the message.
const CODE_SHOW_STATUS = {
  tx_insufficient_fee: true,
  op_underfunded:      false,
  HORIZON_UNREACHABLE: true,
  HORIZON_UNAVAILABLE: true,
  STELLAR_NETWORK_ERROR: true,
};

// Fallback: search the error message string for known keywords when the code
// field is absent.  Each entry maps a keyword to a canonical code whose
// message lives in errorMessages.js.
const KEYWORD_MAP = [
  { keyword: "tx_insufficient_fee", ref: "tx_insufficient_fee" },
  { keyword: "op_underfunded",      ref: "op_underfunded" },
  { keyword: "horizon",             ref: "HORIZON_UNREACHABLE" },
  { keyword: "network congestion",  ref: "tx_insufficient_fee" },
  { keyword: "unavailable",         ref: "HORIZON_UNREACHABLE" },
];

/**
 * Attempts to extract a Stellar-specific error from an Axios error.
 *
 * Returns `{ message, stellarStatusUrl }` when the error is Stellar-related,
 * or `null` when the caller should fall back to a generic message via
 * `getErrorMessage()` from errorMessages.js.
 *
 * @param {Error} err - An Axios error (or any error with a `.response` shape).
 * @returns {{ message: string, stellarStatusUrl: string|null } | null}
 */
export function parseStellarError(err) {
  const code    = err?.response?.data?.code  || "";
  const message = err?.response?.data?.error || err?.message || "";

  // Direct code match
  if (code && Object.prototype.hasOwnProperty.call(CODE_SHOW_STATUS, code)) {
    return {
      message:         getErrorMessage(code),
      stellarStatusUrl: CODE_SHOW_STATUS[code] ? STELLAR_STATUS_URL : null,
    };
  }

  // Keyword fallback when the response has no structured code
  const lower = message.toLowerCase();
  for (const { keyword, ref } of KEYWORD_MAP) {
    if (lower.includes(keyword)) {
      return {
        message:         getErrorMessage(ref),
        stellarStatusUrl: CODE_SHOW_STATUS[ref] ? STELLAR_STATUS_URL : null,
      };
    }
  }

  return null;
}
