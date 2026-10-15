#!/bin/sh
# Read-only P1 prerequisite for a new writer deploy.
# Exit 0 only when the pinned P1 migration and its column, CHECK, function,
# and trigger are present. This is not a global stop: a correct P1 continues
# the existing backup, build, health, and rollback path.
set -eu
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SQL=$(cat <<'SQL'
SELECT CASE
  WHEN (
    SELECT count(*)
    FROM public."_prisma_migrations"
    WHERE migration_name = '20261010210000_psr_p3_s2_b_batch_receipt_provenance'
      AND checksum = '47ff9c932aea0a692b81ecfaf6c4a931b431e3e332e3e9c5b3fca96694550fe5'
      AND finished_at IS NOT NULL
      AND rolled_back_at IS NULL
      AND applied_steps_count = 1
  ) = 1
  AND (
    SELECT count(*)
    FROM public."_prisma_migrations"
    WHERE finished_at IS NOT NULL
      AND rolled_back_at IS NULL
      AND applied_steps_count = 1
  ) = 46
  AND (
    SELECT count(*)
    FROM public."_prisma_migrations"
    WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
  ) = 0
  AND (
    SELECT count(*)
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND a.attname = 'receiptProvenanceSnapshot'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND t.typname = 'jsonb'
      AND NOT a.attnotnull
      AND ad.adbin IS NULL
  ) = 1
  AND (
    SELECT count(*)
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND con.conname = 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
      AND con.contype = 'c'
      AND con.convalidated
  ) = 1
  AND (
    SELECT count(*)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'batch_creation_command_provenance_guard'
  ) = 1
  AND (
    SELECT count(*)
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND NOT t.tgisinternal
      AND t.tgname = 'batch_creation_command_provenance_guard'
      AND t.tgenabled = 'O'
  ) = 1
  THEN 'P1_APPLIED'
  ELSE 'P1_BLOCKED'
END;
SQL
)
result="$(docker compose -f "$COMPOSE_FILE" exec -T db \
  psql -U stell22 -d stell22 -X -v ON_ERROR_STOP=1 -At -c "$SQL")"
if [ "$result" = "P1_APPLIED" ]; then
  echo "P1 writer prerequisite: P1_APPLIED"
  exit 0
fi
echo "P1 writer prerequisite: P1 is absent or inconsistent" >&2
exit 1
