#!/bin/sh
# Locked executor for one additive statement-period migration.
# The app-only image is built and its migration checksum is checked before stell22-app stops.
# A failed check before migrate can start that same container again when its image id and schema are unchanged.
# After migrate starts, the previous image is not started.
# A push does not run it. Owner authorization is required.
# Host root and the PostgreSQL superuser are the trusted release boundary.
# This is not a PSR-P3 freeze pass.
set -eu
umask 077
if [ -n "${MSYSTEM:-}" ] || command -v cygpath >/dev/null 2>&1; then
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
fi

AUTHORIZATION_PHRASE="OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48"
MIGRATION_NAME="20261105120000_statement_period_coverage"
INSPECT_APP="stell22-statement-inspect"
HOLD_TAG="stell22-statement-legacy:hold"
COMPOSE_FILE="docker-compose.prod.yml"
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# shellcheck disable=SC1091
. ./scripts/release-diagnostics.sh

migrate_calls=0
app_stopped=0
work=""
history=""
history_sql=""
before_count=""
legacy_image=""
app_image=""

finish() {
  if [ "$migrate_calls" -eq 0 ] && [ "$app_stopped" = 1 ]; then
    restart_previous || true
  else
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
  fi
  printf '%s\n' \
    "RESULT=$1" \
    "DATABASE_RESTORE=NO" \
    "SCHEMA_RESTORE=NO" \
    "RETRY_MIGRATION=NO" \
    "FREEZE_PASS=NO" \
    "PRODUCTION_AUTHORIZED=NO" \
    "FUTURE_PRIVILEGED_WRITES_PROVEN_IMPOSSIBLE=NO" \
    "MIGRATE_CALLS=$migrate_calls"
  exit 1
}

cleanup() {
  if [ -n "$work" ]; then
    rm -rf "$work"
  fi
}
trap cleanup EXIT

restart_previous() {
  now=""
  entry=""
  proved=""
  columns=""
  rows=""
  if [ "$migrate_calls" -ne 0 ] || [ "$app_stopped" != 1 ] || [ -z "$history" ] || [ -z "$before_count" ] || [ -z "$legacy_image" ]; then
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
    return 1
  fi
  now=$(docker inspect -f '{{.Image}}' "$app_container") || {
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
    return 1
  }
  if [ "$now" != "$legacy_image" ]; then
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
    return 1
  fi
  entry=$(docker image inspect --format '{{json .Config.Entrypoint}}' "$now") || {
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
    return 1
  }
  case "$entry" in
    *docker-entrypoint-app-only.sh*) ;;
    *)
      printf '%s\n' "OLD_IMAGE_RESTART=NO"
      return 1
      ;;
  esac
  case "$entry" in
    *"prisma migrate"*|*"migrate deploy"*)
      printf '%s\n' "OLD_IMAGE_RESTART=NO"
      return 1
      ;;
  esac
  proved=$(sql_at "$history_sql") || {
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
    return 1
  }
  if [ "$proved" != "$history" ]; then
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
    return 1
  fi
  columns=$(sql_at "SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Statement' AND column_name IN ('periodStart', 'periodEnd', 'source', 'contentKey') AND is_nullable = 'YES'") || {
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
    return 1
  }
  rows=$(sql_at 'SELECT count(*)::text FROM "Statement"') || {
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
    return 1
  }
  if [ "$columns" != "0" ] || [ "$rows" != "$before_count" ]; then
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
    return 1
  fi
  if ! docker start "$app_container" >/dev/null; then
    printf '%s\n' "OLD_IMAGE_RESTART=NO"
    return 1
  fi
  printf '%s\n' "OLD_IMAGE_RESTART=YES"
}

if [ "${STELL22_STATEMENT_RELEASE_EXECUTE:-}" != "1" ] || [ "${STELL22_STATEMENT_RELEASE_AUTHORIZATION:-}" != "$AUTHORIZATION_PHRASE" ]; then
  finish STOP_OWNER_GATE
fi
if [ "$#" -ne 0 ] || [ -n "${STELL22_STATEMENT_FACTS:-}" ]; then
  finish STOP_LOCKED
fi

phase=${STELL22_STATEMENT_PHASE:-production}
case "$phase" in
  production)
    db_container=stell22-db-prod
    app_container=stell22-app
    database=stell22
    ;;
  fixture)
    db_container=${STELL22_STATEMENT_DB_CONTAINER:-}
    app_container=${STELL22_STATEMENT_APP_CONTAINER:-}
    database=${STELL22_STATEMENT_DATABASE:-}
    case "$database" in
      stell22|stell22_*|"") finish STOP_LOCKED ;;
    esac
    case "$db_container" in
      stell22-db-prod|stell22-db|stell22-app|stell22-caddy|"") finish STOP_LOCKED ;;
    esac
    case "$app_container" in
      stell22-app|stell22-db-prod|stell22-caddy|"") finish STOP_LOCKED ;;
    esac
    ;;
  *) finish STOP_LOCKED ;;
