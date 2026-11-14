#!/bin/sh
# Initial Stell22 recovery for one empty Beget VPS.
# Default is refusal. This does not migrate 47 to 48, start the app, or start Caddy.
# It does not call scripts/restore-db.sh or the disposable restore executors.
# A partial database is kept. The next invocation refuses instead of retrying.
# The database is the Compose service db: project stell22, volume stell22_db-data,
# network stell22_default, container stell22-db-prod. App and Caddy stay stopped.
set -eu
umask 077

if [ -n "${MSYSTEM:-}" ]; then
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
fi

AUTH_PHRASE=OWNER_AUTHORIZES_BEGET_INITIAL_RECOVERY_20261028
HARNESS_PHRASE=OWNER_AUTHORIZES_BEGET_RECOVERY_HARNESS
BASE_SHA=49b0ab22a17351abdca354f50919c7ee8cd6e790
HOST_NAME=sonzutxkyv
MACHINE_ID=9cac56c437fa4bc1ba192da9567e79f2
HOST_IP=141.133.195.7
BACKUP_SHA=5c77d7e7191faf457baa757eedc640ffdaf2297e99a17e121bcca4a5ee66d5d3
INDEX_DIGEST=sha256:d3244e8ce3f165ee3c93d9c4a4b1d0fe48b3a89e2287b717fdcbbde92d405065
IMAGE_DIGEST=sha256:005c5c37db96c1e6652a79ea31f9886402fba81ac95dc2db897739121dd7f8f2
IMAGE_REF="postgres@${IMAGE_DIGEST}"
PRODUCTION_TABLES=56
PRODUCTION_CONSTRAINTS=159
PRODUCTION_MIGRATIONS=47
PRODUCTION_ROWS=3589
PRODUCTION_MIGRATION_SHA=568490f22d9829f909333907beb8643083cdbbc5f97b3ed638a53d4cb29371cb
PRODUCTION_COLUMN_FP=9ff8c23907980e711cdd05daf3857918625633181f9437d51c57483ab94c198a
PRODUCTION_CONSTRAINT_FP=60fe6ede4990f429caaa22379cd4dfb0f62b8d8403502ad4ec11461bd05dc2bc
P1_MIGRATION=20261010210000_psr_p3_s2_b_batch_receipt_provenance
ABSENT_MIGRATION=20261105120000_statement_period_coverage
MIN_FREE=8589934592

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
DB=stell22
APP_PW=""
MIG_PW=""
POSTGRES_PW=""

stop() {
  code=$1
  shift
  printf '%s\n' "$@" \
    "APPLICATION_STARTED=NO" \
    "CADDY_STARTED=NO" \
    "MIGRATION_47_48=NOT_APPLIED" \
    "DNS_CHANGED=NO" \
    "CLEANUP=NO" \
    "RETRY=NO"
  exit "$code"
}

trim() {
  printf '%s' "$1" | tr -d '[:space:]'
}

git_at() {
  dir=$1
  shift
  if command -v cygpath >/dev/null 2>&1; then
    dir=$(cygpath -w "$dir")
  fi
  git -C "$dir" "$@"
}

node_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

hex64() {
  case "$1" in
    *[!0-9a-f]*|"") return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}

hex40() {
  case "$1" in
    *[!0-9a-f]*|"") return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

digits() {
  case "$1" in
    *[!0-9]*|"") return 1 ;;
  esac
  return 0
}

password_ok() {
  case "$1" in
    *[!A-Za-z0-9]*|"") return 1 ;;
  esac
  [ "${#1}" -ge 24 ] && [ "${#1}" -le 128 ]
}

production_identity() {
  mid=""
  name=""
  if [ -f /etc/machine-id ]; then
    mid=$(trim "$(cat /etc/machine-id)")
  fi
  if [ -x /bin/hostname ]; then
    name=$(/bin/hostname)
  elif [ -x /usr/bin/hostname ]; then
    name=$(/usr/bin/hostname)
  fi
  [ "$mid" = "$MACHINE_ID" ] || [ "$name" = "$HOST_NAME" ]
}

