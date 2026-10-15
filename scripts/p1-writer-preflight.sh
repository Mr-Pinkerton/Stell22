#!/bin/sh
# Read-only P1 prerequisite for a new writer deploy.
# The decision is scripts/p1-writer-preflight.sql. This wrapper does not
# mutate the database. A correct pinned P1 exits 0. Anything else stops
# the deploy before backup, checkout, and image replacement.
set -eu
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
SQL_FILE="$SCRIPT_DIR/p1-writer-preflight.sql"
if [ ! -f "$SQL_FILE" ]; then
  echo "P1 writer prerequisite: SQL check is missing" >&2
  exit 1
fi
result="$(docker compose -f "$COMPOSE_FILE" exec -T db \
  psql -U stell22 -d stell22 -X -v ON_ERROR_STOP=1 -At -f - < "$SQL_FILE")"
result=$(printf '%s' "$result" | tr -d '[:space:]')
if [ "$result" = "P1_APPLIED" ]; then
  echo "P1 writer prerequisite: P1_APPLIED"
  exit 0
fi
echo "P1 writer prerequisite: P1 is absent or inconsistent" >&2
exit 1
