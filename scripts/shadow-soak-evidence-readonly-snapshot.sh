#!/bin/bash
# Read-only SHADOW soak evidence snapshot.
# Streamed to the server by GitHub Actions. It does not come from the deployed
# application tree and it must not mutate anything, call the gate setter, or
# declare soak complete.
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
echo "SHADOW_SOAK PRODUCTION_APP_SHA=${actual_sha}"
if [[ "$actual_sha" != "$EXPECTED_SHA" ]]; then
  echo "SHADOW_SOAK SHA_PIN=MISMATCH"
  echo "PRODUCTION_APP_SHA_MISMATCH expected=${EXPECTED_SHA} actual=${actual_sha}" >&2
  exit 1
fi
echo "SHADOW_SOAK SHA_PIN=MATCH"

format_utc() {
  local compact="$1"
  if [[ ! "$compact" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$ ]]; then
    return 1
  fi
  printf '%s-%s-%s %s:%s:%s+00' \
    "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" \
    "${BASH_REMATCH[4]}" "${BASH_REMATCH[5]}" "${BASH_REMATCH[6]}"
}

shift_start="${SHIFT_START:-}"
shift_end="${SHIFT_END:-}"
shift_active="NO"
start_sql="1970-01-01 00:00:00+00"
end_sql="1970-01-01 00:00:00+00"
start_compact="NONE"
end_compact="NONE"
if [[ -z "$shift_start" && -z "$shift_end" ]]; then
  :