write_phase() {
  tmp="$STATE_DIR/beget-recovery.state.tmp"
  printf 'phase=%s\nvolume=%s\ncontainer=%s\n' "$1" "$VOLUME" "$CONTAINER" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$STATE_DIR/beget-recovery.state"
}

psql_at() {
  docker exec -i "$CONTAINER" psql -X -U stell22 -d "$DB" -q -v ON_ERROR_STOP=1 -At -c "$1"
}

compose_identity() {
  project=$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
  service=$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null || true)
  oneoff=$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.oneoff"}}' 2>/dev/null || true)
  running_image=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)
  mount=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Name}} {{.Destination}}{{println}}{{end}}' 2>/dev/null || true)
  net=$(docker inspect "$CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{println}}{{end}}' 2>/dev/null || true)
  alias=$(docker inspect "$CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{range $v.Aliases}}{{.}}{{println}}{{end}}{{end}}' 2>/dev/null || true)
  [ "$(trim "$project")" = "$COMPOSE_PROJECT" ] || return 1
  [ "$(trim "$service")" = "db" ] || return 1
  [ "$(trim "$oneoff")" = "False" ] || return 1
  case "$(trim "$running_image")" in
    "$IMAGE_REF"|"docker.io/library/$IMAGE_REF") ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$mount" | grep -x -q -F "$VOLUME /var/lib/postgresql/data" || return 1
  printf '%s\n' "$net" | grep -x -q -F "$NETWORK" || return 1
  printf '%s\n' "$alias" | grep -x -q -F "db" || return 1
}

require_query() {
  got=$(trim "$1")
  want=$(trim "$2")
  [ "$got" = "$want" ]
}

execute=${STELL22_BEGET_RECOVERY_EXECUTE:-}
auth=${STELL22_BEGET_RECOVERY_AUTHORIZATION:-}
if [ "$execute" != "1" ] || { [ "$auth" != "$AUTH_PHRASE" ] && [ "$auth" != "$HARNESS_PHRASE" ]; }; then
  stop 1 "RESULT=REFUSED_AUTHORIZATION"
fi
if production_identity; then
  if [ "$auth" != "$AUTH_PHRASE" ]; then
    stop 1 "RESULT=REFUSED_HOST"
  fi
  mode=production
else
  if [ "$auth" != "$HARNESS_PHRASE" ]; then
    stop 1 "RESULT=REFUSED_HOST"
  fi
  mode=harness
fi

if [ "${STELL22_BEGET_RECOVERY_EMPTY_DESTINATION:-}" != "CONFIRMED" ]; then
  stop 1 "RESULT=REFUSED_DESTINATION"
fi

POSTGRES_PW=${STELL22_BEGET_RECOVERY_POSTGRES_PASSWORD:-}
APP_PW=${STELL22_BEGET_RECOVERY_APP_PASSWORD:-}
MIG_PW=${STELL22_BEGET_RECOVERY_MIGRATOR_PASSWORD:-}
if ! password_ok "$POSTGRES_PW" || ! password_ok "$APP_PW" || ! password_ok "$MIG_PW"; then
  stop 1 "RESULT=REFUSED_PASSWORD"
fi
if [ "$POSTGRES_PW" = "$APP_PW" ] || [ "$POSTGRES_PW" = "$MIG_PW" ] || [ "$APP_PW" = "$MIG_PW" ]; then
  stop 1 "RESULT=REFUSED_PASSWORD"
fi

