#!/bin/sh
# Migration-only operator for 20261105120000_statement_period_coverage.
# Default is refusal. A phrase in this file is not permission to migrate.
# This does not start the application or Caddy, and it does not call
# scripts/statement-period-release.sh or scripts/beget-production-recovery.sh.
# One attempt is recorded before SQL. A later invocation does not retry.
set -eu
umask 077

if [ -n "${MSYSTEM:-}" ]; then
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
fi

AUTH_PHRASE=OWNER_AUTHORIZES_BEGET_MIGRATION_ONLY_47_48
HARNESS_PHRASE=OWNER_AUTHORIZES_BEGET_MIGRATION_HARNESS
REJECTED_RECOVERY=OWNER_AUTHORIZES_BEGET_INITIAL_RECOVERY_20261028
REJECTED_RELEASE=OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48
HOST_NAME=sonzutxkyv
MACHINE_ID=9cac56c437fa4bc1ba192da9567e79f2
HOST_IP=141.133.195.7
IMAGE_DIGEST=sha256:005c5c37db96c1e6652a79ea31f9886402fba81ac95dc2db897739121dd7f8f2
IMAGE_REF="postgres@${IMAGE_DIGEST}"
MIGRATION_NAME=20261105120000_statement_period_coverage
MIGRATION_SHA256=9625815128d45b4cf4397b6360ae5bf28ac4b3ef2033baefa4d85142f907c52e
MIGRATION_COUNT=48
PRODUCTION_CRED=/root/stell22-recovery/initial-recovery-authorization.env
PRODUCTION_RECOVERY=/root/stell22-recovery/beget-recovery.state
PRODUCTION_ATTEMPT=/root/stell22-recovery/beget-migration-only.state

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
work=""
urlfile=""
pass=""
log=""

finish() {
  result=$1
  status=$2
  shift 2
  printf '%s\n' "RESULT=$result" "$@" \
    "APPLICATION_STARTED=NO" \
    "CADDY_STARTED=NO" \
    "FEATURE_ACTIVATION=NO" \
    "RETRY_MIGRATION=NO" \
    "DNS_CHANGED=NO"
  exit "$status"
}

cleanup() {
  if [ -n "$urlfile" ] && [ -f "$urlfile" ]; then
    rm -f "$urlfile"
  fi
  if [ -n "$work" ] && [ -d "$work" ]; then
    rm -rf "$work"
  fi
}
trap cleanup EXIT

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

hex40() {
  case "$1" in
    *[!0-9a-f]*|"") return 1 ;;
  esac
  [ "${#1}" -eq 40 ]
}

hex64() {
  case "$1" in
    *[!0-9a-f]*|"") return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}

password_ok() {
  case "$1" in
    *[!A-Za-z0-9_-]*|"") return 1 ;;
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

mode_ok() {
  got=$(stat -c %a "$1" 2>/dev/null || true)
  case "$got" in
    600|0600) return 0 ;;
  esac
  return 1
}

world_writable() {
  got=$(stat -c %a "$1" 2>/dev/null || true)
  last=$(printf '%s' "$got" | awk '{ print substr($0, length($0), 1) }')
  case "$last" in
    2|3|6|7) return 0 ;;
  esac
  return 1
}

approved_database() {
  case "$1" in
    stell22|stell22_dev|stell22_integrity|stell22_smoke|stell22_inc001_dry) return 1 ;;
    p1disp_*|p1gate_*|p1as_*|p1rec_*|p1iso_*|acrel_*|stell22_restore_drill_*) return 0 ;;
  esac
  return 1
}

query_to() {
  out=$1
  sql=$2
  printf '%s\n' "$sql" > "$work/query.sql"
  set +e
  docker exec -i -e PGAPPNAME=stell22-statement-inspect "$CONTAINER" \
    psql -X -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 -At -f - \
    < "$work/query.sql" > "$out"
  query_status=$?
  set -e
  return "$query_status"
}

