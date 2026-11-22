#!/bin/sh
# Independent check of the latest confirmed offsite copy.
#
# Run this outside the production VPS. A check that runs on the VPS cannot
# see total loss of that VPS, so OFFSITE_EXTERNAL_LOCATION=vps is refused.
# This entry point does not restore a database and does not delete objects.
set -eu
umask 077
set +x

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
# shellcheck source=offsite-backup-lib.sh
. "$SCRIPT_DIR/offsite-backup-lib.sh"

offsite_prepare
offsite_external_main
