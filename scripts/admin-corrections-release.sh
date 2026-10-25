#!/bin/sh
# ADMIN-CORRECTIONS-01 release operator.
# Manual owner gate only. A push to main does not run this script.
# One pending migration is applied once as stell22_migrator.
# The script never restores a database and never retries an attempted migration.
# Before the migration is attempted, an unchanged schema may restart the
# previous application container with docker start. It does not compose up
# the new image for that recovery.
set -eu
umask 077

AUTHORIZATION_PHRASE="OWNER_AUTHORIZES_ADMIN_CORRECTIONS_01_RELEASE"
MIGRATION_NAME="20261025120000_admin_corrections_batch_and_cancel"
MIGRATION_SHA256="d8d83b48d536bd42cb9f394958dc981003d43da5b5904bcecadd3899b179f834"
DECIDE="src/server/internal/admin-corrections-release/decide.mjs"
COMPOSE_FILE="docker-compose.prod.yml"
INSPECT_APP="stell22-ac-inspect"

cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./scripts/release-diagnostics.sh

work=""
diag=""
db_container="stell22-db-prod"
app_container="stell22-app"
caddy_container="stell22-caddy"
database="stell22"
inspect_user="stell22"
hold_tag="stell22-ac-legacy:hold"
disposable=0
phase="${STELL22_AC_PHASE:-production}"
history_unchanged=0
schema_unchanged=0
migration_attempted=0
old_image_app_only=0
app_stopped=0
db_id_before=""
caddy_id_before=""
legacy_image=""
app_image=""

if [ "${STELL22_ADMIN_CORRECTIONS_DISPOSABLE:-}" = "1" ]; then
  disposable=1
  database="${STELL22_AC_DATABASE:-}"
  db_container="${STELL22_AC_DB_CONTAINER:-}"
  app_container="${STELL22_AC_APP_CONTAINER:-acrel-app-00000000}"
  caddy_container="${STELL22_AC_CADDY_CONTAINER:-acrel-caddy-00000000}"
  inspect_user="${STELL22_AC_INSPECT_USER:-}"
  hold_tag="acrel-legacy-${STELL22_AC_DATABASE#acrel_}:hold"
fi

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
  unset DATABASE_URL || true
}
on_signal() {
  trap '' HUP INT TERM
  echo "RESULT=STOP_SIGNAL" >&2
  echo "DATABASE_RESTORE=NO" >&2
  echo "RETRY_MIGRATION=NO" >&2
  echo "OLD_IMAGE_RESTART=NO" >&2
  release_redact_diag
  exit 1
}
trap on_signal HUP INT TERM
trap cleanup EXIT

refuse() {
  echo "RESULT=$1"
  echo "DATABASE_RESTORE=NO"
  echo "RETRY_MIGRATION=NO"
  echo "OLD_IMAGE_RESTART=NO"
  exit 1
}

require_absent() {
  if [ -n "${1:-}" ]; then
    refuse STOP_LOCKED
  fi
}

if [ "$disposable" != 1 ]; then
  require_absent "${STELL22_AC_FACTS_DIR:-}"
  require_absent "${STELL22_AC_SCHEMA_DIR:-}"
  require_absent "${STELL22_AC_BACKUP_BIN:-}"
  require_absent "${STELL22_AC_URL_FILE:-}"
  require_absent "${STELL22_AC_BUILD_EXIT:-}"
  require_absent "${STELL22_AC_MIGRATE_EXIT:-}"
  require_absent "${STELL22_AC_APP_EXIT:-}"
  require_absent "${STELL22_AC_CHECKSUM_OK:-}"
  require_absent "${STELL22_AC_ORIGIN_MAIN:-}"
  require_absent "${STELL22_AC_HEAD:-}"
  if [ "$phase" != "production" ]; then
    refuse STOP_LOCKED
  fi
else
  case "$phase" in
    migrate-only|fixture) ;;
    *) refuse STOP_LOCKED ;;
  esac
fi

work="$(mktemp -d)"
cat > "$work/lock.env" <<EOF
execute=${STELL22_ADMIN_CORRECTIONS_EXECUTE:-}
maintenance=${STELL22_ADMIN_CORRECTIONS_MAINTENANCE:-}
authorization=${STELL22_ADMIN_CORRECTIONS_AUTHORIZATION:-}
restore=${STELL22_ADMIN_CORRECTIONS_RESTORE:-}
ci=${STELL22_ADMIN_CORRECTIONS_CI:-}
EOF
if ! node "$DECIDE" lock "$work/lock.env" > "$work/lock.out"; then
  code=$(awk -F= '$1 == "CODE" { print $2; exit }' "$work/lock.out" 2>/dev/null || true)
  if [ -z "$code" ]; then
    code=STOP_OWNER_GATE
  fi
  refuse "$code"
fi

if [ "$disposable" = 1 ]; then
  cat > "$work/identity.env" <<EOF
