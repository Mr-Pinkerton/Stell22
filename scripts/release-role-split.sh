#!/bin/sh
# Owner-gated production role split and pinned P1.
# The application image is built before stell22-app is stopped.
# After the role transaction commits, the legacy migrate-on-start image is not started.
# A failed or uncertain P1 is not retried and does not restore an older database.
set -eu
umask 077

if [ "${STELL22_RELEASE_EXECUTE:-}" != "1" ] || [ "${STELL22_RELEASE_AUTHORIZATION:-}" != "OWNER_AUTHORIZES_ROLE_SPLIT_RELEASE" ]; then
  echo "RESULT=STOP_LOCKED"
  echo "PRODUCTION_RELEASE=NO-GO"
  echo "DATABASE_RESTORE=NO"
  exit 1
fi

if [ -n "${STELL22_RELEASE_RESTORE:-}" ]; then
  echo "RESULT=STOP_NO_RESTORE" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./scripts/release-diagnostics.sh
sha="${STELL22_RELEASE_SHA:-}"
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "RESULT=STOP_CHECKOUT" >&2
  exit 1
fi

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
if [ -z "${APP_DB_PASSWORD:-}" ] || [ -z "${MIGRATOR_DB_PASSWORD:-}" ] || [ "$APP_DB_PASSWORD" = "$MIGRATOR_DB_PASSWORD" ]; then
  echo "RESULT=STOP_LOCKED" >&2
  echo "PRODUCTION_RELEASE=NO-GO" >&2
  exit 1
fi
export APP_DB_PASSWORD MIGRATOR_DB_PASSWORD
if python3 -c "import sys" >/dev/null 2>&1; then
  release_python=python3
elif python -c "import sys" >/dev/null 2>&1; then
  release_python=python
else
  echo "RESULT=STOP_LOCKED" >&2
  echo "PRODUCTION_RELEASE=NO-GO" >&2
  exit 1
fi
if ! sh scripts/release-url-password.sh; then
  echo "RESULT=STOP_LOCKED" >&2
  echo "PRODUCTION_RELEASE=NO-GO" >&2
  echo "DATABASE_RESTORE=NO" >&2
  exit 1
fi

probe_running_health() {
  app_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' stell22-app 2>/dev/null || printf '%s' missing)
  db_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' stell22-db-prod 2>/dev/null || printf '%s' missing)
  if [ "$app_health" != "healthy" ] || [ "$db_health" != "healthy" ]; then
    echo "RESULT=STOP_HEALTH" >&2
    echo "DATABASE_RESTORE=NO" >&2
    exit 1
  fi
  if ! docker exec stell22-app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo "RESULT=STOP_HEALTH" >&2
    echo "DATABASE_RESTORE=NO" >&2
    exit 1
  fi
  if ! docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "BEGIN TRANSACTION READ ONLY; SELECT 1; ROLLBACK;" >/dev/null 2>&1; then
    echo "RESULT=STOP_HEALTH" >&2
    echo "DATABASE_RESTORE=NO" >&2
    exit 1
  fi
}

if ! git fetch origin main; then
  echo "RESULT=STOP_CHECKOUT" >&2
  exit 1
fi
if [ "$(git rev-parse origin/main)" != "$sha" ]; then
  echo "RESULT=STOP_CHECKOUT" >&2
  exit 1
fi
probe_running_health

work=""
diag=""
legacy_restart=0
roles_committed=0
p1_attempted=0
app_replaced=0
freeze_started=0
history_count=0
p1_in_legacy=1
legacy_image=""
cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
  docker exec stell22-db-prod rm -f /tmp/stell22-release-app.pgpass >/dev/null 2>&1 || true
  if [ "$legacy_restart" = 1 ] && [ "$roles_committed" != 1 ] && [ "$p1_attempted" != 1 ] && [ "$app_replaced" != 1 ]; then
    docker start stell22-app >/dev/null 2>&1 || true
  fi
}
on_signal() {
  trap '' HUP INT TERM
  echo "RESULT=STOP_SIGNAL" >&2
  echo "DATABASE_RESTORE=NO" >&2
  echo "RETRY_P1=NO" >&2
  release_redact_diag
  exit 1
}
trap on_signal HUP INT TERM
trap cleanup EXIT