classify_file() {
  kind=$1
  input=$2
  set +e
  node "$(node_path "$ROOT/src/server/internal/statement-period-release/production.mjs")" "$kind" \
    < "$input" > "$work/classify.out"
  set -e
  awk -F= '$1=="CODE" { print $2; exit }' "$work/classify.out"
}

execute=${STELL22_BEGET_MIGRATION_EXECUTE:-}
auth=${STELL22_BEGET_MIGRATION_AUTHORIZATION:-}
scope=${STELL22_BEGET_MIGRATION_SCOPE:-}
supplied_sha=${STELL22_BEGET_MIGRATION_SHA:-}
supplied_tree=${STELL22_BEGET_MIGRATION_TREE:-}
if [ "$auth" = "$REJECTED_RECOVERY" ] || [ "$auth" = "$REJECTED_RELEASE" ]; then
  finish REFUSED_AUTHORIZATION 1
fi
if [ "$execute" != "1" ] || { [ "$auth" != "$AUTH_PHRASE" ] && [ "$auth" != "$HARNESS_PHRASE" ]; }; then
  finish REFUSED_AUTHORIZATION 1
fi
if [ -z "$scope" ] || [ -z "$supplied_sha" ] || [ -z "$supplied_tree" ]; then
  finish REFUSED_AUTHORIZATION 1
fi
if production_identity; then
  if [ "$auth" != "$AUTH_PHRASE" ] || [ "${STELL22_BEGET_MIGRATION_HARNESS:-}" = "1" ]; then
    finish REFUSED_HOST 1
  fi
  mode=production
else
  if [ "$auth" != "$HARNESS_PHRASE" ] || [ "${STELL22_BEGET_MIGRATION_HARNESS:-}" != "1" ]; then
    finish REFUSED_HOST 1
  fi
  mode=harness
fi
if [ "$scope" != "$MIGRATION_NAME" ]; then
  finish REFUSED_SCOPE 1
fi
if ! hex40 "$supplied_sha"; then
  finish REFUSED_SHA 1
fi
if ! hex40 "$supplied_tree"; then
  finish REFUSED_TREE 1
fi

if [ "$mode" = "production" ]; then
  PROJECT=/root/Stell22
  STATE_DIR=/root/stell22-recovery
  RECOVERY=$PRODUCTION_RECOVERY
  ATTEMPT=$PRODUCTION_ATTEMPT
  CRED=$PRODUCTION_CRED
  COMPOSE_PROJECT=stell22
  VOLUME=stell22_db-data
  CONTAINER=stell22-db-prod
  NETWORK=stell22_default
  DB=stell22
  EXPECT_IMAGE=$IMAGE_REF
  if [ "$ROOT" != "$PROJECT" ]; then
    finish REFUSED_SHA 1
  fi
  name=$(/bin/hostname)
  mid=$(trim "$(cat /etc/machine-id)")
  ips=$(/bin/hostname -I 2>/dev/null || true)
  if [ "$name" != "$HOST_NAME" ] || [ "$mid" != "$MACHINE_ID" ]; then
    finish REFUSED_HOST 1
  fi
  case " $ips " in
    *" $HOST_IP "*) ;;
    *) finish REFUSED_HOST 1 ;;
  esac
  if [ "$(stat -c %a "$STATE_DIR" 2>/dev/null || true)" != "700" ] || [ "$(stat -c %u "$STATE_DIR" 2>/dev/null || true)" != "0" ]; then
    finish REFUSED_RECOVERY 1
  fi