database=$database
dbContainer=$db_container
appContainer=$app_container
inspectUser=$inspect_user
EOF
  if ! node "$DECIDE" identity "$work/identity.env" >/dev/null; then
    refuse STOP_LOCKED
  fi
fi

sha="${STELL22_ADMIN_CORRECTIONS_SHA:-}"
if [ "$phase" = "production" ]; then
  if ! git fetch origin main; then
    refuse STOP_CHECKOUT
  fi
  origin_main="$(git rev-parse origin/main)"
  if ! git cat-file -e "${sha}^{commit}"; then
    refuse STOP_CHECKOUT
  fi
  sh scripts/release-checkout.sh "$sha" > "$work/checkout.out"
  head="$(git rev-parse HEAD)"
else
  origin_main="${STELL22_AC_ORIGIN_MAIN:-$sha}"
  head="${STELL22_AC_HEAD:-$sha}"
fi
cat > "$work/sha.env" <<EOF
sha=$sha
originMain=$origin_main
head=$head
ci=${STELL22_ADMIN_CORRECTIONS_CI:-}
EOF
if ! node "$DECIDE" sha "$work/sha.env" > "$work/sha.out"; then
  refuse STOP_CHECKOUT
fi

blob_sha=$(git cat-file blob "HEAD:prisma/migrations/${MIGRATION_NAME}/migration.sql" | sha256sum | awk 'NR == 1 { print $1; exit }')
if [ "$blob_sha" != "$MIGRATION_SHA256" ]; then
  refuse STOP_CHECKSUM
fi

# RESTART_OLD_IMAGE_BEGIN
restart_old_image() {
  docker start "$app_container" >/dev/null
}
# RESTART_OLD_IMAGE_END

finish() {
  stage=$1
  code=$2
  cat > "$work/recovery.env" <<EOF
stage=$stage
historyUnchanged=$history_unchanged
schemaUnchanged=$schema_unchanged
migrationAttempted=$migration_attempted
oldImageAppOnly=$old_image_app_only
EOF
  action=$(node "$DECIDE" recovery "$work/recovery.env" | awk -F= '$1 == "ACTION" { print $2; exit }')
  echo "RESULT=$code"
  echo "DATABASE_RESTORE=NO"
  echo "RETRY_MIGRATION=NO"
  case "$action" in
    restart-old)
      if [ "$app_stopped" != 1 ] || [ "$migration_attempted" = 1 ]; then
        echo "OLD_IMAGE_RESTART=NO"
        echo "RESULT=STOP_OLD_RESTART"
        exit 1
      fi
      if ! restart_old_image; then
        echo "OLD_IMAGE_RESTART=NO"
        echo "RESULT=STOP_OLD_RESTART"
        exit 1
      fi
      echo "OLD_IMAGE_RESTART=YES"
      ;;
    none)
      echo "OLD_IMAGE_RESTART=NO"
      if [ "$stage" = "before-stop" ]; then
        echo "APP_UNCHANGED=YES"
      fi
      ;;
    *)
      echo "OLD_IMAGE_RESTART=NO"
      echo "FORWARD_RECOVERY=YES"
      ;;
  esac
  exit 1
}

note_processes() {
  backup_running=0
  import_running=0
  migrate_process=0
  conflicting=0
  ps -eo args > "$work/processes.txt" 2>/dev/null || ps > "$work/processes.txt" || return 1
  while IFS= read -r line; do
    case "$line" in
      *grep*|*admin-corrections-release-decide*|*decide.mjs*) continue ;;
    esac
    case "$line" in
      *backup-db.sh*|*pg_dump*) backup_running=1 ;;
    esac
    case "$line" in
      *fetch-statements*) import_running=1 ;;
    esac
    case "$line" in
      *"prisma migrate"*) migrate_process=1 ;;
    esac
    case "$line" in
      *scripts/deploy.sh*|*release-role-split.sh*|*ci-prod-remote.sh*) conflicting=1 ;;
    esac
  done < "$work/processes.txt"
}

run_sql() {
  sql_file=$1
  if [ "$phase" = "fixture" ]; then
    return 0
  fi
  docker exec -i -e PGAPPNAME="$INSPECT_APP" -e PGPASSWORD="${STELL22_AC_INSPECT_PASSWORD:-}" "$db_container" \
    psql -X -U "$inspect_user" -d "$database" -q -v ON_ERROR_STOP=1 -At -f - < "$sql_file"
}

write_history() {
  out=$1
  if [ "$phase" = "fixture" ]; then
    cp "$STELL22_AC_FACTS_DIR/history.txt" "$out"
    return 0
  fi
  cat > "$work/history.sql" <<'SQL'
SELECT migration_name || '|' || checksum || '|' || (finished_at IS NOT NULL)::text || '|' || (rolled_back_at IS NOT NULL)::text || '|' || applied_steps_count::text
FROM public."_prisma_migrations"
ORDER BY migration_name
SQL
  run_sql "$work/history.sql" > "$out"
}

