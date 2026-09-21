#!/bin/bash
# Apply SHADOW gate ON/OFF through the already deployed maintenance CLI.
# The CLI calls setInventoryMovementShadowWriteGate under the EXCLUSIVE
# (8322,1) lock. This script does not mutate Setting by SQL, does not reset
# InventoryMovement, and does not change the separate cost-flow gate.
set -euo pipefail

if [[ -z "${APP_DIR:-}" || -z "${EXPECTED_SHA:-}" || -z "${CLI_STATE:-}" || -z "${EXPECTED_PRIOR:-}" ]]; then
  echo "APPLY_ENV_MISSING" >&2
  exit 1
fi

if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "REFUSE code=SHA_MALFORMED" >&2
  exit 1
fi

case "$CLI_STATE" in
  on|off) ;;
  *)
    echo "REFUSE code=UNSUPPORTED_ACTION" >&2
    exit 1
    ;;
esac

case "$EXPECTED_PRIOR" in
  ABSENT_OR_INACTIVE|ACTIVE) ;;
  *)
    echo "REFUSE code=UNSUPPORTED_ACTION" >&2
    exit 1
    ;;
esac

cd "$APP_DIR"

actual_sha="$(git rev-parse HEAD)"
if [[ "$actual_sha" != "$EXPECTED_SHA" ]]; then
  echo "REFUSE code=SHA_MISMATCH" >&2
  exit 1
fi

setter_paths=(
  scripts/set-inventory-movement-shadow-write.ts
  src/server/internal/inventory-movement-shadow-write.ts
  src/server/internal/inventory-movement-shadow-coordination.ts
)
if ! git diff --quiet -- "${setter_paths[@]}" || ! git diff --cached --quiet -- "${setter_paths[@]}"; then
  echo "REFUSE code=SETTER_PATH_UNVERIFIED" >&2
  exit 1
fi

# This script is executed by `bash -s`, so stdin is the script itself.
# Detach each Docker command that does not intentionally read a pipe.
# Do not `exec </dev/null` for the whole shell.
if ! docker compose -f docker-compose.prod.yml exec -T app \
  test -f node_modules/.bin/tsx </dev/null; then
  echo "REFUSE code=SETTER_PATH_UNVERIFIED" >&2
  exit 1
fi

host_hash="$(sha256sum scripts/set-inventory-movement-shadow-write.ts | awk '{print $1}')"
image_hash="$(docker compose -f docker-compose.prod.yml exec -T app \
  sha256sum scripts/set-inventory-movement-shadow-write.ts </dev/null | awk '{print $1}')"
if [[ "$host_hash" != "$image_hash" || -z "$host_hash" ]]; then
  echo "REFUSE code=SETTER_PATH_UNVERIFIED" >&2
  exit 1
fi

prior_sql="$(cat <<'SQL'
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
COMMIT;
SQL
)"

prior="$(printf '%s\n' "$prior_sql" | docker compose -f docker-compose.prod.yml exec -T db \
  psql -U stell22 -d stell22 -v ON_ERROR_STOP=1 -At | tr -d '\r' | grep -E '^SHADOW_SETTING=(ABSENT|INACTIVE|ACTIVE|MALFORMED)$' || true)"

if [[ "$prior" != "SHADOW_SETTING=ABSENT" && "$prior" != "SHADOW_SETTING=INACTIVE" && "$prior" != "SHADOW_SETTING=ACTIVE" && "$prior" != "SHADOW_SETTING=MALFORMED" ]]; then
  echo "REFUSE code=SNAPSHOT_INVALID" >&2
  exit 1
fi

state="${prior#SHADOW_SETTING=}"
if [[ "$state" == "MALFORMED" ]]; then
  echo "REFUSE code=SHADOW_MALFORMED" >&2
  exit 1
fi
if [[ "$EXPECTED_PRIOR" == "ABSENT_OR_INACTIVE" && "$state" != "ABSENT" && "$state" != "INACTIVE" ]]; then
  echo "REFUSE code=SHADOW_ALREADY_ACTIVE" >&2
  exit 1
fi
if [[ "$EXPECTED_PRIOR" == "ACTIVE" && "$state" != "ACTIVE" ]]; then
  echo "REFUSE code=SHADOW_NOT_ACTIVE" >&2
  exit 1
fi

docker compose -f docker-compose.prod.yml run --rm --no-deps \
  --entrypoint ./node_modules/.bin/tsx \
  -v "${APP_DIR}/src:/app/src:ro" \
  app \
  scripts/set-inventory-movement-shadow-write.ts \
  "--state=${CLI_STATE}" \
  --confirm=INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL \
  </dev/null

after_sha="$(git rev-parse HEAD)"
if [[ "$after_sha" != "$EXPECTED_SHA" ]]; then
  echo "REFUSE code=SHA_CHANGED" >&2
  exit 1
fi

echo "SHADOW_CONTROL_APPLY_OK state=${CLI_STATE}"
echo "PSR_P2_DUAL_WRITE_STARTED=NO"