else
  PROJECT=${STELL22_BEGET_MIGRATION_PROJECT:-}
  STATE_DIR=${STELL22_BEGET_MIGRATION_STATE:-}
  RECOVERY=${STELL22_BEGET_MIGRATION_RECOVERY_STATE:-}
  ATTEMPT=${STELL22_BEGET_MIGRATION_ATTEMPT:-}
  CRED=${STELL22_BEGET_MIGRATION_CREDENTIALS:-}
  COMPOSE_PROJECT=${STELL22_BEGET_MIGRATION_COMPOSE_PROJECT:-}
  VOLUME=${STELL22_BEGET_MIGRATION_VOLUME:-}
  CONTAINER=${STELL22_BEGET_MIGRATION_CONTAINER:-}
  NETWORK=${STELL22_BEGET_MIGRATION_NETWORK:-}
  DB=${STELL22_BEGET_MIGRATION_DATABASE:-}
  EXPECT_IMAGE=${STELL22_BEGET_MIGRATION_EXPECT_IMAGE:-}
  if [ "$PROJECT" = "/root/Stell22" ] || [ "$STATE_DIR" = "/root/stell22-recovery" ] || [ "$RECOVERY" = "$PRODUCTION_RECOVERY" ] || [ "$ATTEMPT" = "$PRODUCTION_ATTEMPT" ] || [ "$CRED" = "$PRODUCTION_CRED" ]; then
    finish REFUSED_DOCKER 1
  fi
  if [ "$COMPOSE_PROJECT" = "stell22" ] || [ "$VOLUME" = "stell22_db-data" ] || [ "$CONTAINER" = "stell22-db-prod" ] || [ "$NETWORK" = "stell22_default" ] || [ "$DB" = "stell22" ]; then
    finish REFUSED_DOCKER 1
  fi
  if ! approved_database "$DB"; then
    finish REFUSED_DOCKER 1
  fi
  case "$EXPECT_IMAGE" in
    "$IMAGE_REF"|"docker.io/library/$IMAGE_REF") finish REFUSED_DOCKER 1 ;;
  esac
fi

head_sha=$(git_at "$PROJECT" rev-parse HEAD) || finish REFUSED_SHA 1
head_tree=$(git_at "$PROJECT" rev-parse 'HEAD^{tree}') || finish REFUSED_TREE 1
if [ "$head_sha" != "$supplied_sha" ]; then
  finish REFUSED_SHA 1
fi
if [ "$head_tree" != "$supplied_tree" ]; then
  finish REFUSED_TREE 1
fi
dirty=$(git_at "$PROJECT" status --porcelain) || finish REFUSED_CHECKOUT 1
if [ -n "$dirty" ]; then
  finish REFUSED_CHECKOUT 1
fi
if [ "$mode" = "production" ]; then
  recorded=$(git_at "$PROJECT" rev-parse "HEAD:scripts/beget-statement-migration-only.sh") || finish REFUSED_SHA 1
  current=$(git_at "$PROJECT" hash-object "$ROOT/scripts/beget-statement-migration-only.sh") || finish REFUSED_SHA 1
  if [ "$recorded" != "$current" ]; then
    finish REFUSED_SHA 1
  fi
fi

if [ -z "$RECOVERY" ] || [ -L "$RECOVERY" ] || [ ! -f "$RECOVERY" ]; then
  finish REFUSED_RECOVERY 1
fi
recovery_phase=$(awk -F= '$1=="phase" { n++; v=$2 } END { if (n!=1) exit 1; print v }' "$RECOVERY") || finish REFUSED_RECOVERY 1
if [ "$recovery_phase" != "READY" ]; then
  finish REFUSED_RECOVERY 1
fi
if [ -z "$CRED" ] || [ -L "$CRED" ] || [ ! -f "$CRED" ]; then
  finish REFUSED_CREDENTIALS 1
fi
if ! mode_ok "$CRED"; then
  finish REFUSED_CREDENTIALS 1
fi
cred_owner=$(stat -c %u "$CRED" 2>/dev/null || true)
if [ "$mode" = "production" ]; then
  if [ "$cred_owner" != "0" ]; then
    finish REFUSED_CREDENTIALS 1
  fi
  cred_parent=$(dirname "$CRED")
  if [ "$(stat -c %a "$cred_parent" 2>/dev/null || true)" != "700" ] || [ "$(stat -c %u "$cred_parent" 2>/dev/null || true)" != "0" ]; then
    finish REFUSED_CREDENTIALS 1
  fi