sh scripts/release-checkout.sh "$sha"
work="$(mktemp -d)"

run_decision() {
  event=$1
  facts=$2
  if command -v node >/dev/null 2>&1; then
    node scripts/release-decision.cjs "$event" "$facts"
    return
  fi
  docker run --rm --network none --memory 134217728 --cpus 0.20 --pids-limit 32 --entrypoint node \
    -v "$PWD/scripts/release-decision.cjs":/decision.cjs:ro \
    -v "$facts":/facts.txt:ro \
    "$legacy_image" /decision.cjs "$event" /facts.txt
}

note_writers() {
  backup_running=0
  import_running=0
  external_writers=0
  ps -eo args > "$work/processes.txt" 2>/dev/null || true
  while IFS= read -r line; do
    case "$line" in
      *grep*|*release-decision.cjs*) continue ;;
    esac
    case "$line" in
      *backup-db.sh*|*pg_dump*) backup_running=1 ;;
    esac
    case "$line" in
      *fetch-statements*) import_running=1 ;;
    esac
    case "$line" in
      *"prisma migrate"*) external_writers=$((external_writers + 1)) ;;
    esac
  done < "$work/processes.txt"
}

write_writer_facts() {
  note_writers
  cat > "$work/writers.facts" <<EOF
maintenanceDeclared=$maintenance_flag
appRunning=$1
expectAppStopped=$2
backupRunning=$backup_running
statementImportRunning=$import_running
externalWriterCount=$external_writers
checkSessions=$3
inspectionApp=stell22-release-inspect
EOF
  if [ "$3" = 1 ]; then
    docker exec -e PGAPPNAME=stell22-release-inspect stell22-db-prod \
      psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At \
      -c "SELECT 'session=' || COALESCE(usename, '') || '|' || COALESCE(application_name, '') || '|' || backend_type FROM pg_stat_activity WHERE datname = 'stell22' AND backend_type = 'client backend'" \
      >> "$work/writers.facts"
  fi
}

consider_legacy() {
  legacy_restart=0
  state="UNKNOWN|UNKNOWN|0"
  if state_line=$(docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('stell22_app', 'stell22_migrator')) THEN 'ROLES_PRESENT' ELSE 'ROLES_ABSENT' END || '|' || CASE WHEN EXISTS (SELECT 1 FROM public.\"_prisma_migrations\" WHERE migration_name = '20261010210000_psr_p3_s2_b_batch_receipt_provenance' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN 'P1_PRESENT' ELSE 'P1_ABSENT' END || '|' || (SELECT count(*)::text FROM public.\"_prisma_migrations\")"); then
    state=$state_line
    known=1
  else
    known=0
  fi
  roles_absent=0
  p1_present=1
  history_same=0
  case "$state" in
    'ROLES_ABSENT|P1_ABSENT|'*) roles_absent=1; p1_present=0 ;;
  esac
  now_count=${state##*|}
  if [ "$known" = 1 ] && [ "$now_count" = "$history_count" ]; then
    history_same=1
  fi
  cat > "$work/legacy.facts" <<EOF
roleTransitionCommitted=$roles_committed
p1Present=$p1_present
p1MigrationInLegacyImage=$p1_in_legacy
rolesAbsent=$roles_absent
historyUnchanged=$history_same
databaseStateKnown=$known
EOF
  if ! run_decision legacy-restart "$work/legacy.facts" > "$work/legacy.out"; then
    return
  fi
  if grep -q '^RESTART_LEGACY=YES$' "$work/legacy.out" && [ "$roles_committed" != 1 ] && [ "$p1_attempted" != 1 ] && [ "$app_replaced" != 1 ]; then
    legacy_restart=1
  fi
  cat "$work/legacy.out"
}

exit_decision() {
  echo "RESULT=$1"
  echo "DATABASE_RESTORE=NO"
  echo "RETRY_P1=NO"
  exit 1
}

