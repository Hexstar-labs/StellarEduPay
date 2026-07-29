#!/usr/bin/env bash
# restore.sh — Restore a StellarEduPay database from a compressed mongodump archive.
#
# Usage:
#   MONGO_URI=mongodb://localhost:27017/stellaredupay \
#   BACKUP_FILE=./backups/20260326T120000Z.gz \
#   ./scripts/restore.sh [--dry-run] [--yes]
#
# Environment variables:
#   MONGO_URI    — MongoDB connection string (required)
#   BACKUP_FILE  — Path to the .gz backup archive (required)
#   DROP         — Set to "true" to drop existing collections before restore (default: false)
#   DRY_RUN      — Set to "true" to print the target database URI and mongorestore
#                  commands that would be executed, without mutating the database.
#
# Flags:
#   --dry-run    — Equivalent to DRY_RUN=true
#   --yes / -y   — Skip interactive confirmation when DROP=true
#   --drop       — Equivalent to DROP=true (convenience flag)

set -euo pipefail

# ── Parse flags ───────────────────────────────────────────────────────────────
SKIP_CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    --yes|-y)   SKIP_CONFIRM=true ;;
    --drop)     DROP=true ;;
    -*)
      echo "[restore] ERROR: Unknown flag: $arg" >&2
      echo "[restore] Usage: $0 [--dry-run] [--yes|-y] [--drop]" >&2
      exit 1
      ;;
  esac
done

# ── Environment defaults ──────────────────────────────────────────────────────
MONGO_URI="${MONGO_URI:?MONGO_URI is required}"
BACKUP_FILE="${BACKUP_FILE:?BACKUP_FILE is required}"
DROP="${DROP:-false}"       # safe default: do NOT drop collections
DRY_RUN="${DRY_RUN:-false}"

# ── Validate backup file ──────────────────────────────────────────────────────
if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "[restore] ERROR: Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

# ── Dry-run mode ──────────────────────────────────────────────────────────────
if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[restore] DRY-RUN mode — no data will be written."
  echo "[restore] Target database URI : ${MONGO_URI}"
  echo "[restore] Backup archive      : ${BACKUP_FILE}"
  echo "[restore] DROP collections    : ${DROP}"
  echo ""
  if [[ "${DROP}" == "true" ]]; then
    echo "[restore] Would execute:"
    echo "  mongorestore --uri=\"${MONGO_URI}\" --archive=\"${BACKUP_FILE}\" --gzip --drop"
  else
    echo "[restore] Would execute:"
    echo "  mongorestore --uri=\"${MONGO_URI}\" --archive=\"${BACKUP_FILE}\" --gzip"
  fi
  echo "[restore] Dry-run complete — no changes made."
  exit 0
fi

# ── Interactive confirmation when DROP=true ───────────────────────────────────
DROP_FLAG=""
if [[ "${DROP}" == "true" ]]; then
  if [[ "${SKIP_CONFIRM}" != "true" ]]; then
    echo ""
    echo "WARNING: You are about to DROP existing collections on ${MONGO_URI}."
    echo "         This will permanently delete all data in those collections before"
    echo "         restoring from: ${BACKUP_FILE}"
    echo ""
    read -r -p "Are you sure? [y/N] " CONFIRM
    case "$CONFIRM" in
      y|Y) ;;
      *)
        echo "[restore] Restore aborted by operator."
        exit 1
        ;;
    esac
  fi
  DROP_FLAG="--drop"
fi

# ── Execute restore ───────────────────────────────────────────────────────────
echo "[restore] Restoring from ${BACKUP_FILE} into ${MONGO_URI} (drop=${DROP})"
mongorestore --uri="${MONGO_URI}" --archive="${BACKUP_FILE}" --gzip ${DROP_FLAG}
echo "[restore] Restore complete"
