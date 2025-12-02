#!/usr/bin/env bash
# send-callback.sh
# Usage:
#   export INGEST_SECRET="..." ; ./scripts/send-callback.sh <JOB_ID>
# Sends a signed POST to https://app.avidiatech.com/api/v1/ingest/callback
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <JOB_ID>"
  exit 1
fi
JOB_ID="$1"
HOST="${INGEST_CALLBACK_HOST:-https://app.avidiatech.com}"
BODY=$(cat <<JSON
{"job_id":"${JOB_ID}","status":"completed","normalized_payload":{"title":"Callback test","description":"Callback test description"}}
JSON
)
if [ -z "${INGEST_SECRET:-}" ]; then
  echo "INGEST_SECRET must be set in environment"
  exit 2
fi
# compute hmac-sha256 hex signature
SIG=$(printf "%s" "$BODY" | openssl dgst -sha256 -hmac "$INGEST_SECRET" -binary | xxd -p -c 256)
echo "POSTing to ${HOST}/api/v1/ingest/callback with signature: ${SIG}"
curl -v -X POST "${HOST}/api/v1/ingest/callback" \
  -H "Content-Type: application/json" \
  -H "x-avidiatech-signature: ${SIG}" \
  -d "$BODY"
echo
