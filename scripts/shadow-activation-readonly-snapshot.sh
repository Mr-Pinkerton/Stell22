#!/bin/bash
# Read-only production snapshot for SHADOW activation control.
# Uploaded by GitHub Actions and executed on the server. It does not come from
# the deployed application tree and it must not mutate anything.
set -euo pipefail

if [[ -z "${APP_DIR:-}" || -z "${EXPECTED_SHA:-}" ]]; then
  echo "SNAPSHOT_ENV_MISSING" >&2
  exit 1
fi

cd "$APP_DIR"

if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "SHA_PIN=MALFORMED" >&2
  exit 1
fi

actual_sha="$(git rev-parse HEAD)"
echo "SHADOW_CTRL PRODUCTION_APP_SHA=${actual_sha}"
if [[ "$actual_sha" != "$EXPECTED_SHA" ]]; then
  echo "SHADOW_CTRL SHA_PIN=MISMATCH"
  echo "PRODUCTION_APP_SHA_MISMATCH expected=${EXPECTED_SHA} actual=${actual_sha}" >&2
  exit 1
fi
echo "SHADOW_CTRL SHA_PIN=MATCH"

setter_paths=(
  scripts/set-inventory-movement-shadow-write.ts
  src/server/internal/inventory-movement-shadow-write.ts
  src/server/internal/inventory-movement-shadow-coordination.ts
)
if ! git diff --quiet -- "${setter_paths[@]}" || ! git diff --cached --quiet -- "${setter_paths[@]}"; then
  echo "SHADOW_CTRL SETTER_TREE=DIRTY"
  echo "SETTER_TREE_DIRTY" >&2
  exit 1
fi
echo "SHADOW_CTRL SETTER_TREE=CLEAN"

if [[ ! -f src/server/internal/inventory-movement-shadow-write.ts ]]; then
  echo "SHADOW_CTRL SETTER_SOURCE=MISSING"
  exit 1
fi
if ! grep -q "setInventoryMovementShadowWriteGate" src/server/internal/inventory-movement-shadow-write.ts; then
  echo "SHADOW_CTRL SETTER_SOURCE=MISSING"
  exit 1
fi
if ! grep -q "acquireInventoryMovementShadowControlLock" src/server/internal/inventory-movement-shadow-write.ts; then
  echo "SHADOW_CTRL SETTER_SOURCE=MISSING"
  exit 1
fi
echo "SHADOW_CTRL SETTER_SOURCE=PRESENT"

host_hash="$(sha256sum scripts/set-inventory-movement-shadow-write.ts | awk '{print $1}')"
# This script is executed by `bash -s`, so stdin is the script itself.
# Detach this command only. Do not `exec </dev/null` for the whole shell.
image_hash="$(docker compose -f docker-compose.prod.yml exec -T app \
  sha256sum scripts/set-inventory-movement-shadow-write.ts </dev/null | awk '{print $1}')"
if [[ "$host_hash" != "$image_hash" || -z "$host_hash" ]]; then
  echo "SHADOW_CTRL SETTER_SCRIPT_MATCH=NO"
  echo "SETTER_SCRIPT_MISMATCH" >&2
  exit 1
fi
echo "SHADOW_CTRL SETTER_SCRIPT_MATCH=YES"