write_privilege_facts() {
  out=$1
  if [ "$phase" = "fixture" ]; then
    cp "$STELL22_AC_FACTS_DIR/privileges.env" "$out"
    return 0
  fi
  cat > "$work/privileges.sql" <<'SQL'
SELECT 'serverVersionNum=' || current_setting('server_version_num')
UNION ALL
SELECT 'migratorLogin=' || EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stell22_migrator' AND rolcanlogin AND NOT rolsuper)::text
UNION ALL
SELECT 'migratorSuper=' || COALESCE((SELECT rolsuper::text FROM pg_roles WHERE rolname = 'stell22_migrator'), 'true')
UNION ALL
SELECT 'migratorCreate=' || CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stell22_migrator') THEN has_schema_privilege('stell22_migrator', 'public', 'CREATE')::text ELSE 'false' END
UNION ALL
SELECT 'migratorOwnsAlteredTable=' || EXISTS (
  SELECT 1 FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'ProductionOperation' AND pg_catalog.pg_get_userbyid(c.relowner) = 'stell22_migrator'
)::text
UNION ALL
SELECT 'migratorOperationTypeUsage=' || CASE
  WHEN to_regtype('public."OperationType"') IS NULL THEN 'false'
  WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stell22_migrator') THEN 'false'
  ELSE has_type_privilege('stell22_migrator', to_regtype('public."OperationType"'), 'USAGE')::text
END
UNION ALL
SELECT 'appOperationTypeUsage=' || CASE
  WHEN to_regtype('public."OperationType"') IS NULL THEN 'false'
  WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stell22_app') THEN 'false'
  ELSE has_type_privilege('stell22_app', to_regtype('public."OperationType"'), 'USAGE')::text
END
UNION ALL
SELECT 'appLogin=' || EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stell22_app' AND rolcanlogin AND NOT rolsuper)::text
UNION ALL
SELECT 'appSuper=' || COALESCE((SELECT rolsuper::text FROM pg_roles WHERE rolname = 'stell22_app'), 'true')
UNION ALL
SELECT 'defaultPrivileges=' || CASE WHEN EXISTS (
  SELECT 1
  FROM pg_default_acl d
  JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
  JOIN pg_roles grantee ON grantee.oid = acl.grantee
  WHERE owner_role.rolname = 'stell22_migrator'
    AND n.nspname = 'public'
    AND d.defaclobjtype = 'r'
    AND grantee.rolname = 'stell22_app'
    AND acl.privilege_type = 'INSERT'
) AND EXISTS (
  SELECT 1
  FROM pg_default_acl d
  JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
  JOIN pg_roles grantee ON grantee.oid = acl.grantee
  WHERE owner_role.rolname = 'stell22_migrator'
    AND n.nspname = 'public'
    AND d.defaclobjtype = 'r'
    AND grantee.rolname = 'stell22_app'
    AND acl.privilege_type = 'SELECT'
) AND EXISTS (
  SELECT 1
  FROM pg_default_acl d
  JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
  JOIN pg_roles grantee ON grantee.oid = acl.grantee
  WHERE owner_role.rolname = 'stell22_migrator'
    AND n.nspname = 'public'
    AND d.defaclobjtype = 'r'
    AND grantee.rolname = 'stell22_app'
    AND acl.privilege_type = 'UPDATE'
) AND EXISTS (
  SELECT 1
  FROM pg_default_acl d
  JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
  JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) AS acl
  JOIN pg_roles grantee ON grantee.oid = acl.grantee
  WHERE owner_role.rolname = 'stell22_migrator'
    AND n.nspname = 'public'
    AND d.defaclobjtype = 'r'
    AND grantee.rolname = 'stell22_app'
    AND acl.privilege_type = 'DELETE'
) THEN 'true' ELSE 'false' END
SQL
  run_sql "$work/privileges.sql" > "$out"
}