if [ "$mode" = "production" ]; then
  PROJECT=/root/Stell22
  BACKUP=/root/stell22-recovery/stell22_2026-10-28_03-00-01.sql.gz
  STATE_DIR=/root/stell22-recovery
  COMPOSE_PROJECT=stell22
  VOLUME=stell22_db-data
  CONTAINER=stell22-db-prod
  NETWORK=stell22_default
  WANT_TABLES=$PRODUCTION_TABLES
  WANT_CONSTRAINTS=$PRODUCTION_CONSTRAINTS
  WANT_MIGRATIONS=$PRODUCTION_MIGRATIONS
  WANT_ROWS=$PRODUCTION_ROWS
  WANT_MIGRATION_SHA=$PRODUCTION_MIGRATION_SHA
  WANT_COLUMN_FP=$PRODUCTION_COLUMN_FP
  WANT_CONSTRAINT_FP=$PRODUCTION_CONSTRAINT_FP
  WANT_BACKUP_SHA=$BACKUP_SHA
  if [ "$ROOT" != "$PROJECT" ]; then
    stop 1 "RESULT=REFUSED_SHA"
  fi
  name=$(/bin/hostname)
  mid=$(trim "$(cat /etc/machine-id)")
  ips=$(/bin/hostname -I 2>/dev/null || true)
  if [ "$name" != "$HOST_NAME" ] || [ "$mid" != "$MACHINE_ID" ]; then
    stop 1 "RESULT=REFUSED_HOST"
  fi
  case " $ips " in
    *" $HOST_IP "*) ;;
    *) stop 1 "RESULT=REFUSED_HOST" ;;
  esac
  if [ "$(stat -c %a "$STATE_DIR")" != "700" ] || [ "$(stat -c %a "$BACKUP")" != "600" ]; then
    stop 1 "RESULT=REFUSED_ARCHIVE"
  fi
else
  PROJECT=${STELL22_BEGET_RECOVERY_PROJECT:-}
  BACKUP=${STELL22_BEGET_RECOVERY_BACKUP:-}
  STATE_DIR=${STELL22_BEGET_RECOVERY_STATE:-}
  COMPOSE_PROJECT=${STELL22_BEGET_RECOVERY_COMPOSE_PROJECT:-}
  VOLUME=${STELL22_BEGET_RECOVERY_VOLUME:-}
  CONTAINER=${STELL22_BEGET_RECOVERY_CONTAINER:-}
  NETWORK=${STELL22_BEGET_RECOVERY_NETWORK:-}
  WANT_TABLES=${STELL22_BEGET_RECOVERY_EXPECT_TABLES:-}
  WANT_CONSTRAINTS=${STELL22_BEGET_RECOVERY_EXPECT_CONSTRAINTS:-}
  WANT_MIGRATIONS=${STELL22_BEGET_RECOVERY_EXPECT_MIGRATIONS:-}
  WANT_ROWS=${STELL22_BEGET_RECOVERY_EXPECT_ROWS:-}
  WANT_MIGRATION_SHA=${STELL22_BEGET_RECOVERY_EXPECT_MIGRATION_SHA:-}
  WANT_COLUMN_FP=${STELL22_BEGET_RECOVERY_EXPECT_COLUMN_FP:-}
  WANT_CONSTRAINT_FP=${STELL22_BEGET_RECOVERY_EXPECT_CONSTRAINT_FP:-}
  WANT_BACKUP_SHA=${STELL22_BEGET_RECOVERY_BACKUP_SHA:-}
  if [ "$PROJECT" = "/root/Stell22" ] || [ "$BACKUP" = "/root/stell22-recovery/stell22_2026-10-28_03-00-01.sql.gz" ] || [ "$STATE_DIR" = "/root/stell22-recovery" ]; then
    stop 1 "RESULT=REFUSED_ARCHIVE"
  fi
  case "$CONTAINER" in
    stell22-beget-harness-*) ;;
    *) stop 1 "RESULT=REFUSED_CONTRACT" ;;
  esac
  case "$VOLUME" in
    stell22-beget-harness_db-data) ;;
    *) stop 1 "RESULT=REFUSED_CONTRACT" ;;
  esac
  case "$COMPOSE_PROJECT" in
    stell22-beget-harness) ;;
    *) stop 1 "RESULT=REFUSED_CONTRACT" ;;
  esac
  if [ "$VOLUME" != "${COMPOSE_PROJECT}_db-data" ] || [ "$NETWORK" != "${COMPOSE_PROJECT}_default" ]; then
    stop 1 "RESULT=REFUSED_CONTRACT"
  fi
  case "$NETWORK" in
    stell22-beget-harness_default) ;;
    *) stop 1 "RESULT=REFUSED_CONTRACT" ;;
  esac
  if [ "$WANT_BACKUP_SHA" = "$BACKUP_SHA" ]; then
    stop 1 "RESULT=REFUSED_ARCHIVE"
  fi