elif [[ -n "$shift_start" && -n "$shift_end" ]]; then
  shift_active="YES"
  if [[ ! "$shift_start" =~ ^[0-9]{8}T[0-9]{6}Z$ || ! "$shift_end" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
    echo "REFUSE code=SHIFT_INTERVAL_INVALID" >&2
    exit 1
  fi
  if [[ "$shift_start" > "$shift_end" ]]; then
    echo "REFUSE code=SHIFT_INTERVAL_INVALID" >&2
    exit 1
  fi
  start_compact="$shift_start"
  end_compact="$shift_end"
  start_sql="$(format_utc "$shift_start")"
  end_sql="$(format_utc "$shift_end")"
else
  echo "REFUSE code=SHIFT_INTERVAL_INVALID" >&2
  exit 1
fi

sql="$(cat <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT line
FROM (
  WITH bounds AS (
    SELECT
      CASE
        WHEN :'shift_active' = 'NO' THEN NULL
        ELSE (:'shift_start_sql')::timestamptz
      END AS start_at,
      CASE
        WHEN :'shift_active' = 'NO' THEN NULL
        ELSE (:'shift_end_sql')::timestamptz + interval '999 milliseconds'
      END AS end_at,
      CASE WHEN :'shift_active' = 'NO' THEN 'NONE' ELSE :'shift_start_compact' END AS start_compact,
      CASE WHEN :'shift_active' = 'NO' THEN 'NONE' ELSE :'shift_end_compact' END AS end_compact
  ),
  movement AS (
    SELECT authority::text AS authority, "epochId" AS epoch_id
    FROM "InventoryMovement"
  ),
  shadow AS (
    SELECT
      "causationKind"::text AS causation_kind,
      "causationId" AS causation_id,
      "effectiveAt" AS effective_at,
      "recordedAt" AS recorded_at
    FROM "InventoryMovement"
    WHERE authority::text = 'SHADOW'
  ),
  direct_ops AS (
    SELECT DISTINCT p.id, p."createdAt" AS created_at, p."workDate" AS work_date
    FROM shadow m
    JOIN "ProductionOperation" p ON p.id = m.causation_id
    WHERE m.causation_kind = 'PRODUCTION_OPERATION'
  ),
  correction_ops AS (
    SELECT DISTINCT p.id, p."createdAt" AS created_at, p."workDate" AS work_date
    FROM shadow m
    JOIN "ProductionOperationCorrection" c ON c.id = m.causation_id
    JOIN "ProductionOperation" p ON p.id = c."operationId"
    WHERE m.causation_kind = 'PRODUCTION_OPERATION_MUTATION'
      AND NOT EXISTS (
        SELECT 1 FROM "ProductionOperationQuantityEdit" q WHERE q.id = m.causation_id
      )
  ),
  quantity_ops AS (
    SELECT DISTINCT p.id, p."createdAt" AS created_at, p."workDate" AS work_date
    FROM shadow m
    JOIN "ProductionOperationQuantityEdit" q ON q.id = m.causation_id
    JOIN "ProductionOperation" p ON p.id = q."operationId"
    WHERE m.causation_kind = 'PRODUCTION_OPERATION_MUTATION'
      AND NOT EXISTS (
        SELECT 1 FROM "ProductionOperationCorrection" c WHERE c.id = m.causation_id
      )
  ),
  real_ops AS (
    SELECT id, created_at, work_date FROM direct_ops
    UNION
    SELECT id, created_at, work_date FROM correction_ops
    UNION
    SELECT id, created_at, work_date FROM quantity_ops
  ),
  hours AS (
    SELECT gs AS hour_start
    FROM bounds b
    CROSS JOIN LATERAL generate_series(
      date_trunc('hour', COALESCE(b.start_at, TIMESTAMPTZ '1970-01-01 00:00:00+00') AT TIME ZONE 'UTC'),
      date_trunc('hour', COALESCE(b.end_at, TIMESTAMPTZ '1970-01-01 00:00:00+00') AT TIME ZONE 'UTC'),
      interval '1 hour'
    ) AS gs
    WHERE b.start_at IS NOT NULL
  ),
  hour_hits AS (
    SELECT h.hour_start
    FROM hours h
    JOIN bounds b ON TRUE
    WHERE EXISTS (
      SELECT 1
      FROM shadow s
      WHERE (s.recorded_at AT TIME ZONE 'UTC') >= h.hour_start
        AND (s.recorded_at AT TIME ZONE 'UTC') < h.hour_start + interval '1 hour'
        AND s.recorded_at >= b.start_at
        AND s.recorded_at <= b.end_at
    )
  ),
  delta_stats AS (
    SELECT
      COUNT(*) FILTER (WHERE delta_ms = 0) AS equal_count,
      COUNT(*) FILTER (WHERE delta_ms <> 0) AS differ_count,
      MIN(delta_ms) AS min_ms,
      MAX(delta_ms) AS max_ms
    FROM (
      SELECT round(EXTRACT(EPOCH FROM (
        s.recorded_at - (s.effective_at AT TIME ZONE 'UTC')
      )) * 1000)::bigint AS delta_ms
      FROM shadow s
    ) deltas
  ),
  day_buckets AS (
    SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYYMMDD') AS bucket, COUNT(*) AS n
    FROM shadow
    GROUP BY 1
  ),
  hour_buckets AS (
    SELECT to_char(recorded_at AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24') AS bucket, COUNT(*) AS n
    FROM shadow
    GROUP BY 1
  ),
  causation_counts AS (
    SELECT kind, COUNT(s.causation_kind) AS n
    FROM (
      VALUES
        ('PRODUCTION_OPERATION'),
        ('PRODUCTION_OPERATION_MUTATION'),
        ('INVENTORY'),
        ('SIMPLE_PURCHASE'),
        ('BATCH'),
        ('RAIL_LOT'),
        ('SUPPLY'),
        ('MANUAL'),
        ('SYSTEM')
    ) AS kinds(kind)
    LEFT JOIN shadow s ON s.causation_kind = kinds.kind
    GROUP BY kind
  )
  SELECT 10 AS ord, 'SHADOW_SETTING=' || COALESCE((
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
  ), 'ABSENT') AS line
  UNION ALL
  SELECT 20, 'COST_FLOW_SETTING=' || COALESCE((
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
  ), 'ABSENT')
  UNION ALL
  SELECT 30, 'AUTHORITATIVE_COUNT=' || (COUNT(*) FILTER (WHERE authority = 'AUTHORITATIVE'))::text FROM movement
  UNION ALL
  SELECT 40, 'NONEMPTY_EPOCH_COUNT=' || (COUNT(*) FILTER (WHERE epoch_id IS NOT NULL))::text FROM movement
  UNION ALL
  SELECT 50, 'OTHER_AUTHORITY_COUNT=' || (COUNT(*) FILTER (WHERE authority NOT IN ('SHADOW', 'AUTHORITATIVE')))::text FROM movement
  UNION ALL
  SELECT 60, 'INVENTORY_MOVEMENT_COUNT=' || COUNT(*)::text FROM movement
  UNION ALL
  SELECT 70, 'SHADOW_COUNT=' || COUNT(*)::text FROM shadow
  UNION ALL
  SELECT 80, 'MOVEMENT_TABLE=' || CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'InventoryMovement'
  ) THEN 'EXISTS' ELSE 'ABSENT' END
  UNION ALL
  SELECT 90, 'PRODUCTION_OPERATION_TABLE=' || CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ProductionOperation'
  ) THEN 'EXISTS' ELSE 'ABSENT' END
  UNION ALL
  SELECT 100, 'CORRECTION_TABLE=' || CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ProductionOperationCorrection'
  ) THEN 'EXISTS' ELSE 'ABSENT' END
  UNION ALL
  SELECT 110, 'QUANTITY_EDIT_TABLE=' || CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ProductionOperationQuantityEdit'
  ) THEN 'EXISTS' ELSE 'ABSENT' END
  UNION ALL
  SELECT 120, 'RECORDED_AT_TYPE=' || CASE WHEN (
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'InventoryMovement'
      AND column_name = 'recordedAt'
  ) = 'timestamp with time zone' THEN 'TIMESTAMPTZ' ELSE 'OTHER' END
  UNION ALL
  SELECT 130, 'EFFECTIVE_AT_TYPE=' || CASE WHEN (
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'InventoryMovement'
      AND column_name = 'effectiveAt'
  ) = 'timestamp without time zone' THEN 'TIMESTAMP' ELSE 'OTHER' END
  UNION ALL
  SELECT 140, 'SHADOW_RECORDED_AT_MIN=' || COALESCE(
    to_char(MIN(recorded_at) AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISSMS"Z"'),
    'NONE'
  ) FROM shadow
  UNION ALL
  SELECT 150, 'SHADOW_RECORDED_AT_MAX=' || COALESCE(
    to_char(MAX(recorded_at) AT TIME ZONE 'UTC', 'YYYYMMDD"T"HH24MISSMS"Z"'),
    'NONE'
  ) FROM shadow
  UNION ALL
  SELECT 160, 'SHADOW_EFFECTIVE_AT_MIN=' || COALESCE(
    to_char(MIN(effective_at), 'YYYYMMDD"T"HH24MISSMS"Z"'),
    'NONE'
  ) FROM shadow
  UNION ALL
  SELECT 170, 'SHADOW_EFFECTIVE_AT_MAX=' || COALESCE(
    to_char(MAX(effective_at), 'YYYYMMDD"T"HH24MISSMS"Z"'),
    'NONE'
  ) FROM shadow
  UNION ALL
  SELECT 180, 'RECORDED_EFFECTIVE_EQUAL_COUNT=' || equal_count::text FROM delta_stats
  UNION ALL
  SELECT 190, 'RECORDED_EFFECTIVE_DIFFER_COUNT=' || differ_count::text FROM delta_stats
  UNION ALL
  SELECT 200, 'RECORDED_MINUS_EFFECTIVE_MIN_MS=' || CASE
    WHEN (SELECT COUNT(*) FROM shadow) = 0 THEN 'NONE'
    WHEN min_ms < 0 THEN 'M' || (-min_ms)::text
    ELSE min_ms::text
  END FROM delta_stats
  UNION ALL
  SELECT 210, 'RECORDED_MINUS_EFFECTIVE_MAX_MS=' || CASE
    WHEN (SELECT COUNT(*) FROM shadow) = 0 THEN 'NONE'
    WHEN max_ms < 0 THEN 'M' || (-max_ms)::text
    ELSE max_ms::text
  END FROM delta_stats
  UNION ALL
  SELECT 220, 'CAUSATION_' || kind || '=' || n::text FROM causation_counts
  UNION ALL
  SELECT 230, 'CAUSATION_UNKNOWN=' || COUNT(*)::text
  FROM shadow
  WHERE causation_kind NOT IN (
    'PRODUCTION_OPERATION',
    'PRODUCTION_OPERATION_MUTATION',
    'INVENTORY',
    'SIMPLE_PURCHASE',
    'BATCH',
    'RAIL_LOT',
    'SUPPLY',
    'MANUAL',
    'SYSTEM'
  )
  UNION ALL
  SELECT 240, 'PRODUCTION_OPS_DIRECT=' || COUNT(*)::text FROM direct_ops
  UNION ALL
  SELECT 250, 'PRODUCTION_OPS_VIA_CORRECTION=' || COUNT(*)::text FROM correction_ops
  UNION ALL
  SELECT 260, 'PRODUCTION_OPS_VIA_QUANTITY_EDIT=' || COUNT(*)::text FROM quantity_ops
  UNION ALL
  SELECT 270, 'PRODUCTION_OPS_DISTINCT=' || COUNT(*)::text FROM real_ops
  UNION ALL
  SELECT 280, 'PRODUCTION_DIRECT_UNMATCHED=' || COUNT(*)::text
  FROM shadow m
  WHERE m.causation_kind = 'PRODUCTION_OPERATION'
    AND NOT EXISTS (SELECT 1 FROM "ProductionOperation" p WHERE p.id = m.causation_id)
  UNION ALL
  SELECT 290, 'PRODUCTION_MUTATION_UNMATCHED=' || COUNT(*)::text
  FROM shadow m
  WHERE m.causation_kind = 'PRODUCTION_OPERATION_MUTATION'
    AND NOT EXISTS (SELECT 1 FROM "ProductionOperationCorrection" c WHERE c.id = m.causation_id)
    AND NOT EXISTS (SELECT 1 FROM "ProductionOperationQuantityEdit" q WHERE q.id = m.causation_id)
  UNION ALL
  SELECT 300, 'PRODUCTION_MUTATION_AMBIGUOUS=' || COUNT(*)::text
  FROM shadow m
  WHERE m.causation_kind = 'PRODUCTION_OPERATION_MUTATION'
    AND EXISTS (SELECT 1 FROM "ProductionOperationCorrection" c WHERE c.id = m.causation_id)
    AND EXISTS (SELECT 1 FROM "ProductionOperationQuantityEdit" q WHERE q.id = m.causation_id)
  UNION ALL
  SELECT 310, 'PRODUCTION_CORRECTION_DANGLING=' || COUNT(*)::text
  FROM shadow m
  JOIN "ProductionOperationCorrection" c ON c.id = m.causation_id
  WHERE m.causation_kind = 'PRODUCTION_OPERATION_MUTATION'
    AND NOT EXISTS (SELECT 1 FROM "ProductionOperation" p WHERE p.id = c."operationId")
    AND NOT EXISTS (SELECT 1 FROM "ProductionOperationQuantityEdit" q WHERE q.id = m.causation_id)
  UNION ALL
  SELECT 320, 'PRODUCTION_QUANTITY_EDIT_DANGLING=' || COUNT(*)::text
  FROM shadow m
  JOIN "ProductionOperationQuantityEdit" q ON q.id = m.causation_id
  WHERE m.causation_kind = 'PRODUCTION_OPERATION_MUTATION'
    AND NOT EXISTS (SELECT 1 FROM "ProductionOperation" p WHERE p.id = q."operationId")
    AND NOT EXISTS (SELECT 1 FROM "ProductionOperationCorrection" c WHERE c.id = m.causation_id)
  UNION ALL
  SELECT 330, 'SHADOW_DAY_SUM=' || COALESCE(SUM(n), 0)::text FROM day_buckets
  UNION ALL
  SELECT 340, 'SHADOW_HOUR_SUM=' || COALESCE(SUM(n), 0)::text FROM hour_buckets
  UNION ALL
  SELECT 350, 'SHADOW_DAY_BUCKETS=' || COUNT(*)::text FROM day_buckets
  UNION ALL
  SELECT 360, 'SHADOW_HOUR_BUCKETS=' || COUNT(*)::text FROM hour_buckets
  UNION ALL
  SELECT 370, 'SHADOW_DAY_' || bucket || '=' || n::text FROM day_buckets
  UNION ALL
  SELECT 380, 'SHADOW_HOUR_' || bucket || '=' || n::text FROM hour_buckets
  UNION ALL
  SELECT 390, 'SHIFT_INTERVAL=' || CASE WHEN start_at IS NULL THEN 'ABSENT' ELSE 'PRESENT' END FROM bounds
  UNION ALL
  SELECT 400, 'SHIFT_START=' || start_compact FROM bounds
  UNION ALL
  SELECT 410, 'SHIFT_END=' || end_compact FROM bounds
  UNION ALL
  SELECT 420, 'SHIFT_SHADOW_ROWS=' || CASE
    WHEN (SELECT start_at FROM bounds) IS NULL THEN 'NONE'
    ELSE (
      SELECT COUNT(*)::text
      FROM shadow s
      JOIN bounds b ON s.recorded_at >= b.start_at AND s.recorded_at <= b.end_at
    )
  END
  UNION ALL
  SELECT 430, 'SHIFT_SHADOW_OUTSIDE_ROWS=' || CASE
    WHEN (SELECT start_at FROM bounds) IS NULL THEN 'NONE'
    ELSE (
      (SELECT COUNT(*) FROM shadow) - (
        SELECT COUNT(*)
        FROM shadow s
        JOIN bounds b ON s.recorded_at >= b.start_at AND s.recorded_at <= b.end_at
      )
    )::text
  END
  UNION ALL
  SELECT 440, 'SHIFT_HOURS=' || CASE
    WHEN (SELECT start_at FROM bounds) IS NULL THEN 'NONE'
    ELSE (SELECT COUNT(*)::text FROM hours)
  END
  UNION ALL
  SELECT 450, 'SHIFT_HOURS_WITH_SHADOW=' || CASE
    WHEN (SELECT start_at FROM bounds) IS NULL THEN 'NONE'
    ELSE (SELECT COUNT(*)::text FROM hour_hits)
  END
  UNION ALL
  SELECT 460, 'SHIFT_HOURS_WITHOUT_SHADOW=' || CASE
    WHEN (SELECT start_at FROM bounds) IS NULL THEN 'NONE'
    ELSE ((SELECT COUNT(*) FROM hours) - (SELECT COUNT(*) FROM hour_hits))::text
  END
  UNION ALL
  SELECT 470, 'SHIFT_PRODUCTION_CREATED_OPS=' || CASE
    WHEN (SELECT start_at FROM bounds) IS NULL THEN 'NONE'
    ELSE (
      SELECT COUNT(*)::text
      FROM real_ops p
      JOIN bounds b ON (p.created_at AT TIME ZONE 'UTC') >= b.start_at
        AND (p.created_at AT TIME ZONE 'UTC') <= b.end_at
    )
  END
  UNION ALL
  SELECT 480, 'SHIFT_WORKDATE_OPS=' || CASE
    WHEN (SELECT start_at FROM bounds) IS NULL THEN 'NONE'
    ELSE (
      SELECT COUNT(*)::text
      FROM real_ops p
      JOIN bounds b ON (p.work_date AT TIME ZONE 'UTC') >= b.start_at
        AND (p.work_date AT TIME ZONE 'UTC') <= b.end_at
    )
  END
) soaked
ORDER BY ord, line;
COMMIT;
SQL
)"

# -X -q: ignore psqlrc and omit command tags. Query rows stay unaligned and tuples-only.
raw="$(printf '%s\n' "$sql" | docker compose -f docker-compose.prod.yml exec -T db \
  psql -X -q -U stell22 -d stell22 -v ON_ERROR_STOP=1 \
  -v shift_active="$shift_active" \
  -v shift_start_sql="$start_sql" \
  -v shift_end_sql="$end_sql" \
  -v shift_start_compact="$start_compact" \
  -v shift_end_compact="$end_compact" \
  -At | tr -d '\r')"

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if [[ ! "$line" =~ ^[A-Za-z0-9_]+=[A-Za-z0-9_]+$ ]]; then
    echo "SNAPSHOT_LINE_REJECTED" >&2
    exit 1
  fi
  echo "SHADOW_SOAK ${line}"
done <<< "$raw"

echo "SHADOW_SOAK SNAPSHOT_MODE=READ_ONLY"
