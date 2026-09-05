#!/usr/bin/env bash
# Read-only production preflight. Exit 1 if a deployment invariant fails.
#
# Запуск из корня репозитория на проде:
#   bash scripts/preflight-prod.sh
#
# Из CI (до checkout): orchestrator материализует этот файл из EXPECTED_SHA
# во временный каталог и запускает из текущего cwd (working tree не меняется).
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

# --- DI-003: duplicate Account.accountNumber ---
dup_account_n="$(psql_q "$(
  cat <<'SQL'
SELECT count(*)
FROM "Account" a
WHERE a."accountNumber" IS NOT NULL
  AND a."accountNumber" IN (
    SELECT "accountNumber"
    FROM "Account"
    WHERE "accountNumber" IS NOT NULL
    GROUP BY 1
    HAVING COUNT(*) > 1
  );
SQL
)" | tr -d '[:space:]')"

if ! [[ "$dup_account_n" =~ ^[0-9]+$ ]]; then
  echo "PRECHECK FAILED" >&2
  echo "Could not read duplicate Account.accountNumber count" >&2
  exit 1
fi

if [[ "$dup_account_n" -gt 0 ]]; then
  failed=1
  echo "DI-003: duplicate Account.accountNumber: ${dup_account_n} row(s). STOP. Do not migrate/merge/delete." >&2
  echo "id / name / accountNumber / confirmed / bik / cashflow_n / statement_n:" >&2
  psql_q "$(
    cat <<'SQL'
SELECT a.id || ' / ' || a.name || ' / ' || a."accountNumber" || ' / ' || a.confirmed::text || ' / ' || coalesce(a.bik, '') || ' / ' ||
       (SELECT COUNT(*) FROM "CashFlow" cf WHERE cf."accountId" = a.id)::text || ' / ' ||
       (SELECT COUNT(*) FROM "Statement" s WHERE s."accountId" = a.id)::text
FROM "Account" a
WHERE a."accountNumber" IS NOT NULL
  AND a."accountNumber" IN (
    SELECT "accountNumber"
    FROM "Account"
    WHERE "accountNumber" IS NOT NULL
    GROUP BY 1
    HAVING COUNT(*) > 1
  )
ORDER BY a."accountNumber", a.id;
SQL
  )" >&2
fi

# --- DI-003: duplicate CashFlow (accountId, importKey) ---
dup_importkey_groups="$(psql_q "$(
  cat <<'SQL'
SELECT count(*)
FROM (
  SELECT "accountId", "importKey"
  FROM "CashFlow"
  WHERE "importKey" IS NOT NULL
  GROUP BY "accountId", "importKey"
  HAVING COUNT(*) > 1
) d;
SQL
)" | tr -d '[:space:]')"

if ! [[ "$dup_importkey_groups" =~ ^[0-9]+$ ]]; then
  echo "PRECHECK FAILED" >&2
  echo "Could not read duplicate CashFlow importKey group count" >&2
  exit 1
fi

if [[ "$dup_importkey_groups" -gt 0 ]]; then
  failed=1
  echo "DI-003: duplicate CashFlow (accountId, importKey): ${dup_importkey_groups} group(s). STOP. Do not migrate/fix automatically." >&2
  echo "id / accountId / importKey / date / amount / statementId / description:" >&2
  psql_q "$(
    cat <<'SQL'
SELECT cf.id || ' / ' || cf."accountId" || ' / ' || cf."importKey" || ' / ' || cf.date::text || ' / ' || cf.amount::text || ' / ' || coalesce(cf."statementId", '') || ' / ' || coalesce(cf.description, '')
FROM "CashFlow" cf
WHERE (cf."accountId", cf."importKey") IN (
  SELECT "accountId", "importKey"
  FROM "CashFlow"
  WHERE "importKey" IS NOT NULL
  GROUP BY 1, 2
  HAVING COUNT(*) > 1
)
ORDER BY cf."accountId", cf."importKey", cf.id;
SQL
  )" >&2
fi

# --- DI-010: duplicate ACTIVE marketplace SKUs ---
dup_sku_ozon_groups="$(psql_q "$(
  cat <<'SQL'
SELECT count(*)
FROM (
  SELECT "skuOzon"
  FROM "Product"
  WHERE status = 'ACTIVE'
  GROUP BY 1
  HAVING COUNT(*) > 1
) d;
SQL
)" | tr -d '[:space:]')"

dup_sku_wb_groups="$(psql_q "$(
  cat <<'SQL'
SELECT count(*)
FROM (
  SELECT "skuWb"
  FROM "Product"
  WHERE status = 'ACTIVE'
  GROUP BY 1
  HAVING COUNT(*) > 1
) d;
SQL
)" | tr -d '[:space:]')"