write_object_facts() {
  out=$1
  if [ "$phase" = "fixture" ]; then
    cp "$STELL22_AC_FACTS_DIR/objects.env" "$out"
    return 0
  fi
  cat > "$work/objects.sql" <<'SQL'
SELECT 'batchPackageEdit=' || (to_regclass('public."BatchPackageEditCommand"') IS NOT NULL)::text
UNION ALL
SELECT 'productionOperationCancellation=' || (to_regclass('public."ProductionOperationCancellation"') IS NOT NULL)::text
UNION ALL
SELECT 'cancelledAtNullable=' || COALESCE((
  SELECT CASE WHEN a.attnotnull THEN 'false' ELSE 'true' END
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'ProductionOperation' AND a.attname = 'cancelledAt' AND a.attnum > 0 AND NOT a.attisdropped
), 'false')
UNION ALL
SELECT 'indexProductionOperationCancelledAt=' || EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ProductionOperation_cancelledAt_idx')::text
UNION ALL
SELECT 'indexBatchRequest=' || EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'BatchPackageEditCommand_requestId_key')::text
UNION ALL
SELECT 'indexBatchBatchRecorded=' || EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'BatchPackageEditCommand_batchId_recordedAt_idx')::text
UNION ALL
SELECT 'indexCancelRequest=' || EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ProductionOperationCancellation_requestId_key')::text
UNION ALL
SELECT 'indexCancelOperation=' || EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ProductionOperationCancellation_operationId_key')::text
UNION ALL
SELECT 'indexCancelOperationRecorded=' || EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ProductionOperationCancellation_operationId_recordedAt_idx')::text
UNION ALL
SELECT 'appTablePrivileges=' || CASE
  WHEN to_regclass('public."BatchPackageEditCommand"') IS NULL OR to_regclass('public."ProductionOperationCancellation"') IS NULL THEN 'false'
  WHEN has_table_privilege('stell22_app', 'public."BatchPackageEditCommand"', 'SELECT')
    AND has_table_privilege('stell22_app', 'public."BatchPackageEditCommand"', 'INSERT')
    AND has_table_privilege('stell22_app', 'public."BatchPackageEditCommand"', 'UPDATE')
    AND has_table_privilege('stell22_app', 'public."BatchPackageEditCommand"', 'DELETE')
    AND has_table_privilege('stell22_app', 'public."ProductionOperationCancellation"', 'SELECT')
    AND has_table_privilege('stell22_app', 'public."ProductionOperationCancellation"', 'INSERT')
    AND has_table_privilege('stell22_app', 'public."ProductionOperationCancellation"', 'UPDATE')
    AND has_table_privilege('stell22_app', 'public."ProductionOperationCancellation"', 'DELETE')
  THEN 'true' ELSE 'false' END
UNION ALL
SELECT 'sentinelProductionOperation=' || (SELECT count(*)::text FROM public."ProductionOperation")
UNION ALL
SELECT 'sentinelInventoryMovement=' || (SELECT count(*)::text FROM public."InventoryMovement")
SQL
  run_sql "$work/objects.sql" > "$out"
}

unexpected_sessions() {
  if [ "$phase" = "fixture" ]; then
    cat "$STELL22_AC_FACTS_DIR/sessions.txt"
    return 0
  fi
  cat > "$work/sessions.sql" <<'SQL'
SELECT COALESCE(usename, '') || '|' || COALESCE(application_name, '') || '|' || backend_type
FROM pg_stat_activity
WHERE datname = current_database() AND backend_type = 'client backend'
SQL
  run_sql "$work/sessions.sql" | awk -F'|' -v app="$INSPECT_APP" '$2 != app { print }'
}

schema_root() {
  if [ -n "${STELL22_AC_SCHEMA_DIR:-}" ]; then
    printf '%s\n' "$STELL22_AC_SCHEMA_DIR"
    return 0
  fi
  printf '%s\n' "$PWD"
}

probe_login() {
  mode=$1
  url_file=$2
  if [ ! -f "$url_file" ]; then
    return 1
  fi
  if ! node "$DECIDE" assert-url "$url_file" "$mode" >/dev/null; then
    echo "PROBE=URL_REJECTED"
    return 1
  fi
  cat > "$work/whoami.cjs" <<'EOF'
try {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  prisma
    .$queryRawUnsafe("SELECT current_user AS login")
    .then((rows) => {
      const login = rows[0] && String(rows[0].login);
      if (login !== "stell22_migrator") process.stderr.write("PROBE=USER_MISMATCH\n");
      return prisma.$disconnect().then(() => process.exit(login === "stell22_migrator" ? 0 : 2));
    })
    .catch(() => {
      process.stderr.write("PROBE=CONNECT_FAILED\n");
      process.exit(1);
    });
} catch (error) {
  process.stderr.write("PROBE=CLIENT_FAILED\n");
  process.exit(1);
}
EOF
  set -a
  # shellcheck disable=SC1090
  . "$url_file"
  set +a
  if [ "$mode" = "production" ]; then
    docker run --rm --network "container:${db_container}" --pull never --env-file "$url_file" --entrypoint node -v "$work/whoami.cjs:/app/whoami.cjs:ro" -w /app "$app_image" /app/whoami.cjs >"$work/whoami.out" 2>"$work/whoami.err" || {
      unset DATABASE_URL || true
      release_redact_file "$work/whoami.err"
      return 1
    }
  else
    NODE_PATH="$PWD/node_modules${NODE_PATH:+:$NODE_PATH}" node "$work/whoami.cjs" >"$work/whoami.out" 2>"$work/whoami.err" || {
      unset DATABASE_URL || true
      release_redact_file "$work/whoami.err"
      probe_line=$(awk -F= '$1 == "PROBE" { print; exit }' "$work/whoami.err" 2>/dev/null || true)
      if [ -z "$probe_line" ]; then
        echo "PROBE=NO_MARKER"
      else
        echo "$probe_line"
      fi
      return 1
    }
  fi
  unset DATABASE_URL || true
}

