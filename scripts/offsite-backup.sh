#!/bin/sh
# Daily offsite backup orchestration for Stell22.
#
# Producer: scripts/backup-db.sh. This entry point does not replace it and
# does not open a database. Plaintext SQL and plaintext gzip are not uploaded.
# Objects are created with If-None-Match and are never overwritten or deleted.
#
# Success of this entry point is OFFSITE_VERIFIED. It is not RESTORE_VERIFIED.
# The scheduler is a systemd timer at 03:00 Europe/Moscow. Installing that
# timer is a separate activation step and is not performed here.
set -eu
umask 077
set +x

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
# shellcheck source=offsite-backup-lib.sh
. "$SCRIPT_DIR/offsite-backup-lib.sh"

if [ "${STELL22_OFFSITE_LOCK_HELD:-}" != "1" ]; then
  offsite_prepare
  _lock="$OFFSITE_STATE_DIR/offsite.lock"
  : > "$_lock"
  export STELL22_OFFSITE_LOCK_HELD=1
  set +e
  flock -n "$_lock" sh "$0" "$@"
  _rc=$?
  set -e
  if [ "$_rc" -eq 1 ]; then
    offsite_die FAILED concurrent 13
  fi
  exit "$_rc"
fi

trap ' _status=$?; if [ "$_status" -eq 1 ]; then trap - EXIT; printf "%s\n" "STATUS=FAILED" "REASON=unexpected-exit" "RESTORE_VERIFIED=0"; exit 10; fi' EXIT
offsite_prepare
offsite_run