if ! [[ "$dup_sku_ozon_groups" =~ ^[0-9]+$ && "$dup_sku_wb_groups" =~ ^[0-9]+$ ]]; then
  echo "PRECHECK FAILED" >&2
  echo "Could not read duplicate ACTIVE SKU group counts" >&2
  exit 1
fi

if [[ "$dup_sku_ozon_groups" -gt 0 || "$dup_sku_wb_groups" -gt 0 ]]; then
  failed=1
  echo "DI-010: duplicate ACTIVE SKU. Ozon groups=${dup_sku_ozon_groups} WB groups=${dup_sku_wb_groups}. STOP. Do not migrate/rename/archive/merge." >&2
  echo "id / name / status / skuOzon / skuWb:" >&2
  psql_q "$(
    cat <<'SQL'
SELECT p.id || ' / ' || p.name || ' / ' || p.status || ' / ' || p."skuOzon" || ' / ' || p."skuWb"
FROM "Product" p
WHERE p.status = 'ACTIVE'
  AND (
    p."skuOzon" IN (
      SELECT "skuOzon" FROM "Product" WHERE status = 'ACTIVE' GROUP BY 1 HAVING COUNT(*) > 1
    )
    OR p."skuWb" IN (
      SELECT "skuWb" FROM "Product" WHERE status = 'ACTIVE' GROUP BY 1 HAVING COUNT(*) > 1
    )
  )
ORDER BY p."skuOzon", p."skuWb", p.id;
SQL
  )" >&2
fi

# --- DI-005: duplicate BatchCost FINAL per batch ---
dup_final_groups="$(psql_q "$(
  cat <<'SQL'
SELECT count(*)
FROM (
  SELECT "batchId"
  FROM "BatchCost"
  WHERE status = 'FINAL'
  GROUP BY 1
  HAVING COUNT(*) > 1
) d;
SQL
)" | tr -d '[:space:]')"

if ! [[ "$dup_final_groups" =~ ^[0-9]+$ ]]; then
  echo "PRECHECK FAILED" >&2
  echo "Could not read duplicate BatchCost FINAL group count" >&2
  exit 1
fi

if [[ "$dup_final_groups" -gt 0 ]]; then
  failed=1
  echo "DI-005: duplicate BatchCost FINAL: ${dup_final_groups} group(s). STOP. Do not migrate/delete/merge." >&2
  echo "batchId / BatchCost.id / calculatedAt / costSort1 / costSort2:" >&2
  psql_q "$(
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
  )" >&2
fi

# --- DI-016: more than one DRAFT inventory ---
draft_n="$(psql_q "$(
  cat <<'SQL'
SELECT count(*) FROM "Inventory" WHERE status = 'DRAFT';
SQL
)" | tr -d '[:space:]')"

if ! [[ "$draft_n" =~ ^[0-9]+$ ]]; then
  echo "PRECHECK FAILED" >&2
  echo "Could not read DRAFT inventory count" >&2
  exit 1
fi

if [[ "$draft_n" -gt 1 ]]; then
  failed=1
  echo "DI-016: ${draft_n} DRAFT inventories (expected <= 1). STOP. Do not migrate/delete/conduct." >&2
  echo "id / status / createdAt / date / line count:" >&2
  psql_q "$(
    cat <<'SQL'
SELECT i.id || ' / ' || i.status || ' / ' || i."createdAt"::text || ' / ' || i.date::text || ' / ' ||
       (SELECT COUNT(*) FROM "InventoryLine" l WHERE l."inventoryId" = i.id)::text
FROM "Inventory" i
WHERE i.status = 'DRAFT'
ORDER BY i."createdAt", i.id;
SQL
  )" >&2
fi

# --- DI-008: NULL ProductionOperation.clientRequestId ---
null_req_n="$(psql_q "$(
  cat <<'SQL'
SELECT count(*) FROM "ProductionOperation" WHERE "clientRequestId" IS NULL;
SQL
)" | tr -d '[:space:]')"

if ! [[ "$null_req_n" =~ ^[0-9]+$ ]]; then
  echo "PRECHECK FAILED" >&2
  echo "Could not read NULL clientRequestId count" >&2
  exit 1
fi

if [[ "$null_req_n" -gt 0 ]]; then
  failed=1
  echo "DI-008: ${null_req_n} ProductionOperation row(s) have NULL clientRequestId. STOP. Do not migrate/backfill/delete." >&2
  echo "id / type / employeeId / workDate / createdAt:" >&2
  psql_q "$(
    cat <<'SQL'
SELECT id || ' / ' || type || ' / ' || "employeeId" || ' / ' || "workDate"::text || ' / ' || "createdAt"::text
FROM "ProductionOperation"
WHERE "clientRequestId" IS NULL
ORDER BY "createdAt", id;
SQL
  )" >&2
fi

if [[ "$failed" -ne 0 ]]; then
  echo "PRECHECK FAILED" >&2
  exit 1
fi

echo "PREFLIGHT OK"
exit 0
