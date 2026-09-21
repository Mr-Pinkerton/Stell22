#!/bin/bash
# Runner-side SSH wrapper. Pipes a read-only snapshot or the deployed-CLI
# apply script to production. It does not checkout a new application SHA.
set -euo pipefail

mode="${1:-}"
case "$mode" in
  snapshot | apply) ;;
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

remote_script=""
remote_env="APP_DIR='${PROD_APP_DIR}' EXPECTED_SHA='${EXPECTED_SHA}'"
case "$mode" in
  snapshot)
    remote_script="scripts/shadow-activation-readonly-snapshot.sh"
    ;;
  apply)
    : "${CLI_STATE:?}"
    : "${EXPECTED_PRIOR:?}"
    case "$CLI_STATE" in
      on | off) ;;
      *)
        echo "REFUSE code=UNSUPPORTED_ACTION" >&2
        exit 1
        ;;
    esac
    case "$EXPECTED_PRIOR" in
      ABSENT_OR_INACTIVE | ACTIVE) ;;
      *)
        echo "REFUSE code=UNSUPPORTED_ACTION" >&2
        exit 1
        ;;
    esac
    remote_env="${remote_env} CLI_STATE='${CLI_STATE}' EXPECTED_PRIOR='${EXPECTED_PRIOR}'"
    remote_script="scripts/shadow-activation-apply-deployed-cli.sh"
    ;;
esac

if [[ ! -f "$remote_script" ]]; then
  echo "REFUSE code=SETTER_PATH_UNVERIFIED" >&2
  exit 1
fi

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