compare_inventory() {
  root=$(schema_root)
  node "$DECIDE" inventory "$root/prisma/migrations" > "$work/inventory.txt"
  node "$DECIDE" compare "$work/inventory.txt" "$1" > "$2"
}

merge_facts() {
  cat "$1" "$2" > "$3"
}

decide_ok() {
  node "$DECIDE" "$1" "$2" > "$3"
}

if [ "$phase" != "fixture" ]; then
  if [ ! -f scripts/backup-db.sh ] || [ ! -f scripts/restore-db.sh ]; then
    finish before-stop STOP_PROTECTED_FILE
  fi
fi

if [ "$phase" = "production" ]; then
  app_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$app_container" 2>/dev/null || printf '%s' missing)
  db_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$db_container" 2>/dev/null || printf '%s' missing)
  caddy_running=$(docker inspect -f '{{.State.Running}}' "$caddy_container" 2>/dev/null || printf '%s' missing)
  legacy_image=$(docker inspect -f '{{.Image}}' "$app_container")
  running_entrypoint=$(docker image inspect --format '{{json .Config.Entrypoint}}' "$legacy_image" 2>/dev/null || true)
  db_mount=$(docker inspect -f '{{range .Mounts}}{{.Name}} {{.Destination}}{{"\n"}}{{end}}' "$db_container" 2>/dev/null || true)
  db_id_before=$(docker inspect -f '{{.Id}}' "$db_container")
  caddy_id_before=$(docker inspect -f '{{.Id}}' "$caddy_container")
  app_healthy=0
  db_healthy=0
  caddy_present=0
  volume_present=0
  running_present=0
  if [ "$app_health" = "healthy" ] && docker exec "$app_container" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    app_healthy=1
  fi
  if [ "$db_health" = "healthy" ]; then
    db_healthy=1
  fi
  if [ "$caddy_running" = "true" ]; then
    caddy_present=1
  fi
  case "$db_mount" in
    *"/var/lib/postgresql/data"*) volume_present=1 ;;
  esac
  if [ -n "$legacy_image" ]; then
    running_present=1
  fi
  case "$running_entrypoint" in
    *docker-entrypoint-app-only.sh*) old_image_app_only=1 ;;
  esac
else
  app_healthy=1
  db_healthy=1
  caddy_present=1
  volume_present=1
  running_present=1
  running_entrypoint="./docker-entrypoint-app-only.sh"
  old_image_app_only=1
  if [ "$phase" = "fixture" ]; then
    # shellcheck disable=SC1091
    . "$STELL22_AC_FACTS_DIR/runtime.env"
  fi
fi

note_processes || finish before-stop STOP_WRITER
write_history "$work/history.before"
compare_inventory "$work/history.before" "$work/history.env"
write_privilege_facts "$work/privileges.env"
cat > "$work/runtime.facts" <<EOF
appHealthy=$app_healthy
dbHealthy=$db_healthy
caddyPresent=$caddy_present
dbVolumePresent=$volume_present
protectedFilesOk=1
runningImagePresent=$running_present
runningEntrypoint=$running_entrypoint
backupRunning=$backup_running
importRunning=$import_running
migrateProcess=$migrate_process
conflictingDeploy=$conflicting
EOF
merge_facts "$work/history.env" "$work/privileges.env" "$work/preflight.part"
merge_facts "$work/preflight.part" "$work/runtime.facts" "$work/preflight.env"
if ! decide_ok preflight "$work/preflight.env" "$work/preflight.out"; then
  code=$(awk -F= '$1 == "CODE" { print $2; exit }' "$work/preflight.out")
  finish before-stop "$code"
fi

if [ "$phase" = "migrate-only" ]; then
  history_unchanged=1
  schema_unchanged=1
  probe_login disposable "$STELL22_AC_URL_FILE" || finish before-stop STOP_MIGRATOR
  cat > "$work/premigrate.env" <<EOF
