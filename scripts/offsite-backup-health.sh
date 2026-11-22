#!/bin/sh
# Read-only health check for the latest confirmed offsite backup.
# Exit 0 means OFFSITE_VERIFIED within the age limit, or a run still holding
# the lock. Every problem uses a documented non-zero exit.
# RESTORE_VERIFIED is never reported by this check.
set -eu
umask 077
set +x

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
# shellcheck source=offsite-backup-lib.sh
. "$SCRIPT_DIR/offsite-backup-lib.sh"

offsite_prepare
offsite_health_main
