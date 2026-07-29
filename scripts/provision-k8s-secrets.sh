#!/usr/bin/env bash
# provision-k8s-secrets.sh — Initial provisioning for the stellaredupay
# Kubernetes Secret used by the backend deployment.
#
# Usage:
#   JWT_SECRET=<value> MONGO_URI=<value> \
#     [SIGNER_MASTER_KEY=<value>] \
#     [NAMESPACE=default] \
#     [SECRET_NAME=stellaredupay] \
#     [DRY_RUN=1] \
#     ./scripts/provision-k8s-secrets.sh
#
# The script is idempotent — running it again with updated values patches
# the existing secret in place without downtime.
#
# Required env vars:
#   JWT_SECRET        — HS256 signing key for session JWTs.
#                       Generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
#   MONGO_URI         — MongoDB connection string (including credentials).
#
# Optional env vars:
#   SIGNER_MASTER_KEY — AES-256 key that encrypts stored Stellar signing
#                       secret keys at rest (signerKeyManager.js). Required
#                       for a production deployment; if omitted the backend
#                       will start but Stellar signing operations will fail.
#                       Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#   NAMESPACE         — Kubernetes namespace (default: default).
#   SECRET_NAME       — Name of the Secret resource (default: stellaredupay).
#   DRY_RUN           — Set to 1 to print the kubectl command without running it.
#
# Audit trail:
#   The script echoes the cluster context, namespace, secret name, operator,
#   and UTC timestamp on success. Capture this output in your incident or
#   change-management log.
#
# See also: docs/operator-runbooks.md § Secret Provisioning

set -euo pipefail

NAMESPACE="${NAMESPACE:-default}"
SECRET_NAME="${SECRET_NAME:-stellaredupay}"
DRY_RUN="${DRY_RUN:-0}"

# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

missing=()

if [[ -z "${JWT_SECRET:-}" ]]; then
  missing+=("JWT_SECRET")
fi

if [[ -z "${MONGO_URI:-}" ]]; then
  missing+=("MONGO_URI")
fi

if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "ERROR: the following required environment variables are not set:" >&2
  for var in "${missing[@]}"; do
    echo "  - $var" >&2
  done
  echo "" >&2
  echo "See the script header comment for usage and generation instructions." >&2
  exit 1
fi

if [[ -z "${SIGNER_MASTER_KEY:-}" ]]; then
  echo "WARNING: SIGNER_MASTER_KEY is not set. The backend will start but" >&2
  echo "         Stellar signing operations will fail until it is provisioned." >&2
  echo "         For production deployments, set SIGNER_MASTER_KEY." >&2
fi

# ---------------------------------------------------------------------------
# Build the kubectl command
# ---------------------------------------------------------------------------

CLUSTER_CONTEXT="$(kubectl config current-context 2>/dev/null || echo 'unknown')"

echo "Provisioning secret '${SECRET_NAME}' in namespace '${NAMESPACE}'"
echo "  Cluster context : ${CLUSTER_CONTEXT}"
echo "  Operator        : ${USER:-unknown}"
echo "  Timestamp (UTC) : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

KUBECTL_ARGS=(
  create secret generic "${SECRET_NAME}"
  "--from-literal=JWT_SECRET=${JWT_SECRET}"
  "--from-literal=MONGO_URI=${MONGO_URI}"
)

if [[ -n "${SIGNER_MASTER_KEY:-}" ]]; then
  KUBECTL_ARGS+=("--from-literal=SIGNER_MASTER_KEY=${SIGNER_MASTER_KEY}")
fi

KUBECTL_ARGS+=(
  "--namespace=${NAMESPACE}"
  "--dry-run=client"
  "-o" "yaml"
)

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[DRY RUN] Would run:"
  echo "  kubectl ${KUBECTL_ARGS[*]} | kubectl apply -f -"
  exit 0
fi

# Use --dry-run=client | apply so the command is idempotent: it creates the
# secret on first run and patches it on subsequent runs without error.
kubectl "${KUBECTL_ARGS[@]}" | kubectl apply --namespace="${NAMESPACE}" -f -

echo ""
echo "Secret provisioned successfully."
echo "Record this run in your change-management or incident log:"
echo "  Secret   : ${SECRET_NAME}"
echo "  Namespace: ${NAMESPACE}"
echo "  Context  : ${CLUSTER_CONTEXT}"
echo "  Operator : ${USER:-unknown}"
echo "  Time     : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
