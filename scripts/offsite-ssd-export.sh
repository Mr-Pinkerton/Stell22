#!/bin/sh
# Copy already verified offsite objects onto a directory supplied by the operator.
#
# The directory is the mount an independent computer gives this script for a
# removable SSD that stays in Russia. This script does not mount hardware,
# does not keep an age private key, and does not delete or overwrite a
# different existing file.
set -eu
umask 077
set +x

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
# shellcheck source=offsite-backup-lib.sh
. "$SCRIPT_DIR/offsite-backup-lib.sh"

if [ -n "${AGE_SECRET_KEY:-}" ] || [ -n "${OFFSITE_AGE_IDENTITY:-}" ]; then
  printf '%s\n' "STATUS=FAILED" "REASON=private-key-refused" "RESTORE_VERIFIED=0"
  exit 10
fi

offsite_prepare

_root=${OFFSITE_SSD_ROOT:-}
case "$_root" in
  ""|/|.)
    offsite_die FAILED configuration 10
    ;;
esac
_dates=${OFFSITE_SSD_DATES:-}
case "$_dates" in
  "")
    offsite_die FAILED configuration 10
    ;;
esac

offsite_ssd_place() {
  _ssd_key=$1
  _ssd_path=$2
  _ssd_expect=$3
  _ssd_dir=$(dirname "$_ssd_path")
  mkdir -p "$_ssd_dir" || offsite_die FAILED configuration 10
  _ssd_tmp=$(mktemp "$_ssd_dir/.stell22-ssd.XXXXXX")
  if offsite_s3_get "$_ssd_key" "$_ssd_tmp"; then
    _ssd_get=0
  else
    _ssd_get=$?
  fi
  set -e
  if [ "$_ssd_get" -ne 0 ]; then
    rm -f "$_ssd_tmp"
    offsite_die FAILED remote-get-failure 20
  fi
  _ssd_got=$(offsite_sha256 "$_ssd_tmp")
  if [ -n "$_ssd_expect" ] && [ "$_ssd_got" != "$_ssd_expect" ]; then
    rm -f "$_ssd_tmp"
    offsite_die FAILED remote-checksum-mismatch 21
  fi
  if [ -h "$_ssd_path" ]; then
    rm -f "$_ssd_tmp"
    offsite_die FAILED destination-mismatch 21
  fi
  if [ -e "$_ssd_path" ]; then
    if [ ! -f "$_ssd_path" ]; then
      rm -f "$_ssd_tmp"
      offsite_die FAILED destination-mismatch 21
    fi
    _ssd_have=$(offsite_sha256 "$_ssd_path")
    rm -f "$_ssd_tmp"
    if [ "$_ssd_have" != "$_ssd_got" ]; then
      offsite_die FAILED destination-mismatch 21
    fi
    return 0
  fi
  if ln "$_ssd_tmp" "$_ssd_path" 2>/dev/null; then
    rm -f "$_ssd_tmp"
  else
    rm -f "$_ssd_tmp"
    if [ -h "$_ssd_path" ]; then
      offsite_die FAILED destination-mismatch 21
    fi
    if [ -f "$_ssd_path" ]; then
      _ssd_have=$(offsite_sha256 "$_ssd_path")
      if [ "$_ssd_have" = "$_ssd_got" ]; then
        return 0
      fi
      offsite_die FAILED destination-mismatch 21
    fi
    offsite_die FAILED configuration 10
  fi
  chmod 600 "$_ssd_path" || offsite_die FAILED configuration 10
}

_missing=0
for _date in $_dates; do
  case "$_date" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *) offsite_die FAILED configuration 10 ;;
  esac
  if offsite_verify_remote_success "$_date"; then
    _rc=0
  else
    _rc=$?
  fi
  set -e
  if [ "$_rc" -ne 0 ]; then
    _missing=1
    continue
  fi
  _day="$_root/daily/$_date"
  mkdir -p "$_day"
  offsite_ssd_place "$(offsite_archive_key "$_date")" "$_day/archive.age" "$VERIFIED_CIPHER_SHA"
  offsite_ssd_place "$(offsite_manifest_key "$_date")" "$_day/manifest.json" "$VERIFIED_MANIFEST_SHA"
  offsite_ssd_place "$(offsite_success_key "$_date")" "$_day/SUCCESS" "$VERIFIED_MARKER_SHA"
done

if [ "$_missing" -ne 0 ]; then
  offsite_die FAILED incomplete-set 31
fi
printf '%s\n' "STATUS=SSD_COPIED" "RESTORE_VERIFIED=0"
exit 0