fi

if ! digits "$WANT_TABLES" || ! digits "$WANT_CONSTRAINTS" || ! digits "$WANT_MIGRATIONS" || ! digits "$WANT_ROWS"; then
  stop 1 "RESULT=REFUSED_CONTRACT"
fi
if ! hex64 "$WANT_MIGRATION_SHA" || ! hex64 "$WANT_COLUMN_FP" || ! hex64 "$WANT_CONSTRAINT_FP" || ! hex64 "$WANT_BACKUP_SHA"; then
  stop 1 "RESULT=REFUSED_CONTRACT"
fi

supplied_sha=${STELL22_BEGET_RECOVERY_SHA:-}
supplied_tree=${STELL22_BEGET_RECOVERY_TREE:-}
if ! hex40 "$supplied_sha" || ! hex40 "$supplied_tree"; then
  stop 1 "RESULT=REFUSED_SHA"
fi
head_sha=$(git_at "$PROJECT" rev-parse HEAD) || stop 1 "RESULT=REFUSED_SHA"
head_tree=$(git_at "$PROJECT" rev-parse 'HEAD^{tree}') || stop 1 "RESULT=REFUSED_SHA"
if [ "$head_sha" != "$supplied_sha" ] || [ "$head_tree" != "$supplied_tree" ]; then
  stop 1 "RESULT=REFUSED_SHA"
fi
dirty=$(git_at "$PROJECT" status --porcelain) || stop 1 "RESULT=REFUSED_CHECKOUT"
if [ -n "$dirty" ]; then
  stop 1 "RESULT=REFUSED_CHECKOUT"
fi
if [ "$mode" = "production" ]; then
  git_at "$PROJECT" merge-base --is-ancestor "$BASE_SHA" HEAD || stop 1 "RESULT=REFUSED_SHA"
  recorded=$(git_at "$PROJECT" rev-parse "HEAD:scripts/beget-production-recovery.sh") || stop 1 "RESULT=REFUSED_SHA"
  current=$(git_at "$PROJECT" hash-object "$ROOT/scripts/beget-production-recovery.sh") || stop 1 "RESULT=REFUSED_SHA"
  if [ "$recorded" != "$current" ]; then
    stop 1 "RESULT=REFUSED_SHA"
  fi
fi

if [ -z "$BACKUP" ] || [ -L "$BACKUP" ] || [ ! -f "$BACKUP" ]; then
  stop 1 "RESULT=REFUSED_ARCHIVE"
fi
file_sha=$(sha256sum -t "$BACKUP" | awk 'NR==1 { print $1; exit }')
if [ "$file_sha" != "$WANT_BACKUP_SHA" ]; then
  stop 1 "RESULT=REFUSED_CHECKSUM"
fi
if ! gzip -t "$BACKUP"; then
  stop 1 "RESULT=REFUSED_GZIP"
fi
set +o pipefail
header=$(gzip -dc "$BACKUP" 2>/dev/null | awk 'NR==1 { print; exit }' || true)
set -o pipefail
case "$header" in
  --*) ;;
  *) stop 1 "RESULT=REFUSED_FORMAT" ;;
esac

if ! command -v node >/dev/null 2>&1; then
  stop 1 "RESULT=REFUSED_FINGERPRINT_RUNTIME"
fi
if ! command -v docker >/dev/null 2>&1 || ! docker version >/dev/null 2>&1; then
  stop 1 "RESULT=REFUSED_DOCKER"
fi
if ! docker compose version >/dev/null 2>&1; then
  stop 1 "RESULT=REFUSED_DOCKER"
fi

if [ -f "$STATE_DIR/beget-recovery.state" ]; then
  existing=$(awk -F= '$1=="phase" { print $2; exit }' "$STATE_DIR/beget-recovery.state")
  if [ "$existing" = "READY" ]; then
    stop 1 "RESULT=REFUSED_ALREADY_COMPLETE" "PHASE=$existing"
  fi
  stop 1 "RESULT=REFUSED_PARTIAL" "PHASE=$existing"