else
  if [ "$cred_owner" != "$(id -u)" ]; then
    finish REFUSED_CREDENTIALS 1
  fi
  if world_writable "$(dirname "$CRED")"; then
    finish REFUSED_CREDENTIALS 1
  fi
fi
pass=$(awk -F= 'BEGIN { n = 0 } $1=="STELL22_BEGET_RECOVERY_MIGRATOR_PASSWORD" { n++; v=substr($0, index($0, "=") + 1) } END { if (n != 1) exit 1; print v }' "$CRED") || finish REFUSED_CREDENTIALS 1
if ! password_ok "$pass"; then
  finish REFUSED_CREDENTIALS 1
fi

if [ -z "$ATTEMPT" ] || [ "$ATTEMPT" = "$RECOVERY" ]; then
  finish REFUSED_EXISTING_ATTEMPT 1 "PHASE=UNREADABLE" "OUTCOME=UNCERTAIN"
fi
if [ -e "$ATTEMPT" ] || [ -L "$ATTEMPT" ]; then
  attempt_phase=UNREADABLE
  if [ -f "$ATTEMPT" ] && [ ! -L "$ATTEMPT" ]; then
    attempt_phase=$(awk -F= '$1=="phase" { print $2; exit }' "$ATTEMPT" 2>/dev/null || true)
    [ -n "$attempt_phase" ] || attempt_phase=UNREADABLE
  fi
  attempt_outcome=UNCERTAIN
  if [ "$attempt_phase" = "READY" ]; then
    attempt_outcome=RECORDED
  fi
  finish REFUSED_EXISTING_ATTEMPT 1 "PHASE=$attempt_phase" "OUTCOME=$attempt_outcome"
fi

if ! command -v docker >/dev/null 2>&1 || ! docker version >/dev/null 2>&1; then
  finish REFUSED_DOCKER 1
fi
if ! names=$(docker ps -a --format '{{.Names}}'); then
  finish REFUSED_DATABASE 1
fi
if printf '%s\n' "$names" | grep -x -q -e stell22-app -e stell22-caddy -e caddy; then
  finish REFUSED_APP 1
fi
if [ "$(printf '%s\n' "$names" | awk 'NF { count++ } END { print count + 0 }')" != "1" ] || ! printf '%s\n' "$names" | grep -x -q -F "$CONTAINER"; then
  finish REFUSED_DATABASE 1
fi
running=$(docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null || true)
health=$(docker inspect "$CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' 2>/dev/null || true)
if [ "$(trim "$running")" != "true" ] || [ "$(trim "$health")" != "healthy" ]; then
  finish REFUSED_DATABASE 1
fi
project=$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
service=$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null || true)
oneoff=$(docker inspect "$CONTAINER" --format '{{index .Config.Labels "com.docker.compose.oneoff"}}' 2>/dev/null || true)
running_image=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || true)
mount=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{.Name}} {{.Destination}}{{println}}{{end}}' 2>/dev/null || true)
net=$(docker inspect "$CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{println}}{{end}}' 2>/dev/null || true)
ports=$(docker inspect "$CONTAINER" --format '{{json .HostConfig.PortBindings}}' 2>/dev/null || true)
if [ "$(trim "$project")" != "$COMPOSE_PROJECT" ] || [ "$(trim "$service")" != "db" ] || [ "$(trim "$oneoff")" != "False" ]; then
  finish REFUSED_DOCKER 1
fi
if [ "$(trim "$running_image")" != "$EXPECT_IMAGE" ]; then
  finish REFUSED_DOCKER 1
fi
if [ "$mode" = "production" ]; then
  case "$(trim "$running_image")" in
    "$IMAGE_REF"|"docker.io/library/$IMAGE_REF") ;;
    *) finish REFUSED_DOCKER 1 ;;
  esac