legacy_image="$(docker inspect -f '{{.Image}}' stell22-app)"
maintenance_flag=0
if [ "${STELL22_RELEASE_MAINTENANCE:-}" = "1" ]; then
  maintenance_flag=1
fi

write_writer_facts 1 0 0
if ! run_decision writer-admission "$work/writers.facts" > "$work/writers.out"; then
  exit_decision STOP_WRITER
fi
if ! grep -q '^CODE=ADMITTED$' "$work/writers.out"; then
  cat "$work/writers.out"
  exit_decision STOP_WRITER
fi
cat "$work/writers.out"

diag="$(git rev-parse --absolute-git-dir)/stell22-release-diagnostics"
mkdir -p "$diag"
chmod 700 "$diag"
if ! docker tag "$legacy_image" stell22-release-legacy:hold; then
  exit_decision STOP_APP_START
fi
if ! docker compose -f docker-compose.prod.yml build app >"$diag/image-build.log" 2>&1; then
  release_redact_file "$diag/image-build.log"
  printf '%s\n' "maintenanceDeclared=0" > "$work/build.facts"
  run_decision image-build-failed "$work/build.facts" || true
  exit_decision STOP_APP_START
fi
rm -f "$diag/image-build.log"
if ! identity=$(sh scripts/release-built-image-id.sh docker-compose.prod.yml "$legacy_image"); then
  exit_decision STOP_APP_START
fi
built_ref=$(printf '%s\n' "$identity" | awk -F= '$1 == "IMAGE_REF" { print $2; exit }')
app_image=$(printf '%s\n' "$identity" | awk -F= '$1 == "IMAGE_ID" { print $2; exit }')
entrypoint=$(docker image inspect --format '{{json .Config.Entrypoint}}' "$app_image" 2>/dev/null || true)
if ! docker run --rm --network none --pull never --entrypoint sha256sum "$app_image" /app/prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql >"$work/p1.sum" 2>/dev/null; then
  exit_decision STOP_APP_START
fi
p1_sum=$(awk 'NR == 1 { print $1; exit }' "$work/p1.sum")
cat > "$work/image.facts" <<EOF
legacyImageId=$legacy_image
builtImageId=$app_image
entrypoint=$entrypoint
p1Checksum=$p1_sum
EOF
if ! run_decision image-identity "$work/image.facts" >"$work/image.out"; then
  exit_decision STOP_APP_START
fi
if ! grep -q '^CODE=ADMITTED$' "$work/image.out" || ! grep -F -x -q "IMAGE_ID=$app_image" "$work/image.out"; then
  exit_decision STOP_APP_START
fi
if [ -z "$built_ref" ] || [ "$app_image" = "$legacy_image" ]; then
  exit_decision STOP_APP_START
fi

catalog="$work/catalog.txt"
sql_file="$work/roles.sql"
{
  echo "database stell22"
  printf 'schemaOwner '
  docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'"
  printf 'admin '
  docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT rolsuper::text || '|' || rolcanlogin::text FROM pg_roles WHERE rolname = 'stell22'"
  printf 'roles '
  docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT (EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'stell22_app'))::text || '|' || (EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'stell22_migrator'))::text"
  docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT 'relation ' || c.relname || '|' || c.relkind::text || '|' || pg_catalog.pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind::text IN ('r','p','S','v','m') ORDER BY c.relkind::text, c.relname"
  docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT 'routine ' || p.proname || '|' || pg_catalog.pg_get_function_identity_arguments(p.oid) || '|' || pg_catalog.pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind::text = 'f' ORDER BY p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)"
  docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT 'history ' || migration_name || '|' || checksum || '|' || COALESCE(finished_at::text, '') || '|' || COALESCE(rolled_back_at::text, '') || '|' || applied_steps_count::text FROM public.\"_prisma_migrations\" ORDER BY migration_name"
} > "$catalog"
history_count=$(grep -c '^history ' "$catalog" || true)

