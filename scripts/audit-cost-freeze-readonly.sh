#!/usr/bin/env bash
# Read-only post-deploy cost-freeze report. Never UPDATE/DELETE.
# Exit 0 even when findings exist (report, not a deploy gate).
# Preflight remains the gate for duplicate FINAL before migrate.
#
# Запуск из корня репозитория:
#   bash scripts/audit-cost-freeze-readonly.sh
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

echo "==> Cost-freeze read-only audit (no writes)"

findings=0

echo "-- 1. Frozen batches with no FINAL (may be EXPECTED: write-off, no TORCOVKA)"
rows="$(psql_q "$(
  cat <<'SQL'
SELECT b.id || ' / ' || b.name || ' / ' || b."frozenAt"::text
FROM "Batch" b
WHERE b."frozenAt" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "BatchCost" c
    WHERE c."batchId" = b.id AND c.status = 'FINAL'
  )
ORDER BY b.id;
SQL
)")"
if [[ -n "$rows" ]]; then
  findings=1
  echo "$rows"
else
  echo "(none)"
fi

echo "-- 2. Batches with more than one FINAL (must be 0 after unique)"
rows="$(psql_q "$(
  cat <<'SQL'
SELECT bc."batchId" || ' / ' || bc.id || ' / ' || bc."calculatedAt"::text || ' / ' || bc."costSort1"::text || ' / ' || bc."costSort2"::text
FROM "BatchCost" bc
WHERE bc.status = 'FINAL'
  AND bc."batchId" IN (
    SELECT "batchId"
    FROM "BatchCost"
    WHERE status = 'FINAL'
    GROUP BY 1
    HAVING COUNT(*) > 1
  )
ORDER BY bc."batchId", bc.id;
SQL
)")"
if [[ -n "$rows" ]]; then
  findings=1
  echo "$rows"
else
  echo "(none)"
fi

echo "-- 3. Frozen FINAL vs Batch.totalCost abs(diff) > 0.01 (snapshot C vs stored C; no live-line recompute)"
rows="$(psql_q "$(
  cat <<'SQL'
SELECT b.id || ' / ' || b.name || ' / ' || b."totalCost"::text || ' / ' || c."costSort1"::text || ' / ' || c."costSort2"::text || ' / ' ||
       abs((c."costSort1" + c."costSort2") - b."totalCost")::text
FROM "Batch" b
JOIN "BatchCost" c ON c."batchId" = b.id AND c.status = 'FINAL'
WHERE b."frozenAt" IS NOT NULL
  AND abs((c."costSort1" + c."costSort2") - b."totalCost") > 0.01
ORDER BY b.id;
SQL
)")"
if [[ -n "$rows" ]]; then
  findings=1
  echo "$rows"
else
  echo "(none)"
fi

echo "-- 4. Frozen batches with leftover PRELIMINARY"
rows="$(psql_q "$(
  cat <<'SQL'
SELECT b.id || ' / ' || b.name || ' / ' || c.id
FROM "Batch" b
JOIN "BatchCost" c ON c."batchId" = b.id AND c.status = 'PRELIMINARY'
WHERE b."frozenAt" IS NOT NULL
ORDER BY b.id, c.id;
SQL
)")"
if [[ -n "$rows" ]]; then
  findings=1
  echo "$rows"
else
  echo "(none)"
fi

echo "-- 5. closedAt set, frozenAt null, unpaid TORCOVKA = 0 (BD-4 leftovers)"
rows="$(psql_q "$(
  cat <<'SQL'
SELECT b.id || ' / ' || b.name || ' / ' || b."closedAt"::text
FROM "Batch" b
WHERE b."closedAt" IS NOT NULL
  AND b."frozenAt" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "ProductionOperation" o
    WHERE o."batchId" = b.id
      AND o.type = 'TORCOVKA'
      AND o."isPaid" = false
  )
ORDER BY b.id;
SQL
)")"
if [[ -n "$rows" ]]; then
  findings=1
  echo "$rows"
else
  echo "(none)"
fi

if [[ "$findings" -ne 0 ]]; then
  echo "AUDIT FINDINGS"
else
  echo "AUDIT FINDINGS: none"
fi
exit 0