fi
printf '%s\n' "$mount" | grep -x -q -F "$VOLUME /var/lib/postgresql/data" || finish REFUSED_DOCKER 1
printf '%s\n' "$net" | grep -x -q -F "$NETWORK" || finish REFUSED_DOCKER 1
if [ "$(trim "$ports")" != "{}" ]; then
  finish REFUSED_DOCKER 1
fi

work=$(mktemp -d)
log="$STATE_DIR/beget-migration-only.log"
history_sql='/* stell22-migration-history */
SELECT migration_name || '"'"'|'"'"' || checksum || '"'"'|'"'"' || (finished_at IS NOT NULL) || '"'"'|'"'"' || (rolled_back_at IS NOT NULL) || '"'"'|'"'"' || applied_steps_count FROM "_prisma_migrations" ORDER BY migration_name;'
role_sql='/* stell22-migration-roles */
SELECT '"'"'serverVersionNum='"'"' || current_setting('"'"'server_version_num'"'"') UNION ALL SELECT '"'"'migratorLogin='"'"' || EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '"'"'stell22_migrator'"'"' AND rolcanlogin AND NOT rolsuper)::text UNION ALL SELECT '"'"'migratorSuper='"'"' || COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = '"'"'stell22_migrator'"'"')::text, '"'"'true'"'"') UNION ALL SELECT '"'"'appInsert='"'"' || has_table_privilege('"'"'stell22_app'"'"', '"'"'public."_prisma_migrations"'"'"', '"'"'INSERT'"'"')::text;'
session_sql='/* stell22-migration-sessions */
SELECT usename || '"'"'|'"'"' || COALESCE(application_name, '"'"''"'"') || '"'"'|'"'"' || backend_type FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = '"'"'client backend'"'"';'
count_sql='/* stell22-migration-statement-count */
SELECT count(*)::text FROM "Statement";'
column_sql='/* stell22-migration-columns */
SELECT column_name || '"'"'|'"'"' || is_nullable FROM information_schema.columns WHERE table_schema = '"'"'public'"'"' AND table_name = '"'"'Statement'"'"' AND column_name IN ('"'"'periodStart'"'"', '"'"'periodEnd'"'"', '"'"'source'"'"', '"'"'contentKey'"'"') ORDER BY column_name;'
index_sql='/* stell22-migration-index */
SELECT count(*)::text FROM pg_indexes WHERE schemaname = '"'"'public'"'"' AND indexname = '"'"'Statement_accountId_contentKey_key'"'"';'
check_sql='/* stell22-migration-check */
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = '"'"'Statement_verified_period_check'"'"';'

query_to "$work/history.txt" "$history_sql" || finish REFUSED_HISTORY 1 "DECISION=STOP_HISTORY_COUNT"
history_code=$(classify_file history-preflight "$work/history.txt")
case "$history_code" in
  OFFLINE_HISTORY_CONTRACT_MATCHED) ;;
  STOP_ALREADY_APPLIED) finish REFUSED_ALREADY_APPLIED 1 "DECISION=$history_code" ;;
  "") finish REFUSED_HISTORY 1 "DECISION=STOP_HISTORY_COUNT" ;;
  *) finish REFUSED_HISTORY 1 "DECISION=$history_code" ;;
esac
query_to "$work/roles.txt" "$role_sql" || finish REFUSED_ROLE 1
role_code=$(classify_file roles "$work/roles.txt")
if [ "$role_code" != "ROLES_OBSERVED" ]; then
  finish REFUSED_ROLE 1
fi
query_to "$work/sessions.txt" "$session_sql" || finish REFUSED_WRITER 1
ps -eo args > "$work/ps.txt" || finish REFUSED_WRITER 1
{
  printf '%s\n' SESSIONS
  cat "$work/sessions.txt"
  printf '%s\n' PROCESSES
  cat "$work/ps.txt"
} > "$work/writers.txt"
writer_code=$(classify_file writers-after "$work/writers.txt")
if [ "$writer_code" != "WRITERS_CURRENTLY_CLEAR" ]; then
  finish REFUSED_WRITER 1