if command -v node >/dev/null 2>&1; then
  APP_DB_PASSWORD="$APP_DB_PASSWORD" MIGRATOR_DB_PASSWORD="$MIGRATOR_DB_PASSWORD" node scripts/release-plan.cjs "$catalog" > "$sql_file" || exit_decision STOP_ROLE_TRANSITION
else
  APP_DB_PASSWORD="$APP_DB_PASSWORD" MIGRATOR_DB_PASSWORD="$MIGRATOR_DB_PASSWORD" docker run --rm --network none --memory 268435456 --cpus 0.25 --pids-limit 64 --entrypoint node \
    -e APP_DB_PASSWORD -e MIGRATOR_DB_PASSWORD \
    -v "$PWD/scripts/release-plan.cjs":/plan.cjs:ro \
    -v "$catalog":/catalog.txt:ro \
    "$legacy_image" /plan.cjs /catalog.txt > "$sql_file" || exit_decision STOP_ROLE_TRANSITION
fi
if grep -q '^RESULT=' "$sql_file"; then
  exit_decision STOP_ROLE_TRANSITION
fi

if docker run --rm --network none --pull never --entrypoint sh "$legacy_image" -c "test ! -e /app/prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql"; then
  p1_in_legacy=0
fi

write_writer_facts 1 0 0
if ! run_decision writer-admission "$work/writers.facts" > "$work/writers.out" || ! grep -q '^CODE=ADMITTED$' "$work/writers.out"; then
  cat "$work/writers.out" 2>/dev/null || true
  exit_decision STOP_WRITER
fi

if ! docker stop stell22-app >/dev/null; then
  exit_decision STOP_WRITER
fi
freeze_started=1

write_writer_facts 0 1 1 || {
  consider_legacy
  exit_decision STOP_WRITER
}
if ! run_decision writer-admission "$work/writers.facts" > "$work/sessions.out" || ! grep -q '^CODE=ADMITTED$' "$work/sessions.out"; then
  cat "$work/sessions.out" 2>/dev/null || true
  consider_legacy
  exit_decision STOP_WRITER
fi
cat "$work/sessions.out"

if ! docker exec -i stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At < "$sql_file" >/dev/null; then
  consider_legacy
  exit_decision STOP_ROLE_TRANSITION
fi
roles_committed=1
legacy_restart=0

restriction="$(docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT has_schema_privilege('stell22_app', 'public', 'CREATE')::text || '|' || pg_has_role('stell22_app', 'stell22_migrator', 'member')::text || '|' || has_table_privilege('stell22_app', 'public.\"_prisma_migrations\"', 'SELECT')::text || '|' || has_table_privilege('stell22_app', 'public.\"_prisma_migrations\"', 'INSERT')::text")" || {
  printf '%s\n' "probeCode=STOP_WRITER" > "$work/after.facts"
  run_decision after-commit "$work/after.facts" || true
  exit_decision STOP_WRITER
}
case "$restriction" in
  'false|false|true|false') ;;
  *)
    printf '%s\n' "probeCode=STOP_WRITER" > "$work/after.facts"
    run_decision after-commit "$work/after.facts" || true
    exit_decision STOP_WRITER
    ;;
esac

printf '%s\n' "127.0.0.1:*:*:stell22_app:${APP_DB_PASSWORD}" > "$work/app.pgpass"
docker cp "$work/app.pgpass" stell22-db-prod:/tmp/stell22-release-app.pgpass
docker exec -u root stell22-db-prod chown postgres:postgres /tmp/stell22-release-app.pgpass
docker exec -u root stell22-db-prod chmod 600 /tmp/stell22-release-app.pgpass
if docker exec -e PGPASSFILE=/tmp/stell22-release-app.pgpass stell22-db-prod psql -h 127.0.0.1 -X -U stell22_app -d stell22 -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "BEGIN; INSERT INTO public.\"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('writer-exclusion', 'x', 'writer_exclusion_probe', NOW(), 0); ROLLBACK;" >"$work/insert.out" 2>"$work/insert.err"; then
  printf '%s\n' "probeCode=STOP_APP_ROLE" > "$work/after.facts"
  run_decision after-commit "$work/after.facts" || true
  exit_decision STOP_APP_ROLE