esac

work=$(mktemp -d)
chmod 700 "$work"

classify() {
  node src/server/internal/statement-period-release/production.mjs "$1"
}

code_of() {
  printf '%s\n' "$1" | awk -F= '$1 == "CODE" { print $2; exit }'
}

sql_at() {
  docker exec -e PGAPPNAME="$INSPECT_APP" "$db_container" \
    psql -X -U stell22 -d "$database" -q -v ON_ERROR_STOP=1 -At -c "$1"
}

require_code() {
  if [ -z "$1" ]; then
    finish "$3"
  fi
  if [ "$1" != "$2" ]; then
    finish "$1"
  fi
}

copy_pgpass() {
  src=$1
  dest=$2
  docker cp "$src" "$db_container:$dest" || return 1
  docker exec -u root "$db_container" chown postgres:postgres "$dest" || return 1
  docker exec -u root "$db_container" chmod 600 "$dest" || return 1
}

observe_writers() {
  sessions=""
  writer_code=""
  sessions=$(sql_at "SELECT COALESCE(usename, '') || '|' || COALESCE(application_name, '') || '|' || backend_type FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend'") || return 1
  ps -eo args > "$work/processes.txt" 2>/dev/null || ps > "$work/processes.txt" || return 1
  writer_code=$(printf 'SESSIONS\n%s\nPROCESSES\n%s\n' "$sessions" "$(cat "$work/processes.txt")" | classify "writers-$1") || true
  [ "$(code_of "$writer_code")" = "WRITERS_CURRENTLY_CLEAR" ]
}

if [ "$phase" = "production" ]; then
  git fetch origin main >/dev/null
fi
head_sha=$(git rev-parse HEAD)
origin_sha=$(git rev-parse origin/main)
approved=${STELL22_STATEMENT_RELEASE_SHA:-}
case "$approved" in
  *[!0-9a-f]*|"") finish STOP_SHA ;;
esac
if [ "${#approved}" -ne 40 ] || [ "$approved" != "$head_sha" ] || [ "$approved" != "$origin_sha" ]; then
  finish STOP_SHA
fi

if [ "$phase" = "production" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
if ! sh scripts/release-url-password.sh; then
  finish STOP_MIGRATOR
fi
export APP_DB_PASSWORD MIGRATOR_DB_PASSWORD
if python3 -c "import sys" >/dev/null 2>&1; then
  release_python=python3
elif python -c "import sys" >/dev/null 2>&1; then
  release_python=python
else
  finish STOP_MIGRATOR
fi
migrator_env="$work/migrator.env"
if command -v cygpath >/dev/null 2>&1; then
  migrator_env=$(cygpath -w "$work/migrator.env")
fi
if ! OUT="$migrator_env" ROLE=stell22_migrator "$release_python" scripts/release-migrator-url.py; then
  finish STOP_MIGRATOR
fi
chmod 600 "$work/migrator.env"

history_sql="SELECT migration_name || '|' || checksum || '|' || (finished_at IS NOT NULL)::text || '|' || (rolled_back_at IS NOT NULL)::text || '|' || applied_steps_count::text FROM public.\"_prisma_migrations\" ORDER BY migration_name"
history=$(sql_at "$history_sql") || finish STOP_HISTORY
history_code=$(printf '%s\n' "$history" | classify history-preflight) || true
require_code "$(code_of "$history_code")" "OFFLINE_HISTORY_CONTRACT_MATCHED" "STOP_HISTORY"

before_count=$(sql_at 'SELECT count(*)::text FROM "Statement"') || finish STOP_HISTORY
case "$before_count" in
  ""|*[!0-9]*) finish STOP_HISTORY ;;
esac
before_columns=$(sql_at "SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Statement' AND column_name IN ('periodStart', 'periodEnd', 'source', 'contentKey') AND is_nullable = 'YES'") || finish STOP_HISTORY
if [ "$before_columns" != "0" ]; then
  finish STOP_HISTORY
fi

role_sql="SELECT 'serverVersionNum=' || current_setting('server_version_num') UNION ALL SELECT 'migratorLogin=' || EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stell22_migrator' AND rolcanlogin AND NOT rolsuper)::text UNION ALL SELECT 'migratorSuper=' || COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = 'stell22_migrator')::text, 'true') UNION ALL SELECT 'appInsert=' || has_table_privilege('stell22_app', 'public.\"_prisma_migrations\"', 'INSERT')::text"
roles=$(sql_at "$role_sql") || finish STOP_MIGRATOR
role_code=$(printf '%s\n' "$roles" | classify roles) || true
if [ "$(code_of "$role_code")" != "ROLES_OBSERVED" ]; then
  finish STOP_MIGRATOR