fi
query_to "$work/rows.txt" "$count_sql" || finish REFUSED_SCHEMA 1
statement_rows=$(trim "$(cat "$work/rows.txt")")
case "$statement_rows" in
  *[!0-9]*|"") finish REFUSED_SCHEMA 1 ;;
esac
query_to "$work/columns.txt" "$column_sql" || finish REFUSED_SCHEMA 1
if [ -n "$(trim "$(cat "$work/columns.txt")")" ]; then
  finish REFUSED_SCHEMA 1
fi
query_to "$work/index.txt" "$index_sql" || finish REFUSED_SCHEMA 1
if [ "$(trim "$(cat "$work/index.txt")")" != "0" ]; then
  finish REFUSED_SCHEMA 1
fi
query_to "$work/check.txt" "$check_sql" || finish REFUSED_SCHEMA 1
if [ -n "$(trim "$(cat "$work/check.txt")")" ]; then
  finish REFUSED_SCHEMA 1
fi

cp -a "$ROOT/prisma" "$work/prisma"
cat > "$work/Dockerfile" <<'EOF'
FROM node:22-bookworm-slim
WORKDIR /app
RUN npm install prisma@6.19.3 --no-fund --no-audit
COPY prisma ./prisma
EOF
if [ "$mode" = "production" ]; then
  image_tag=stell22-beget-migration-only:candidate
else
  image_tag=stell22-beget-migration-only-harness:candidate
fi
if ! docker build -t "$image_tag" -f "$work/Dockerfile" "$work" > "$log" 2>&1; then
  chmod 600 "$log" 2>/dev/null || true
  finish REFUSED_IMAGE 1 "DETAIL=build"
fi
image_id=$(docker image inspect "$image_tag" --format '{{.Id}}' 2>/dev/null || true)
case "$image_id" in
  sha256:*) ;;
  *) finish REFUSED_IMAGE 1 "DETAIL=image-id" ;;
esac
if ! hex64 "$(printf '%s' "$image_id" | awk -F: 'NR==1 { print $2; exit }')"; then
  finish REFUSED_IMAGE 1 "DETAIL=image-hex"
fi
entrypoint=$(docker image inspect "$image_id" --format '{{json .Config.Entrypoint}}' 2>/dev/null || true)
cmd=$(docker image inspect "$image_id" --format '{{json .Config.Cmd}}' 2>/dev/null || true)
case "$entrypoint$cmd" in
  *docker-entrypoint-app-only*|*migrate*|*next*) finish REFUSED_IMAGE 1 "DETAIL=entrypoint" ;;
esac
if ! docker run --rm --network none --pull never --entrypoint cat "$image_id" "/app/prisma/migrations/$MIGRATION_NAME/migration.sql" > "$work/target.sql"; then
  finish REFUSED_CHECKSUM 1
fi
image_count=$(docker run --rm --network none --pull never --entrypoint sh "$image_id" -c 'find /app/prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql | wc -l' | tr -d '[:space:]')
if [ "$image_count" != "$MIGRATION_COUNT" ]; then
  finish REFUSED_IMAGE 1 "DETAIL=count"
fi
hash_out=$(node "$(node_path "$ROOT/scripts/beget-statement-migration-only-hash.mjs")" "$(node_path "$work/target.sql")" "$image_count") || finish REFUSED_CHECKSUM 1
hash_code=$(printf '%s\n' "$hash_out" | awk -F= '$1=="CODE" { print $2; exit }')
hash_value=$(printf '%s\n' "$hash_out" | awk -F= '$1=="SHA256" { print $2; exit }')
hash_name=$(printf '%s\n' "$hash_out" | awk -F= '$1=="NAME" { print $2; exit }')
if [ "$hash_code" != "CHECKSUM_MATCHED" ] || [ "$hash_value" != "$MIGRATION_SHA256" ] || [ "$hash_name" != "$MIGRATION_NAME" ]; then
  finish REFUSED_CHECKSUM 1
