#!/bin/sh
# Accept only URL-safe role passwords. Prints nothing.
set -eu

valid() {
  case $1 in
    *[!A-Za-z0-9_-]*) return 1 ;;
  esac
  n=${#1}
  [ "$n" -ge 24 ] && [ "$n" -le 128 ]
}

valid "${APP_DB_PASSWORD:-}" && valid "${MIGRATOR_DB_PASSWORD:-}" && [ "$APP_DB_PASSWORD" != "$MIGRATOR_DB_PASSWORD" ]
