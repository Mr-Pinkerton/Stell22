#!/bin/bash
# Runner-side SSH wrapper for the read-only SHADOW soak evidence snapshot.
# It has no setter, reset, or deploy mode.
set -euo pipefail

mode="${1:-}"
case "$mode" in
  snapshot) ;;
  *)
    echo "REFUSE code=UNSUPPORTED_ACTION" >&2
    exit 1
    ;;
esac

: "${PROD_HOST:?}"
: "${PROD_USER:?}"
: "${PROD_SSH_KEY:?}"
: "${PROD_APP_DIR:?}"
: "${EXPECTED_SHA:?}"

if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "REFUSE code=SHA_MALFORMED" >&2
  exit 1
fi
if [[ ! "$PROD_APP_DIR" =~ ^/[A-Za-z0-9/_.-]+$ ]]; then
  echo "REFUSE code=SNAPSHOT_INVALID" >&2
  exit 1
fi
if [[ ! "$PROD_HOST" =~ ^[A-Za-z0-9.:_-]+$ ]]; then
  echo "REFUSE code=SNAPSHOT_INVALID" >&2
  exit 1
fi
if [[ ! "$PROD_USER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "REFUSE code=SNAPSHOT_INVALID" >&2
  exit 1
fi

port="${PROD_PORT:-22}"
if [[ ! "$port" =~ ^[0-9]+$ ]]; then
  echo "REFUSE code=SNAPSHOT_INVALID" >&2
  exit 1
fi

shift_start="${SHIFT_START:-}"
shift_end="${SHIFT_END:-}"
if [[ -z "$shift_start" && -z "$shift_end" ]]; then
  :
elif [[ -n "$shift_start" && -n "$shift_end" ]]; then
  if [[ ! "$shift_start" =~ ^[0-9]{8}T[0-9]{6}Z$ || ! "$shift_end" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
    echo "REFUSE code=SHIFT_INTERVAL_INVALID" >&2
    exit 1
  fi
  if [[ "$shift_start" > "$shift_end" ]]; then
    echo "REFUSE code=SHIFT_INTERVAL_INVALID" >&2
    exit 1
  fi
else
  echo "REFUSE code=SHIFT_INTERVAL_INVALID" >&2
  exit 1
fi

remote_script="scripts/shadow-soak-evidence-readonly-snapshot.sh"
if [[ ! -f "$remote_script" ]]; then
  echo "REFUSE code=SNAPSHOT_INVALID" >&2
  exit 1
fi

remote_env="APP_DIR='${PROD_APP_DIR}' EXPECTED_SHA='${EXPECTED_SHA}' SHIFT_START='${shift_start}' SHIFT_END='${shift_end}'"

keyfile="$(mktemp)"
known="$(mktemp)"
trap 'rm -f "$keyfile" "$known"' EXIT
printf '%s\n' "$PROD_SSH_KEY" >"$keyfile"
chmod 600 "$keyfile"

ssh -i "$keyfile" \
  -p "$port" \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$known" \
  -o BatchMode=yes \
  "${PROD_USER}@${PROD_HOST}" \
  "${remote_env} bash -s" <"$remote_script"