sql="$(cat <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT 'SHADOW_SETTING=' || COALESCE((
  SELECT CASE
    WHEN s."value" IS NULL THEN 'MALFORMED'
    WHEN jsonb_typeof(s."value"::jsonb) IS DISTINCT FROM 'object' THEN 'MALFORMED'
    WHEN jsonb_typeof(s."value"::jsonb -> 'version') IS DISTINCT FROM 'number'
      OR (s."value"::jsonb ->> 'version') IS DISTINCT FROM '1' THEN 'MALFORMED'
    WHEN jsonb_typeof(s."value"::jsonb -> 'active') IS DISTINCT FROM 'boolean' THEN 'MALFORMED'
    WHEN (s."value"::jsonb ->> 'active') = 'true' THEN 'ACTIVE'
    WHEN (s."value"::jsonb ->> 'active') = 'false' THEN 'INACTIVE'
    ELSE 'MALFORMED'
  END
  FROM "Setting" s
  WHERE s."key" = 'inventory_movement_shadow_write'
), 'ABSENT');
SELECT 'COST_FLOW_SETTING=' || COALESCE((
  SELECT CASE
    WHEN s."value" IS NULL THEN 'MALFORMED'
    WHEN jsonb_typeof(s."value"::jsonb) IS DISTINCT FROM 'object' THEN 'MALFORMED'
    WHEN jsonb_typeof(s."value"::jsonb -> 'version') IS DISTINCT FROM 'number'
      OR (s."value"::jsonb ->> 'version') IS DISTINCT FROM '1' THEN 'MALFORMED'
    WHEN jsonb_typeof(s."value"::jsonb -> 'active') IS DISTINCT FROM 'boolean' THEN 'MALFORMED'
    WHEN (s."value"::jsonb ->> 'active') = 'true' THEN 'ACTIVE'
    WHEN (s."value"::jsonb ->> 'active') = 'false' THEN 'INACTIVE'
    ELSE 'MALFORMED'
  END
  FROM "Setting" s
  WHERE s."key" = 'production_cost_flow'
), 'ABSENT');
SELECT 'AUTHORITATIVE_COUNT=' || (SELECT COUNT(*)::text FROM "InventoryMovement" WHERE authority = 'AUTHORITATIVE');
SELECT 'SHADOW_COUNT=' || (SELECT COUNT(*)::text FROM "InventoryMovement" WHERE authority = 'SHADOW');
SELECT 'NONEMPTY_EPOCH_COUNT=' || (SELECT COUNT(*)::text FROM "InventoryMovement" WHERE "epochId" IS NOT NULL);
SELECT 'AUTHORITATIVE_NONEMPTY_EPOCH_COUNT=' || (SELECT COUNT(*)::text FROM "InventoryMovement" WHERE authority = 'AUTHORITATIVE' AND "epochId" IS NOT NULL);
SELECT 'INVENTORY_MOVEMENT_COUNT=' || (SELECT COUNT(*)::text FROM "InventoryMovement");
SELECT 'INVENTORY_MOVEMENT_TABLE=' || CASE
  WHEN to_regclass('public."InventoryMovement"') IS NOT NULL THEN 'EXISTS'
  ELSE 'ABSENT'
END;
SELECT 'RECORDED_AT_TYPE=' || CASE
  WHEN (
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'InventoryMovement'
      AND column_name = 'recordedAt'
  ) = 'timestamp with time zone' THEN 'TIMESTAMPTZ'
  ELSE 'OTHER'
END;
SELECT 'AUTHORITY_EPOCH_CONSTRAINT=' || CASE WHEN (
  SELECT COUNT(*) FROM pg_constraint WHERE conname = 'InventoryMovement_authority_epoch'
) = 1 THEN 'YES' ELSE 'NO' END;
SELECT 'SUPPLY_GENERATION_COLUMN=' || CASE WHEN (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'Supply'
    AND column_name = 'stockAccountingGeneration'
) = 1 THEN 'YES' ELSE 'NO' END;
SELECT 'R05_TABLE=' || CASE
  WHEN to_regclass('public."ProductionOperationCorrection"') IS NOT NULL THEN 'EXISTS'
  ELSE 'ABSENT'
END;
SELECT 'R06_INDEX=' || CASE WHEN (
  SELECT COUNT(*) FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'InventoryLine_inventoryId_refType_refId_key'
) = 1 THEN 'YES' ELSE 'NO' END;
SELECT 'RAW_TABLES=' || CASE
  WHEN to_regclass('public."BatchCreationCommand"') IS NOT NULL
   AND to_regclass('public."BatchRemainderWriteOff"') IS NOT NULL
   AND to_regclass('public."SimplePurchaseCreationCommand"') IS NOT NULL
  THEN 'YES' ELSE 'NO' END;
SELECT 'P2_TABLE=' || CASE
  WHEN to_regclass('public."ProductionOperationQuantityEdit"') IS NOT NULL THEN 'EXISTS'
  ELSE 'ABSENT'