migrateLogin=stell22_migrator
migratorCredentialReady=1
historyUnchanged=1
schemaUnchanged=1
unexpectedSessions=0
backupRunning=0
importRunning=0
migrateProcess=0
EOF
  merge_facts "$work/preflight.env" "$work/premigrate.env" "$work/premigrate.full"
  if ! decide_ok premigrate "$work/premigrate.full" "$work/premigrate.out"; then
    code=$(awk -F= '$1 == "CODE" { print $2; exit }' "$work/premigrate.out")
    finish before-stop "$code"
  fi
  write_object_facts "$work/sentinels.before"
  sentinel_before_operation=$(awk -F= '$1 == "sentinelProductionOperation" { print $2; exit }' "$work/sentinels.before")
  sentinel_before_movement=$(awk -F= '$1 == "sentinelInventoryMovement" { print $2; exit }' "$work/sentinels.before")
  migration_attempted=1
  set -a
  # shellcheck disable=SC1090
  . "$STELL22_AC_URL_FILE"
  set +a
  schema_dir=$(schema_root)
  migrate_status=0
  node node_modules/prisma/build/index.js migrate deploy --schema "$schema_dir/prisma/schema.prisma" > "$work/migrate.log" 2>&1 || migrate_status=$?
  unset DATABASE_URL || true
  release_redact_file "$work/migrate.log"
  if [ "$migrate_status" != 0 ]; then
    finish migration-uncertain STOP_MIGRATION_UNCERTAIN
  fi
  write_history "$work/history.after"
  compare_inventory "$work/history.after" "$work/history.after.env"
  write_privilege_facts "$work/privileges.after"
  write_object_facts "$work/objects.after"
  cat > "$work/sentinels.env" <<EOF
sentinelProductionOperationBefore=$sentinel_before_operation
sentinelInventoryMovementBefore=$sentinel_before_movement
EOF
  cat "$work/history.after.env" "$work/privileges.after" "$work/objects.after" "$work/sentinels.env" > "$work/post.env"
  if ! decide_ok postmigrate "$work/post.env" "$work/post.out"; then
    finish app-start-failed STOP_POST_MIGRATE
  fi
  echo "RESULT=MIGRATION_VERIFIED"
  echo "MIGRATION_APPLY=MIGRATOR"
  echo "MIGRATE_LOGIN=stell22_migrator"
  echo "DATABASE_RESTORE=NO"
  echo "OLD_IMAGE_RESTART=NO"
  echo "RETRY_MIGRATION=NO"
  echo "APP_START=SKIPPED_DISPOSABLE"
  exit 0
fi

if [ "$phase" = "fixture" ]; then
  if [ "${STELL22_AC_BUILD_EXIT:-0}" != 0 ]; then
    finish before-stop STOP_IMAGE
  fi
  cp "$STELL22_AC_FACTS_DIR/image.env" "$work/image.env"
else
  if ! docker tag "$legacy_image" "$hold_tag"; then
    finish before-stop STOP_IMAGE
  fi
  diag="$(git rev-parse --absolute-git-dir)/stell22-admin-corrections-diagnostics"
  mkdir -p "$diag"
  chmod 700 "$diag"
  if ! docker compose -f "$COMPOSE_FILE" build app > "$diag/image-build.log" 2>&1; then
    release_redact_file "$diag/image-build.log"
    docker image rm "$hold_tag" >/dev/null 2>&1 || true
    finish before-stop STOP_IMAGE
  fi
  rm -f "$diag/image-build.log"
  if ! identity=$(sh scripts/release-built-image-id.sh "$COMPOSE_FILE" "$legacy_image"); then
    finish before-stop STOP_IMAGE
  fi
  app_image=$(printf '%s\n' "$identity" | awk -F= '$1 == "IMAGE_ID" { print $2; exit }')
  entrypoint=$(docker image inspect --format '{{json .Config.Entrypoint}}' "$app_image" 2>/dev/null || true)
  if ! docker run --rm --network none --pull never --entrypoint sha256sum "$app_image" "/app/prisma/migrations/${MIGRATION_NAME}/migration.sql" > "$work/image.sum" 2>/dev/null; then
    finish before-stop STOP_IMAGE
  fi
  image_sha=$(awk 'NR == 1 { print $1; exit }' "$work/image.sum")
  migrate_on_start=0
  if docker run --rm --network none --pull never --entrypoint grep "$app_image" -q "prisma migrate" docker-entrypoint-app-only.sh; then
    migrate_on_start=1
  fi
  compose_user=other
  if grep -q 'postgresql://stell22_app:' "$COMPOSE_FILE"; then
    compose_user=stell22_app
  fi
  cat > "$work/image.env" <<EOF
buildOk=1
entrypoint=$entrypoint
imageHasMigrateOnStart=$migrate_on_start
migrationSha256=$image_sha
composeAppUser=$compose_user
imageId=$app_image
legacyImageId=$legacy_image
EOF
fi
if ! decide_ok image "$work/image.env" "$work/image.out"; then
  finish before-stop STOP_IMAGE
fi

if [ "$phase" = "production" ]; then
  if ! OUT="$work/migrator.url" ROLE=stell22_migrator python3 scripts/release-migrator-url.py; then
    if ! OUT="$work/migrator.url" ROLE=stell22_migrator python scripts/release-migrator-url.py; then
      finish before-stop STOP_MIGRATOR
    fi
  fi
  chmod 600 "$work/migrator.url"
  if ! node "$DECIDE" assert-url "$work/migrator.url" production > "$work/url.out"; then
    finish before-stop STOP_MIGRATOR
  fi
  if ! probe_login production "$work/migrator.url"; then
    finish before-stop STOP_MIGRATOR
  fi