fi

docker pull "$IMAGE_REF" >/dev/null || stop 1 "RESULT=REFUSED_POSTGRES_IDENTITY"
arch=$(docker image inspect "$IMAGE_REF" --format '{{.Architecture}}' 2>/dev/null || true)
os_name=$(docker image inspect "$IMAGE_REF" --format '{{.Os}}' 2>/dev/null || true)
pg_env=$(docker image inspect "$IMAGE_REF" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true)
if [ "$(trim "$arch")" != "amd64" ] || [ "$(trim "$os_name")" != "linux" ]; then
  stop 1 "RESULT=REFUSED_POSTGRES_IDENTITY"
fi
case "$pg_env" in
  *"PG_MAJOR=17"*) ;;
  *) stop 1 "RESULT=REFUSED_POSTGRES_IDENTITY" ;;
esac
if ! version=$(docker run --rm --network none --pull never --entrypoint postgres "$IMAGE_REF" --version 2>/dev/null); then
  stop 1 "RESULT=REFUSED_POSTGRES_IDENTITY"
fi
case "$version" in
  *"(PostgreSQL) 17."*) ;;
  *) stop 1 "RESULT=REFUSED_POSTGRES_IDENTITY" ;;
esac
# INDEX_DIGEST pins the verified multi-arch index that contains IMAGE_DIGEST for linux/amd64.
if [ -z "$INDEX_DIGEST" ]; then
  stop 1 "RESULT=REFUSED_POSTGRES_IDENTITY"
fi

names=$(docker ps -a --format '{{.Names}}' || true)
printf '%s\n' "$names" | grep -x -q -e stell22-db-prod -e stell22-db -e stell22-app -e stell22-caddy && stop 1 "RESULT=REFUSED_EXISTING"
volumes=$(docker volume ls --format '{{.Name}}' || true)
printf '%s\n' "$volumes" | grep -x -q -e db-data -e stell22_db-data -e caddy-data -e stell22_caddy-data -e caddy-config -e stell22_caddy-config && stop 1 "RESULT=REFUSED_EXISTING"
if [ "$mode" = "harness" ]; then
  printf '%s\n' "$volumes" | grep -x -q -e "$VOLUME" && stop 1 "RESULT=REFUSED_EXISTING"
  printf '%s\n' "$names" | grep -x -q -e "$CONTAINER" && stop 1 "RESULT=REFUSED_EXISTING"
fi
if [ "$mode" = "production" ]; then
  if ! command -v ss >/dev/null 2>&1; then
    stop 1 "RESULT=UNCERTAIN"
  fi
  if ss -lnt | awk 'NR>1 && $4 ~ /:5432$/ { found=1 } END { exit !found }'; then
    stop 1 "RESULT=REFUSED_WRITER"
  fi
fi

free_bytes=$(df -B1 -P "$STATE_DIR" | awk 'NR==2 { print $4; exit }')
if ! digits "$free_bytes" || [ "$free_bytes" -lt "$MIN_FREE" ]; then
  stop 1 "RESULT=REFUSED_DISK"
fi

compose_file="$ROOT/docker-compose.prod.yml"
if ! grep -F -x "    image: ${IMAGE_REF}" "$compose_file" >/dev/null; then
  stop 1 "RESULT=REFUSED_POSTGRES_IDENTITY"
fi
if ! grep -F -x "    container_name: stell22-db-prod" "$compose_file" >/dev/null; then
  stop 1 "RESULT=REFUSED_COMPOSE"
fi
if grep -F -q '5432:5432' "$compose_file"; then
  stop 1 "RESULT=REFUSED_PORT"
fi

write_phase VOLUME
# The password stays in this process environment. --env-file /dev/null
# keeps Compose from reading a project .env. Only the db service starts.
if ! POSTGRES_PASSWORD="$POSTGRES_PW" docker compose \
  -f "$compose_file" \
  --project-directory "$ROOT" \
  --project-name "$COMPOSE_PROJECT" \
  --env-file /dev/null \
  up -d --no-deps --pull never --no-build db