fi
if ! grep -q '42501' "$work/insert.err"; then
  printf '%s\n' "probeCode=STOP_WRITER" > "$work/after.facts"
  run_decision after-commit "$work/after.facts" || true
  exit_decision STOP_WRITER
fi

write_writer_facts 0 1 1 || {
  printf '%s\n' "probeCode=STOP_WRITER" > "$work/after.facts"
  run_decision after-commit "$work/after.facts" || true
  exit_decision STOP_WRITER
}
if ! run_decision writer-admission "$work/writers.facts" > "$work/before-p1.out" || ! grep -q '^CODE=ADMITTED$' "$work/before-p1.out"; then
  cat "$work/before-p1.out" 2>/dev/null || true
  printf '%s\n' "probeCode=STOP_WRITER" > "$work/after.facts"
  run_decision after-commit "$work/after.facts" || true
  exit_decision STOP_WRITER
fi

if ! OUT="$work/migrator.url" ROLE=stell22_migrator "$release_python" scripts/release-migrator-url.py; then
  printf '%s\n' "probeCode=STOP_MIGRATOR" > "$work/after.facts"
  run_decision after-commit "$work/after.facts" || true
  exit_decision STOP_MIGRATOR
fi
p1_attempted=1
legacy_restart=0
migrate_status=0
docker run --rm --pull never --network container:stell22-db-prod --memory 536870912 --cpus 0.25 --pids-limit 128 --entrypoint npx --env-file "$work/migrator.url" "$app_image" prisma migrate deploy --schema /app/prisma/schema.prisma >"$diag/p1-migrate.log" 2>&1 || migrate_status=$?
p1_row="$(docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM public.\"_prisma_migrations\" WHERE migration_name = '20261010210000_psr_p3_s2_b_batch_receipt_provenance' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count > 0) THEN 'PRESENT' ELSE 'ABSENT' END" || true)"
if [ "$migrate_status" != 0 ] || [ "$p1_row" != "PRESENT" ]; then
  release_redact_file "$diag/p1-migrate.log"
  printf '%s\n' "maintenanceDeclared=1" > "$work/p1.facts"
  run_decision p1-uncertain "$work/p1.facts" || true
  exit_decision FORWARD_RECOVERY
fi
rm -f "$diag/p1-migrate.log"

app_replaced=1
legacy_restart=0
current_id="$(docker image inspect --format '{{.Id}}' "$built_ref" 2>/dev/null || true)"
if [ "$current_id" != "$app_image" ]; then
  printf '%s\n' "maintenanceDeclared=1" > "$work/app.facts"
  run_decision app-unhealthy "$work/app.facts" || true
  exit_decision FORWARD_RECOVERY
fi
if ! docker compose -f docker-compose.prod.yml up -d --no-deps app >"$diag/app-start.log" 2>&1; then
  release_redact_file "$diag/app-start.log"
  docker compose -f docker-compose.prod.yml stop app >/dev/null 2>&1 || true
  printf '%s\n' "maintenanceDeclared=1" > "$work/app.facts"
  run_decision app-unhealthy "$work/app.facts" || true
  exit_decision FORWARD_RECOVERY
fi

i=1
healthy=0
while [ "$i" -le 20 ]; do
  if docker exec stell22-app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 3
  i=$((i + 1))
done
if [ "$healthy" != 1 ]; then
  printf '%s\n' "application health check failed" >> "$diag/app-start.log"
  release_redact_file "$diag/app-start.log"
  docker compose -f docker-compose.prod.yml stop app >/dev/null 2>&1 || true
  printf '%s\n' "maintenanceDeclared=1" > "$work/app.facts"
  run_decision app-unhealthy "$work/app.facts" || true
  exit_decision FORWARD_RECOVERY
fi
rm -f "$diag/app-start.log"

docker image rm stell22-release-legacy:hold >/dev/null 2>&1 || true
echo "RESULT=RELEASE_APPLIED"
echo "P1_APPLY=MIGRATOR"
echo "DATABASE_RESTORE=NO"
echo "LEGACY_RESTART=NO"
echo "RETRY_P1=NO"