fi

if [ "$phase" = "production" ]; then
  if ! docker stop "$app_container" >/dev/null; then
    finish after-stop STOP_WRITER
  fi
else
  docker stop "$app_container" >/dev/null
fi
app_stopped=1
sleep_seconds=0
if [ "$phase" != "fixture" ]; then
while [ "$sleep_seconds" -lt 10 ]; do
  sessions=$(unexpected_sessions || true)
  if [ -z "$sessions" ]; then
    break
  fi
  sleep 1
  sleep_seconds=$((sleep_seconds + 1))
done
fi
sessions=$(unexpected_sessions || true)
unexpected=0
inspection_only=1
if [ -n "$sessions" ]; then
  unexpected=1
  inspection_only=0
fi
note_processes || finish after-stop STOP_WRITER
cat > "$work/writers.env" <<EOF
appStopped=1
inspectionOnly=$inspection_only
unexpectedSessions=$unexpected
backupRunning=$backup_running
importRunning=$import_running
migrateProcess=$migrate_process
conflictingDeploy=$conflicting
EOF
if ! decide_ok writers "$work/writers.env" "$work/writers.out"; then
  write_history "$work/history.writers"
  if cmp -s "$work/history.before" "$work/history.writers"; then
    history_unchanged=1
    schema_unchanged=1
  fi
  finish after-stop STOP_WRITER
fi

if [ "$phase" = "fixture" ]; then
  backup_status=0
  "$STELL22_AC_BACKUP_BIN" > "$work/backup.out" 2>&1 || backup_status=$?
  backup_ok=0
  checksum_ok=0
  if [ "$backup_status" = 0 ] && grep -q 'BACKUP SUCCESS' "$work/backup.out"; then
    backup_ok=1
  fi
  if [ "${STELL22_AC_CHECKSUM_OK:-1}" = "1" ] && [ "$backup_ok" = 1 ]; then
    checksum_ok=1
  fi
else
  backup_status=0
  sh scripts/backup-db.sh > "$work/backup.out" 2>&1 || backup_status=$?
  backup_ok=0
  checksum_ok=0
  if [ "$backup_status" = 0 ] && grep -q 'BACKUP SUCCESS' "$work/backup.out"; then
    backup_ok=1
  fi
  newest=$(ls -1t backups/stell22_*.sql.gz 2>/dev/null | awk 'NR == 1 { print; exit }')
  if [ -n "$newest" ] && [ -f "${newest}.sha256" ] && sha256sum -c "${newest}.sha256" >/dev/null 2>&1; then
    checksum_ok=1
  fi
fi
cat > "$work/backup.env" <<EOF
backupOk=$backup_ok
checksumOk=$checksum_ok
EOF
if ! decide_ok backup "$work/backup.env" "$work/backup.decision"; then
  write_history "$work/history.backup"
  if cmp -s "$work/history.before" "$work/history.backup"; then
    history_unchanged=1
    schema_unchanged=1
  fi
  finish after-stop STOP_BACKUP
fi

write_history "$work/history.ready"
if cmp -s "$work/history.before" "$work/history.ready"; then
  history_unchanged=1
  schema_unchanged=1
fi
compare_inventory "$work/history.ready" "$work/history.ready.env"
write_privilege_facts "$work/privileges.ready"
sessions=$(unexpected_sessions || true)
unexpected=0
if [ -n "$sessions" ]; then
  unexpected=1
fi
note_processes || finish after-stop STOP_WRITER
migrator_ready=0
migrate_login=refused
if [ "$phase" = "fixture" ]; then
  migrator_ready=1
  migrate_login=stell22_migrator
else
  if node "$DECIDE" assert-url "$work/migrator.url" production >/dev/null; then
    migrator_ready=1
    migrate_login=stell22_migrator
  fi
fi
cat > "$work/ready.env" <<EOF
migrateLogin=$migrate_login
migratorCredentialReady=$migrator_ready
historyUnchanged=$history_unchanged
schemaUnchanged=$schema_unchanged
unexpectedSessions=$unexpected
backupRunning=$backup_running
importRunning=$import_running
migrateProcess=$migrate_process
EOF
merge_facts "$work/history.ready.env" "$work/privileges.ready" "$work/ready.part"
merge_facts "$work/ready.part" "$work/ready.env" "$work/premigrate.env"
if ! decide_ok premigrate "$work/premigrate.env" "$work/premigrate.out"; then
  code=$(awk -F= '$1 == "CODE" { print $2; exit }' "$work/premigrate.out")
  finish after-stop "$code"
fi

