#!/bin/sh
# Source from the release script. Writes nothing by itself.
# Failure logs stay on the host. This file does not print them.

release_redact_file() {
  target=$1
  if [ -z "$target" ] || [ ! -f "$target" ]; then
    return 0
  fi
  tmp=$(mktemp)
  sed \
    -e 's#postgresql://[^[:space:]]*#postgresql://REDACTED#g' \
    -e 's#postgres://[^[:space:]]*#postgres://REDACTED#g' \
    -e 's#DATABASE_URL=[^[:space:]]*#DATABASE_URL=REDACTED#g' \
    -e 's#[A-Za-z0-9_]*PASSWORD=[^[:space:]]*#PASSWORD=REDACTED#g' \
    "$target" > "$tmp"
  mv "$tmp" "$target"
  chmod 600 "$target"
}

release_redact_diag() {
  if [ -z "${diag:-}" ]; then
    return 0
  fi
  release_redact_file "$diag/image-build.log"
  release_redact_file "$diag/p1-migrate.log"
  release_redact_file "$diag/app-start.log"
}