fi

urlfile="$work/migrator.env"
if [ "$mode" = "production" ]; then
  release_python=python3
  if ! command -v python3 >/dev/null 2>&1; then
    release_python=python
  fi
  if ! OUT="$urlfile" ROLE=stell22_migrator MIGRATOR_DB_PASSWORD="$pass" "$release_python" "$ROOT/scripts/release-migrator-url.py"; then
    finish REFUSED_CREDENTIALS 1
  fi
else
  printf 'DATABASE_URL=postgresql://stell22_migrator:%s@127.0.0.1:5432/%s?schema=public\n' "$pass" "$DB" > "$urlfile"
  chmod 600 "$urlfile"
  if ! MIG_REDACT=$pass node --input-type=module -e 'import fs from "node:fs"; const text = fs.readFileSync(process.argv[1], "utf8").trim(); const url = new URL(text.slice("DATABASE_URL=".length)); if (text.indexOf("DATABASE_URL=") !== 0 || url.username !== "stell22_migrator" || url.password !== (process.env.MIG_REDACT ?? "") || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.pathname !== "/" + process.argv[2] || url.search !== "?schema=public") process.exit(1);' "$(node_path "$urlfile")" "$DB"; then
    finish REFUSED_CREDENTIALS 1
  fi
fi
chmod 600 "$urlfile"

set +e
set -o noclobber
printf 'phase=ATTEMPTED\noutcome=UNRECORDED\nstatement_rows=%s\nimage=%s\nmigration=%s\n' "$statement_rows" "$image_id" "$MIGRATION_NAME" > "$ATTEMPT"
write_status=$?
set +o noclobber
set -e
if [ "$write_status" != 0 ]; then
  finish REFUSED_EXISTING_ATTEMPT 1 "PHASE=UNREADABLE" "OUTCOME=UNCERTAIN"
fi
chmod 600 "$ATTEMPT"

set +e
docker run --rm --network "container:${CONTAINER}" --pull never --entrypoint npx --env-file "$urlfile" "$image_id" prisma migrate deploy --schema=/app/prisma/schema.prisma > "$log" 2>&1
migrate_status=$?
set -e
if [ -f "$log" ]; then
  MIG_REDACT=$pass node --input-type=module -e 'import fs from "node:fs"; const file = process.argv[1]; const secret = process.env.MIG_REDACT ?? ""; let text = ""; try { text = fs.readFileSync(file, "utf8"); } catch { process.exit(0); } if (secret) text = text.split(secret).join("[redacted]"); text = text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]"); fs.writeFileSync(file, text);' "$(node_path "$log")" || true
  chmod 600 "$log"
fi
if [ "$migrate_status" != 0 ]; then
  printf 'phase=ATTEMPTED\noutcome=FAILED\nstatement_rows=%s\nimage=%s\nmigration=%s\nmigrate_exit=%s\n' "$statement_rows" "$image_id" "$MIGRATION_NAME" "$migrate_status" > "$ATTEMPT"
  chmod 600 "$ATTEMPT"
  finish MIGRATION_FAILED 1 "MIGRATE_EXIT=$migrate_status"
fi

query_to "$work/history-after.txt" "$history_sql" || {
  printf 'phase=ATTEMPTED\noutcome=VERIFY_FAILED\nstatement_rows=%s\nimage=%s\nmigration=%s\n' "$statement_rows" "$image_id" "$MIGRATION_NAME" > "$ATTEMPT"
  chmod 600 "$ATTEMPT"
  finish POST_VERIFY_FAILED 1 "DECISION=STOP_HISTORY_COUNT"
}
post_code=$(classify_file history-post "$work/history-after.txt")
if [ "$post_code" != "POST_MIGRATION_VERIFIED" ]; then
  printf 'phase=ATTEMPTED\noutcome=VERIFY_FAILED\nstatement_rows=%s\nimage=%s\nmigration=%s\n' "$statement_rows" "$image_id" "$MIGRATION_NAME" > "$ATTEMPT"
  chmod 600 "$ATTEMPT"
  finish POST_VERIFY_FAILED 1 "DECISION=$post_code"