write_object_facts "$work/sentinels.before"
sentinel_before_operation=$(awk -F= '$1 == "sentinelProductionOperation" { print $2; exit }' "$work/sentinels.before")
sentinel_before_movement=$(awk -F= '$1 == "sentinelInventoryMovement" { print $2; exit }' "$work/sentinels.before")
migration_attempted=1
history_unchanged=0
migrate_status=0
if [ "$phase" = "fixture" ]; then
  migrate_status="${STELL22_AC_MIGRATE_EXIT:-0}"
else
  diag="$(git rev-parse --absolute-git-dir)/stell22-admin-corrections-diagnostics"
  mkdir -p "$diag"
  chmod 700 "$diag"
  docker run --rm --pull never --network "container:${db_container}" --memory 536870912 --cpus 0.25 --pids-limit 128 --entrypoint npx --env-file "$work/migrator.url" "$app_image" prisma migrate deploy --schema /app/prisma/schema.prisma > "$diag/migrate.log" 2>&1 || migrate_status=$?
  release_redact_file "$diag/migrate.log"
fi
if [ "$migrate_status" != 0 ]; then
  finish migration-uncertain STOP_MIGRATION_UNCERTAIN
fi

if [ "$phase" = "fixture" ]; then
  cp "$STELL22_AC_FACTS_DIR/post.env" "$work/post.env"
else
  write_history "$work/history.after"
  compare_inventory "$work/history.after" "$work/history.after.env"
  write_privilege_facts "$work/privileges.after"
  write_object_facts "$work/objects.after"
  cat > "$work/sentinels.env" <<EOF
sentinelProductionOperationBefore=$sentinel_before_operation
sentinelInventoryMovementBefore=$sentinel_before_movement
EOF
  cat "$work/history.after.env" "$work/privileges.after" "$work/objects.after" "$work/sentinels.env" > "$work/post.env"
fi
if ! decide_ok postmigrate "$work/post.env" "$work/post.out"; then
  finish app-start-failed STOP_POST_MIGRATE
fi

app_status=0
if [ "$phase" = "fixture" ]; then
  docker compose -f "$COMPOSE_FILE" up -d --no-deps app >/dev/null 2>&1 || app_status=$?
  app_status="${STELL22_AC_APP_EXIT:-$app_status}"
else
  if ! docker compose -f "$COMPOSE_FILE" up -d --no-deps app > "$diag/app-start.log" 2>&1; then
    release_redact_file "$diag/app-start.log"
    docker compose -f "$COMPOSE_FILE" stop app >/dev/null 2>&1 || true
    finish app-start-failed FORWARD_RECOVERY
  fi
  db_id_after=$(docker inspect -f '{{.Id}}' "$db_container")
  caddy_id_after=$(docker inspect -f '{{.Id}}' "$caddy_container")
  if [ "$db_id_after" != "$db_id_before" ] || [ "$caddy_id_after" != "$caddy_id_before" ]; then
    docker compose -f "$COMPOSE_FILE" stop app >/dev/null 2>&1 || true
    finish app-start-failed FORWARD_RECOVERY
  fi
  running_image=$(docker inspect -f '{{.Image}}' "$app_container")
  if [ "$running_image" != "$app_image" ]; then
    docker compose -f "$COMPOSE_FILE" stop app >/dev/null 2>&1 || true
    finish app-start-failed FORWARD_RECOVERY
  fi
  healthy=0
  attempt=1
  while [ "$attempt" -le 20 ]; do
    if docker exec "$app_container" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 3
    attempt=$((attempt + 1))
  done
  if [ "$healthy" != 1 ]; then
    docker compose -f "$COMPOSE_FILE" stop app >/dev/null 2>&1 || true
    finish app-start-failed FORWARD_RECOVERY
  fi
  if docker logs "$app_container" 2>&1 | grep -q 'prisma migrate deploy'; then
    docker compose -f "$COMPOSE_FILE" stop app >/dev/null 2>&1 || true
    finish app-start-failed FORWARD_RECOVERY
  fi
  if [ "$(git rev-parse HEAD)" != "$sha" ]; then
    docker compose -f "$COMPOSE_FILE" stop app >/dev/null 2>&1 || true
    finish app-start-failed FORWARD_RECOVERY
  fi
fi
if [ "$app_status" != 0 ]; then
  finish app-start-failed FORWARD_RECOVERY
fi

docker image rm "$hold_tag" >/dev/null 2>&1 || true
echo "RESULT=RELEASE_APPLIED"
echo "MIGRATION_APPLY=MIGRATOR"
echo "MIGRATE_LOGIN=stell22_migrator"
echo "DATABASE_RESTORE=NO"
echo "OLD_IMAGE_RESTART=NO"
echo "RETRY_MIGRATION=NO"
echo "RELEASE_SHA=$sha"
if [ -n "$app_image" ]; then
  echo "IMAGE_ID=$app_image"
fi