then
  stop 1 "RESULT=REFUSED_COMPOSE" "PHASE=VOLUME"
fi
write_phase CONTAINER
ports=$(docker inspect "$CONTAINER" --format '{{json .HostConfig.PortBindings}}')
case "$ports" in
  ""|"{}"|"null"|"<no value>") ;;
  *) stop 1 "RESULT=REFUSED_PORT" "PHASE=CONTAINER" ;;
esac
if ! compose_identity; then
  stop 1 "RESULT=REFUSED_COMPOSE" "PHASE=CONTAINER"
fi
if printf '%s\n' "$(docker ps -a --format '{{.Names}}')" | grep -x -q -e stell22-app -e stell22-caddy; then
  stop 1 "RESULT=REFUSED_WRITER" "PHASE=CONTAINER"
fi

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if docker exec "$CONTAINER" pg_isready -U stell22 -d "$DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$ready" != "1" ]; then
  stop 1 "RESULT=UNCERTAIN" "PHASE=CONTAINER"
fi

before=$(trim "$(psql_at "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')")")
if [ "$before" != "0" ]; then
  stop 1 "RESULT=REFUSED_EXISTING" "PHASE=CONTAINER"
fi

roles=$(trim "$(psql_at "SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('stell22_migrator', 'stell22_app') AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolcanlogin AND NOT rolreplication AND NOT rolbypassrls")")
if [ "$roles" = "0" ]; then
  psql_at "CREATE ROLE stell22_migrator WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS" >/dev/null
  psql_at "CREATE ROLE stell22_app WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS" >/dev/null
  roles=$(trim "$(psql_at "SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname IN ('stell22_migrator', 'stell22_app') AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolcanlogin AND NOT rolreplication AND NOT rolbypassrls")")
fi
if [ "$roles" != "2" ]; then
  stop 1 "RESULT=REFUSED_ROLE" "PHASE=CONTAINER"
fi

write_phase RESTORE
set +e
gzip -dc "$BACKUP" | docker exec -i "$CONTAINER" psql -X -U stell22 -d "$DB" -q -v ON_ERROR_STOP=1 --single-transaction -f - >"$STATE_DIR/restore.out" 2>"$STATE_DIR/restore.err"
restore_status=$?
set -e
rm -f "$STATE_DIR/restore.out"
if [ "$restore_status" != "0" ]; then
  stop 1 "RESULT=FAILED_RESTORE_SQL" "PHASE=RESTORE"
fi

tables=$(trim "$(psql_at "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')")")
constraints=$(trim "$(psql_at "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'")")
migrations=$(trim "$(psql_at "SELECT count(*) FROM \"_prisma_migrations\"")")
incomplete=$(trim "$(psql_at "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL OR started_at IS NULL OR applied_steps_count <> 1")")
absent=$(trim "$(psql_at "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '${ABSENT_MIGRATION}'")")
p1=$(trim "$(psql_at "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '${P1_MIGRATION}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count = 1")")
if ! psql_at "SELECT migration_name FROM \"_prisma_migrations\" ORDER BY migration_name" > "$STATE_DIR/migration-names"; then
  stop 1 "RESULT=UNCERTAIN" "PHASE=VERIFY"
fi
migration_sha=$(sha256sum -t "$STATE_DIR/migration-names" | awk 'NR==1 { print $1; exit }')
rm -f "$STATE_DIR/migration-names"
rows=$(trim "$(psql_at "SELECT COALESCE(sum(n),0)::text FROM (SELECT (xpath('//cnt/text()', query_to_xml(format('SELECT count(*)::bigint AS cnt FROM public.%I', c.relname), false, true, '')))[1]::text::bigint AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition) s")")
if ! require_query "$tables" "$WANT_TABLES" \
  || ! require_query "$constraints" "$WANT_CONSTRAINTS" \
  || ! require_query "$migrations" "$WANT_MIGRATIONS" \
  || ! require_query "$incomplete" "0" \
  || ! require_query "$absent" "0" \
  || ! require_query "$p1" "1" \
  || ! require_query "$migration_sha" "$WANT_MIGRATION_SHA" \
  || ! require_query "$rows" "$WANT_ROWS"; then
  stop 1 "RESULT=INSPECT_MISMATCH" "PHASE=VERIFY" "PUBLIC_TABLES=$tables" "PUBLIC_CONSTRAINTS=$constraints" "MIGRATION_ROWS=$migrations" "SOURCE_ROWS=$rows"
fi

helper=$(node_path "$ROOT/scripts/production-backup-restore-fingerprint.mjs")
node "$helper" --print-column-sql > "$STATE_DIR/column.sql"
node "$helper" --print-constraint-sql > "$STATE_DIR/constraint.sql"
delim=$(printf '\037')
if ! docker exec -i "$CONTAINER" psql -X -U stell22 -d "$DB" -q -v ON_ERROR_STOP=1 -At -F "$delim" -f - < "$STATE_DIR/column.sql" > "$STATE_DIR/column.tsv"; then
  stop 1 "RESULT=UNCERTAIN" "PHASE=VERIFY"
fi
if ! docker exec -i "$CONTAINER" psql -X -U stell22 -d "$DB" -q -v ON_ERROR_STOP=1 -At -F "$delim" -f - < "$STATE_DIR/constraint.sql" > "$STATE_DIR/constraint.tsv"; then
  stop 1 "RESULT=UNCERTAIN" "PHASE=VERIFY"
fi
mark=$(printf '\036')
if ! fp_text=$(
  {
    cat "$STATE_DIR/column.tsv"
    printf '%s' "$mark"
    cat "$STATE_DIR/constraint.tsv"
  } | node "$helper" --stdin
); then
  stop 1 "RESULT=UNCERTAIN" "PHASE=VERIFY"
fi
column_fp=$(printf '%s\n' "$fp_text" | awk -F= '$1=="column_fingerprint" { print $2; exit }')
constraint_fp=$(printf '%s\n' "$fp_text" | awk -F= '$1=="constraint_fingerprint" { print $2; exit }')
rm -f "$STATE_DIR/column.sql" "$STATE_DIR/constraint.sql" "$STATE_DIR/column.tsv" "$STATE_DIR/constraint.tsv"
if [ "$column_fp" != "$WANT_COLUMN_FP" ] || [ "$constraint_fp" != "$WANT_CONSTRAINT_FP" ]; then
  stop 1 "RESULT=INSPECT_MISMATCH" "PHASE=VERIFY"
fi

role_sql="$STATE_DIR/roles.sql"
cat > "$role_sql" <<SQL
ALTER ROLE stell22_app WITH LOGIN PASSWORD '${APP_PW}';
ALTER ROLE stell22_migrator WITH LOGIN PASSWORD '${MIG_PW}';
SQL
chmod 600 "$role_sql"
if ! docker exec -i "$CONTAINER" psql -X -U stell22 -d "$DB" -q -v ON_ERROR_STOP=1 --single-transaction -f - < "$role_sql" >/dev/null; then
  rm -f "$role_sql"
  stop 1 "RESULT=REFUSED_ROLE" "PHASE=ROLE"
fi
rm -f "$role_sql"
write_phase ROLE

db_owner=$(trim "$(psql_at "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DB}'")")
schema_owner=$(trim "$(psql_at "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'")")
members=$(trim "$(psql_at "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname IN ('stell22_app', 'stell22_migrator')")")
stray=$(trim "$(psql_at "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','i','I') AND pg_get_userbyid(c.relowner) <> 'stell22_migrator'")")
stray_routines=$(trim "$(psql_at "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'stell22_migrator'")")
owned=$(trim "$(psql_at "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND r.rolname = 'stell22_migrator'")")
app_owned=$(trim "$(psql_at "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'public' AND r.rolname = 'stell22_app'")")
app_routines=$(trim "$(psql_at "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner WHERE n.nspname = 'public' AND r.rolname = 'stell22_app'")")
schema_priv=$(trim "$(psql_at "SELECT CASE WHEN has_schema_privilege('stell22_app','public','USAGE') AND NOT has_schema_privilege('stell22_app','public','CREATE') AND NOT has_database_privilege('stell22_app','${DB}','CREATE') AND has_schema_privilege('stell22_migrator','public','USAGE') AND has_schema_privilege('stell22_migrator','public','CREATE') AND NOT has_database_privilege('stell22_migrator','${DB}','CREATE') THEN 'yes' ELSE 'no' END")")
dml=$(trim "$(psql_at "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname <> '_prisma_migrations' AND NOT (has_table_privilege('stell22_app', c.oid, 'SELECT') AND has_table_privilege('stell22_app', c.oid, 'INSERT') AND has_table_privilege('stell22_app', c.oid, 'UPDATE') AND has_table_privilege('stell22_app', c.oid, 'DELETE'))")")
history_priv=$(trim "$(psql_at "SELECT CASE WHEN has_table_privilege('stell22_app','public.\"_prisma_migrations\"','SELECT') AND NOT has_table_privilege('stell22_app','public.\"_prisma_migrations\"','INSERT') AND NOT has_table_privilege('stell22_app','public.\"_prisma_migrations\"','UPDATE') AND NOT has_table_privilege('stell22_app','public.\"_prisma_migrations\"','DELETE') AND NOT has_table_privilege('stell22_app','public.\"_prisma_migrations\"','TRUNCATE') THEN 'yes' ELSE 'no' END")")
state=$(psql_at "SELECT rolname || '|' || rolsuper::int || rolcreatedb::int || rolcreaterole::int || rolinherit::int || rolcanlogin::int || rolreplication::int || rolbypassrls::int || '|' || CASE WHEN rolpassword IS NULL THEN 'nopw' ELSE 'pw' END FROM pg_authid WHERE rolname IN ('stell22_app', 'stell22_migrator') ORDER BY rolname")
expected_state=$(printf 'stell22_app|0000100|pw\nstell22_migrator|0000100|pw')
if [ "$db_owner" != "stell22" ] || [ "$schema_owner" = "stell22_app" ] || [ "$schema_owner" = "stell22_migrator" ] || [ "$members" != "0" ] || [ "$stray" != "0" ] || [ "$stray_routines" != "0" ] || [ "$owned" != "$WANT_TABLES" ] || [ "$app_owned" != "0" ] || [ "$app_routines" != "0" ] || [ "$schema_priv" != "yes" ] || [ "$dml" != "0" ] || [ "$history_priv" != "yes" ] || [ "$state" != "$expected_state" ]; then
  stop 1 "RESULT=REFUSED_ROLE" "PHASE=ROLE"
fi

probe="BEGIN; INSERT INTO public.\"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('writer_exclusion_probe', 'x', 'writer_exclusion_probe', NOW(), 0); ROLLBACK;"
probe_line='ERROR:  42501: permission denied for table _prisma_migrations'
probe_status=0
PGPASSWORD="$APP_PW" docker exec -e PGPASSWORD -i "$CONTAINER" \
  psql -X -U stell22_app -d "$DB" -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
  -c "$probe" >"$STATE_DIR/probe.out" 2>"$STATE_DIR/probe.err" || probe_status=$?
if [ "$probe_status" = "0" ]; then
  stop 1 "RESULT=REFUSED_APP_DDL" "PHASE=ROLE"
fi
if ! grep -x -F -q "$probe_line" "$STATE_DIR/probe.err"; then
  stop 1 "RESULT=UNCERTAIN" "PHASE=ROLE"
fi
rm -f "$STATE_DIR/probe.out" "$STATE_DIR/probe.err"

if printf '%s\n' "$(docker ps -a --format '{{.Names}}')" | grep -x -q -e stell22-app -e stell22-caddy; then
  stop 1 "RESULT=REFUSED_WRITER" "PHASE=ROLE"
fi

write_phase READY
stop 0 \
  "RESULT=RECOVERY_READY" \
  "PHASE=READY" \
  "PUBLIC_TABLES=$tables" \
  "PUBLIC_CONSTRAINTS=$constraints" \
  "MIGRATION_ROWS=$migrations" \
  "SOURCE_ROWS=$rows" \
  "IMAGE_REF=$IMAGE_REF" \
  "INDEX_DIGEST=$INDEX_DIGEST"