fi

printf '%s\n' "127.0.0.1:*:*:stell22_migrator:${MIGRATOR_DB_PASSWORD}" > "$work/migrator.pgpass"
chmod 600 "$work/migrator.pgpass"
copy_pgpass "$work/migrator.pgpass" /tmp/stell22-statement-migrator.pgpass || finish STOP_MIGRATOR
migrator_user=$(docker exec -e PGPASSFILE=/tmp/stell22-statement-migrator.pgpass "$db_container" \
  psql -h 127.0.0.1 -X -U stell22_migrator -d "$database" -q -v ON_ERROR_STOP=1 -At -c "SELECT current_user") || finish STOP_MIGRATOR
if [ "$migrator_user" != "stell22_migrator" ]; then
  finish STOP_MIGRATOR
fi

printf '%s\n' "127.0.0.1:*:*:stell22_app:${APP_DB_PASSWORD}" > "$work/app.pgpass"
chmod 600 "$work/app.pgpass"
copy_pgpass "$work/app.pgpass" /tmp/stell22-statement-app.pgpass || finish STOP_APP_ROLE
insert_status=0
docker exec -e PGPASSFILE=/tmp/stell22-statement-app.pgpass "$db_container" \
  psql -h 127.0.0.1 -X -U stell22_app -d "$database" \
  -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
  -c "BEGIN; INSERT INTO public.\"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('statement-writer-probe', 'x', 'statement_writer_probe', NOW(), 0); ROLLBACK;" \
  >"$work/insert.out" 2>"$work/insert.err" || insert_status=$?
docker exec "$db_container" rm -f /tmp/stell22-statement-app.pgpass /tmp/stell22-statement-migrator.pgpass >/dev/null 2>&1 || true
if [ "$insert_status" = 0 ] || ! grep -q '42501' "$work/insert.err"; then
  finish STOP_APP_ROLE
fi

legacy_image=$(docker inspect -f '{{.Image}}' "$app_container") || finish STOP_IMAGE
if ! docker tag "$legacy_image" "$HOLD_TAG"; then
  finish STOP_IMAGE
fi
if [ "$phase" = "production" ]; then
  diag="$(git rev-parse --absolute-git-dir)/stell22-statement-diagnostics"
  mkdir -p "$diag"
  chmod 700 "$diag"
  if ! docker compose -f "$COMPOSE_FILE" build app >"$diag/image-build.log" 2>&1; then
    release_redact_file "$diag/image-build.log"
    finish STOP_IMAGE
  fi
  rm -f "$diag/image-build.log"
else
  if ! docker compose -f "$COMPOSE_FILE" build app >"$work/image-build.log" 2>&1; then
    finish STOP_IMAGE
  fi
fi
identity=$(sh scripts/release-built-image-id.sh "$COMPOSE_FILE" "$legacy_image") || finish STOP_IMAGE
built_ref=$(printf '%s\n' "$identity" | awk -F= '$1 == "IMAGE_REF" { print $2; exit }')
app_image=$(printf '%s\n' "$identity" | awk -F= '$1 == "IMAGE_ID" { print $2; exit }')
if [ -z "$built_ref" ] || [ -z "$app_image" ] || [ "$app_image" = "$legacy_image" ]; then
  finish STOP_IMAGE
fi
entrypoint=$(docker image inspect --format '{{json .Config.Entrypoint}}' "$app_image") || finish STOP_IMAGE
image_sum=$(docker run --rm --network none --pull never --entrypoint sha256sum "$app_image" \
  "/app/prisma/migrations/${MIGRATION_NAME}/migration.sql") || finish STOP_IMAGE
image_sum=$(printf '%s\n' "$image_sum" | awk 'NR == 1 { print $1; exit }')
compose_user=other
if grep -q 'postgresql://stell22_app:' "$COMPOSE_FILE"; then
  compose_user=stell22_app
fi
migrate_on_start=0
case "$entrypoint" in
  *"prisma migrate"*|*"migrate deploy"*) migrate_on_start=1 ;;
esac
image_code=$(printf '%s\n' \
  "entrypoint=$entrypoint" \
  "migrationSha256=$image_sum" \
  "composeUser=$compose_user" \
  "migrateOnStart=$migrate_on_start" \
  "builtImageId=$app_image" \
  "legacyImageId=$legacy_image" | classify image) || true
image_observed=$(code_of "$image_code")
if [ -z "$image_observed" ]; then
  finish STOP_IMAGE
