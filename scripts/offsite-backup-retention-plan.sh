#!/bin/sh
# Classify retention candidates. This script never deletes.
#
# Input is a list of Moscow dates (YYYY-MM-DD) that already have a confirmed
# OFFSITE_VERIFIED marker, one date per line. Partial, unknown, and unverified
# objects are not valid input and abort the classification.
#
# Remote target: 30 newest daily copies, plus the newest remaining copy of
# each older month, up to 12 months.
# Local target: 7 newest daily copies.
# Both targets are labels only. DELETION stays SUSPENDED.
set -eu

scope=
while [ $# -gt 0 ]; do
  case "$1" in
    --scope)
      [ $# -ge 2 ] || {
        printf '%s\n' "STATUS=FAILED" "REASON=configuration"
        exit 10
      }
      scope=$2
      shift 2
      ;;
    --delete|--apply)
      printf '%s\n' "STATUS=DELETION_SUSPENDED" "REASON=retention-deletion-is-not-authorized" "DELETION=SUSPENDED"
      exit 2
      ;;
    *)
      printf '%s\n' "STATUS=FAILED" "REASON=configuration"
      exit 10
      ;;
  esac
done

case "$scope" in
  local|remote) ;;
  *)
    printf '%s\n' "STATUS=FAILED" "REASON=configuration"
    exit 10
    ;;
esac

tmp=$(mktemp "${TMPDIR:-/tmp}/stell22-retention.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"

while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  case "$line" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
    *)
      printf '%s\n' "STATUS=FAILED" "REASON=unverified-object" "DELETION=SUSPENDED"
      exit 10
      ;;
  esac
done < "$tmp"

if ! grep -q . "$tmp"; then
  printf '%s\n' "STATUS=FAILED" "REASON=configuration" "DELETION=SUSPENDED"
  exit 10
fi

printf '%s\n' "DELETION=SUSPENDED" "SCOPE=$scope" "LOCAL_TARGET=7" "REMOTE_DAILY_TARGET=30" "REMOTE_MONTHLY_TARGET=12"

sorted=$(mktemp "${TMPDIR:-/tmp}/stell22-retention-sorted.XXXXXX")
sort -u -r "$tmp" > "$sorted"

if [ "$scope" = "local" ]; then
  awk '
    { dates[++n] = $0 }
    END {
      for (i = 1; i <= n; i++) {
        if (i <= 7) print "KEEP daily " dates[i]
        else print "CANDIDATE " dates[i]
      }
    }
  ' "$sorted"
else
  awk '
    { dates[++n] = $0 }
    END {
      prev = ""
      seen = 0
      for (i = 1; i <= n; i++) {
        if (i <= 30) {
          print "KEEP daily " dates[i]
        } else {
          month = substr(dates[i], 1, 7)
          if (month != prev) {
            prev = month
            seen++
            if (seen <= 12) {
              print "KEEP monthly " dates[i]
              continue
            }
          }
          print "CANDIDATE " dates[i]
        }
      }
    }
  ' "$sorted"
fi

rm -f "$sorted"
exit 0
