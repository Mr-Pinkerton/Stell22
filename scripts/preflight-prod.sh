#!/usr/bin/env bash
# Read-only production preflight. Exit 1 if a deployment invariant fails.
#
# Запуск из корня репозитория на проде:
#   bash scripts/preflight-prod.sh
#
# Можно передать скрипт по pipe (cwd должен быть корнем репозитория):
#   git show SHA:scripts/preflight-prod.sh | bash
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"
DB_USER="${DB_USER:-stell22}"
DB_NAME="${DB_NAME:-stell22}"

if [[ -f "$COMPOSE_FILE" ]]; then
  PROJECT_DIR="$(pwd)"
else
  PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$PROJECT_DIR"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: $COMPOSE_FILE not found in $PROJECT_DIR" >&2
  exit 1
fi

psql_q() {
  docker compose -f "$COMPOSE_FILE" exec -T db \
    psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -At -F $'\t' -c "$1"
}

echo "==> Preflight: production DB (read-only)"

if ! docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null; then
  echo "PRECHECK FAILED" >&2
  echo "PostgreSQL is not ready" >&2
  exit 1
fi

failed=0

invalid_count="$(psql_q "$(
  cat <<'SQL'
SELECT count(*)
FROM "Employee"
WHERE status = 'ACTIVE'
  AND pin !~ '^\d{4}$';
SQL
)" | tr -d '[:space:]')"

if ! [[ "$invalid_count" =~ ^[0-9]+$ ]]; then
  echo "PRECHECK FAILED" >&2
  echo "Could not read invalid PIN count" >&2
  exit 1
fi

if [[ "$invalid_count" -gt 0 ]]; then
  failed=1
  echo "Invalid ACTIVE employee PIN format (must be exactly 4 digits): ${invalid_count}" >&2
  echo "employee id / fullName (PIN not shown):" >&2
  psql_q "$(
    cat <<'SQL'
SELECT id || ' / ' || "fullName"
FROM "Employee"
WHERE status = 'ACTIVE'
  AND pin !~ '^\d{4}$'
ORDER BY "fullName", id;
SQL
  )" >&2
fi

duplicate_groups="$(psql_q "$(
  cat <<'SQL'
SELECT count(*)
FROM (
  SELECT pin
  FROM "Employee"
  WHERE status = 'ACTIVE'
    AND pin ~ '^\d{4}$'
  GROUP BY pin
  HAVING count(*) > 1
) d;
SQL
)" | tr -d '[:space:]')"

if ! [[ "$duplicate_groups" =~ ^[0-9]+$ ]]; then
  echo "PRECHECK FAILED" >&2
  echo "Could not read duplicate PIN group count" >&2
  exit 1
fi

if [[ "$duplicate_groups" -gt 0 ]]; then
  failed=1
  echo "Duplicate ACTIVE PINs (PIN masked): ${duplicate_groups} group(s)" >&2
  echo "employee id / fullName (PIN not shown):" >&2
  psql_q "$(
    cat <<'SQL'
SELECT e.id || ' / ' || e."fullName"
FROM "Employee" e
WHERE e.status = 'ACTIVE'
  AND e.pin ~ '^\d{4}$'
  AND e.pin IN (
    SELECT pin
    FROM "Employee"
    WHERE status = 'ACTIVE'
      AND pin ~ '^\d{4}$'
    GROUP BY pin
    HAVING count(*) > 1
  )
ORDER BY e."fullName", e.id;
SQL
  )" >&2
fi

if [[ "$failed" -ne 0 ]]; then
  echo "PRECHECK FAILED" >&2
  exit 1
fi

echo "PREFLIGHT OK"
exit 0