fi
if [ "$image_observed" != "IMAGE_OBSERVED" ]; then
  finish "$image_observed"
fi

observe_writers before || finish STOP_WRITER
if ! docker stop "$app_container" >/dev/null; then
  finish STOP_WRITER
fi
app_stopped=1
observe_writers after || finish STOP_WRITER

if [ "$phase" = "fixture" ]; then
  backup_bin=${STELL22_STATEMENT_BACKUP_BIN:-}
  if [ -z "$backup_bin" ]; then
    finish STOP_BACKUP
  fi
  backup_out=$("$backup_bin") || finish STOP_BACKUP
else
  backup_out=$(sh scripts/backup-db.sh) || finish STOP_BACKUP
fi
archive=$(printf '%s\n' "$backup_out" | sed -n 's/.*BACKUP SUCCESS: //p' | head -n 1)
base=$(basename "$archive")
case "$base" in
  stell22_*.sql.gz) ;;
  *) finish STOP_BACKUP ;;
esac
if [ ! -f "$archive" ] || [ ! -f "$archive.sha256" ]; then
  finish STOP_BACKUP
fi
if ! (CDPATH= cd "$(dirname "$archive")" && sha256sum -c "$base.sha256" >/dev/null); then
  finish STOP_BACKUP
fi

ready=$(sql_at "$history_sql") || finish STOP_HISTORY
if [ "$ready" != "$history" ]; then
  finish STOP_HISTORY
fi
ready_code=$(printf '%s\n' "$ready" | classify history-preflight) || true
require_code "$(code_of "$ready_code")" "OFFLINE_HISTORY_CONTRACT_MATCHED" "STOP_HISTORY"
observe_writers after || finish STOP_WRITER

if [ "$migrate_calls" -ne 0 ]; then
  finish FORWARD_RECOVERY
fi
migrate_calls=1
migrate_status=0
docker run --rm --pull never --network "container:${db_container}" \
  --memory 536870912 --cpus 0.25 --pids-limit 128 \
  --entrypoint npx --env-file "$work/migrator.env" "$app_image" \
  prisma migrate deploy --schema /app/prisma/schema.prisma >"$work/migrate.log" 2>&1 || migrate_status=$?
if [ "$migrate_status" -ne 0 ]; then
  finish FORWARD_RECOVERY
fi

after=$(sql_at "$history_sql") || finish FORWARD_RECOVERY
after_code=$(printf '%s\n' "$after" | classify history-post) || true
if [ "$(code_of "$after_code")" != "POST_MIGRATION_VERIFIED" ]; then
  finish FORWARD_RECOVERY
fi
after_count=$(sql_at 'SELECT count(*)::text FROM "Statement"') || finish FORWARD_RECOVERY
if [ "$after_count" != "$before_count" ]; then
  finish FORWARD_RECOVERY
fi
after_columns=$(sql_at "SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Statement' AND column_name IN ('periodStart', 'periodEnd', 'source', 'contentKey') AND is_nullable = 'YES'") || finish FORWARD_RECOVERY
if [ "$after_columns" != "4" ]; then
  finish FORWARD_RECOVERY
fi

if ! docker compose -f "$COMPOSE_FILE" up -d --no-deps app; then
  finish FORWARD_RECOVERY
fi
running_image=$(docker inspect -f '{{.Image}}' "$app_container") || finish FORWARD_RECOVERY
if [ "$running_image" != "$app_image" ]; then
  docker stop "$app_container" >/dev/null 2>&1 || true
  finish FORWARD_RECOVERY
fi

attempt=1
healthy=0
while [ "$attempt" -le 20 ]; do
  if docker exec "$app_container" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 3
  attempt=$((attempt + 1))
done
if [ "$healthy" != 1 ]; then
  docker stop "$app_container" >/dev/null 2>&1 || true
  finish FORWARD_RECOVERY
fi
if docker logs "$app_container" 2>&1 | grep -q 'prisma migrate deploy'; then
  docker stop "$app_container" >/dev/null 2>&1 || true
  finish FORWARD_RECOVERY
fi
docker image rm "$HOLD_TAG" >/dev/null 2>&1 || true

printf '%s\n' \
  "RESULT=RELEASE_APPLIED" \
  "DATABASE_RESTORE=NO" \
  "SCHEMA_RESTORE=NO" \
  "RETRY_MIGRATION=NO" \
  "FREEZE_PASS=NO" \
  "PRODUCTION_AUTHORIZED=NO" \
  "FUTURE_PRIVILEGED_WRITES_PROVEN_IMPOSSIBLE=NO" \
  "MIGRATE_CALLS=$migrate_calls" \
  "OLD_IMAGE_RESTART=NO" \
  "STATEMENT_ROWS_UNCHANGED=YES"
exit 0