fi
query_to "$work/columns-after.txt" "$column_sql" || finish POST_VERIFY_FAILED 1
expected_columns='contentKey|YES
periodEnd|YES
periodStart|YES
source|YES'
if [ "$(cat "$work/columns-after.txt")" != "$expected_columns" ]; then
  printf 'phase=ATTEMPTED\noutcome=VERIFY_FAILED\nstatement_rows=%s\nimage=%s\nmigration=%s\n' "$statement_rows" "$image_id" "$MIGRATION_NAME" > "$ATTEMPT"
  chmod 600 "$ATTEMPT"
  finish POST_VERIFY_FAILED 1
fi
query_to "$work/index-after.txt" "$index_sql" || finish POST_VERIFY_FAILED 1
if [ "$(trim "$(cat "$work/index-after.txt")")" != "1" ]; then
  finish POST_VERIFY_FAILED 1
fi
query_to "$work/check-after.txt" "$check_sql" || finish POST_VERIFY_FAILED 1
check_def=$(cat "$work/check-after.txt")
case "$check_def" in
  *BANK_1C*) ;;
  *) finish POST_VERIFY_FAILED 1 ;;
esac
case "$check_def" in
  *periodStart*) ;;
  *) finish POST_VERIFY_FAILED 1 ;;
esac
case "$check_def" in
  *periodEnd*) ;;
  *) finish POST_VERIFY_FAILED 1 ;;
esac
query_to "$work/rows-after.txt" "$count_sql" || finish POST_VERIFY_FAILED 1
if [ "$(trim "$(cat "$work/rows-after.txt")")" != "$statement_rows" ]; then
  finish POST_VERIFY_FAILED 1
fi
query_to "$work/roles-after.txt" "$role_sql" || finish POST_VERIFY_FAILED 1
if [ "$(classify_file roles "$work/roles-after.txt")" != "ROLES_OBSERVED" ]; then
  finish POST_VERIFY_FAILED 1
fi
query_to "$work/sessions-after.txt" "$session_sql" || finish POST_VERIFY_FAILED 1
ps -eo args > "$work/ps-after.txt" || finish POST_VERIFY_FAILED 1
{
  printf '%s\n' SESSIONS
  cat "$work/sessions-after.txt"
  printf '%s\n' PROCESSES
  cat "$work/ps-after.txt"
} > "$work/writers-after.txt"
if [ "$(classify_file writers-after "$work/writers-after.txt")" != "WRITERS_CURRENTLY_CLEAR" ]; then
  finish POST_VERIFY_FAILED 1
fi
if ! names_after=$(docker ps -a --format '{{.Names}}'); then
  finish POST_VERIFY_FAILED 1
fi
if printf '%s\n' "$names_after" | grep -x -q -e stell22-app -e stell22-caddy -e caddy; then
  finish POST_VERIFY_FAILED 1
fi
if [ "$(printf '%s\n' "$names_after" | awk 'NF { count++ } END { print count + 0 }')" != "1" ]; then
  finish POST_VERIFY_FAILED 1
fi

printf 'phase=READY\noutcome=VERIFIED\nstatement_rows=%s\nimage=%s\nmigration=%s\n' "$statement_rows" "$image_id" "$MIGRATION_NAME" > "$ATTEMPT"
chmod 600 "$ATTEMPT"
finish MIGRATION_READY 0 \
  "PHASE=READY" \
  "MIGRATIONS_BEFORE=47" \
  "MIGRATIONS_AFTER=48" \
  "INCOMPLETE=0" \
  "PENDING=0" \
  "TARGET=$MIGRATION_NAME" \
  "TARGET_SHA256=$MIGRATION_SHA256" \
  "STATEMENT_ROWS_UNCHANGED=YES"
