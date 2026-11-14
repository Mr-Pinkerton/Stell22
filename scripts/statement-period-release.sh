#!/bin/sh
# Locked entrypoint for the statement-period 47-to-48 production decision.
# A push to main does not run this script. It does not open a database,
# apply a migration, deploy, or restore.
set -eu

AUTHORIZATION_PHRASE="OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48"

if [ "${STELL22_STATEMENT_RELEASE_EXECUTE:-}" != "1" ] || [ "${STELL22_STATEMENT_RELEASE_AUTHORIZATION:-}" != "$AUTHORIZATION_PHRASE" ]; then
  printf '%s\n' \
    "RESULT=STOP_OWNER_GATE" \
    "MUTATION=NO" \
    "DATABASE_RESTORE=NO" \
    "SCHEMA_RESTORE=NO" \
    "RETRY_MIGRATION=NO" \
    "FREEZE_PASS=NO" \
    "PRODUCTION_AUTHORIZED=NO" \
    "FUTURE_PRIVILEGED_WRITES_PROVEN_IMPOSSIBLE=NO"
  exit 1
fi

cd "$(dirname "$0")/.."
exec node src/server/internal/statement-period-release/production.mjs "$@"