END;
SELECT 'P2_FK_COUNT=' || (
  SELECT COUNT(*)::text
  FROM information_schema.table_constraints
  WHERE table_schema = 'public'
    AND table_name = 'ProductionOperationQuantityEdit'
    AND constraint_type = 'FOREIGN KEY'
);
SELECT 'P2_REQUEST_ID_UNIQUE=' || CASE WHEN (
  SELECT COUNT(*)
  FROM pg_namespace n
  JOIN pg_class t ON t.relnamespace = n.oid
  JOIN pg_index i ON i.indrelid = t.oid
  JOIN pg_class idx ON idx.oid = i.indexrelid
  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
  WHERE n.nspname = 'public'
    AND t.relname = 'ProductionOperationQuantityEdit'
    AND idx.relname = 'ProductionOperationQuantityEdit_requestId_key'
    AND i.indisunique
    AND i.indpred IS NULL
    AND i.indexprs IS NULL
    AND i.indnkeyatts = 1
    AND i.indnatts = 1
    AND a.attname = 'requestId'
) = 1 THEN 'YES' ELSE 'NO' END;
SELECT 'MIGRATION_20260917150000_psr_p1_inventory_movement_shadow=' || CASE WHEN (
  SELECT COUNT(*) FROM "_prisma_migrations"
  WHERE migration_name = '20260917150000_psr_p1_inventory_movement_shadow'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL
) = 1 THEN 'APPLIED' ELSE 'MISSING' END;
SELECT 'MIGRATION_20260917180000_psr_p2_inventory_movement_recorded_at_timestamptz=' || CASE WHEN (
  SELECT COUNT(*) FROM "_prisma_migrations"
  WHERE migration_name = '20260917180000_psr_p2_inventory_movement_recorded_at_timestamptz'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL
) = 1 THEN 'APPLIED' ELSE 'MISSING' END;
SELECT 'MIGRATION_20260917200000_psr_p2_r04_supply_stock_accounting_cycle=' || CASE WHEN (
  SELECT COUNT(*) FROM "_prisma_migrations"
  WHERE migration_name = '20260917200000_psr_p2_r04_supply_stock_accounting_cycle'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL
) = 1 THEN 'APPLIED' ELSE 'MISSING' END;
SELECT 'MIGRATION_20260918120000_psr_p2_r05_production_operation_correction=' || CASE WHEN (
  SELECT COUNT(*) FROM "_prisma_migrations"
  WHERE migration_name = '20260918120000_psr_p2_r05_production_operation_correction'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL
) = 1 THEN 'APPLIED' ELSE 'MISSING' END;
SELECT 'MIGRATION_20260918130000_psr_p2_r06_inventory_line_identity=' || CASE WHEN (
  SELECT COUNT(*) FROM "_prisma_migrations"
  WHERE migration_name = '20260918130000_psr_p2_r06_inventory_line_identity'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL
) = 1 THEN 'APPLIED' ELSE 'MISSING' END;
SELECT 'MIGRATION_20260920120000_psr_p2_raw_identity_prerequisite=' || CASE WHEN (
  SELECT COUNT(*) FROM "_prisma_migrations"
  WHERE migration_name = '20260920120000_psr_p2_raw_identity_prerequisite'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL
) = 1 THEN 'APPLIED' ELSE 'MISSING' END;
SELECT 'MIGRATION_20260920180000_psr_p2_production_quantity_edit_identity=' || CASE WHEN (
  SELECT COUNT(*) FROM "_prisma_migrations"
  WHERE migration_name = '20260920180000_psr_p2_production_quantity_edit_identity'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL
) = 1 THEN 'APPLIED' ELSE 'MISSING' END;
COMMIT;
SQL
)"

raw="$(printf '%s\n' "$sql" | docker compose -f docker-compose.prod.yml exec -T db \
  psql -U stell22 -d stell22 -v ON_ERROR_STOP=1 -At | tr -d '\r')"

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if [[ ! "$line" =~ ^[A-Za-z0-9_]+=[A-Za-z0-9_]+$ ]]; then
    echo "SNAPSHOT_LINE_REJECTED ${line}" >&2
    exit 1
  fi
  echo "SHADOW_CTRL ${line}"
done <<< "$raw"

echo "SHADOW_CTRL SNAPSHOT_MODE=READ_ONLY"
