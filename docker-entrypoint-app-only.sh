#!/bin/sh
# Candidate application entrypoint. Production keeps docker-entrypoint.sh.
# This script does not apply database migrations or change privileges.
set -eu

if [ -z "${DATABASE_URL:-}" ] || [ -z "${SESSION_SECRET:-}" ]; then
  echo "APP_ONLY_STARTUP CONFIGURATION_INCOMPLETE" >&2
  exit 1
fi

echo "[Stell22] app-only startup is checking schema readiness"
./node_modules/.bin/tsx src/server/internal/p1-app-only-startup/run.ts
echo "[Stell22] app-only startup is starting the server on port ${PORT:-3000}"
exec npm run start
