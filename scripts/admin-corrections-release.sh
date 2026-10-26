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
DECIDE="${STELL22_AC_DECIDE:-src/server/internal/admin-corrections-release/decide.mjs}"
COMPOSE_FILE="docker-compose.prod.yml"
INSPECT_APP="stell22-ac-inspect"

cd "$(dirname "$0")/.."
if [ -n "${STELL22_AC_APP_DIR:-}" ]; then
  cd "$STELL22_AC_APP_DIR"
fi
# shellcheck disable=SC1090
. "${STELL22_AC_DIAGNOSTICS:-./scripts/release-diagnostics.sh}"

work=""
diag="${STELL22_AC_DIAG_DIR:-}"
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
handled_exit=0
session_state=unknown
process_check_ok=0
target_objects_absent=0
schema_compared=0
old_image_identity=0
unexpected_writes=1
session_clear=0
processes_clear=0
facts_mode=0
db_id_before=""
caddy_id_before=""
legacy_image=""
app_image=""
runtime_docker=0
runtime_image=""
runtime_ready=0
runtime_container=""
decision_status=0
decision_file=""
pin_status=""

if [ "${STELL22_ADMIN_CORRECTIONS_DISPOSABLE:-}" = "1" ]; then
  disposable=1
  database="${STELL22_AC_DATABASE:-}"
  db_container="${STELL22_AC_DB_CONTAINER:-}"
  app_container="${STELL22_AC_APP_CONTAINER:-acrel-app-00000000}"
  caddy_container="${STELL22_AC_CADDY_CONTAINER:-acrel-caddy-00000000}"
  inspect_user="${STELL22_AC_INSPECT_USER:-}"
  hold_tag="acrel-legacy-${STELL22_AC_DATABASE#acrel_}:hold"
fi

on_signal() {
  trap '' HUP INT TERM
  handled_exit=1
  echo "RESULT=STOP_SIGNAL" >&2
  echo "DATABASE_RESTORE=NO" >&2
  echo "RETRY_MIGRATION=NO" >&2
  echo "OLD_IMAGE_RESTART=NO" >&2
  if [ "$migration_attempted" = 1 ]; then
    echo "FORWARD_RECOVERY=YES" >&2
  elif [ "$app_stopped" != 1 ]; then
    echo "APP_UNCHANGED=YES" >&2
  fi
  release_redact_diag
  if [ -n "${work:-}" ]; then
    release_redact_file "$work/migrate.log"
  fi
  if [ -n "${diag:-}" ]; then
    release_redact_file "$diag/migrate.log"
  fi
  exit 1
}
on_exit() {
  status=$?
  trap '' EXIT HUP INT TERM
  if [ "$handled_exit" != 1 ] && [ "$status" != 0 ]; then
    echo "RESULT=STOP_UNEXPECTED"
    echo "DATABASE_RESTORE=NO"
    echo "RETRY_MIGRATION=NO"
    if prove_old_restart; then
      if restart_old_image; then
        echo "OLD_IMAGE_RESTART=YES"
      else
        echo "OLD_IMAGE_RESTART=NO"
        echo "RESULT=STOP_OLD_RESTART"
      fi
    else
      echo "OLD_IMAGE_RESTART=NO"
      if [ "$migration_attempted" = 1 ]; then
        echo "FORWARD_RECOVERY=YES"
      elif [ "$app_stopped" != 1 ]; then
        echo "APP_UNCHANGED=YES"
      fi
    fi
    release_redact_diag
    if [ -n "${work:-}" ]; then
      release_redact_file "$work/migrate.log"
    fi
    if [ -n "${diag:-}" ]; then
      release_redact_file "$diag/migrate.log"
    fi
  fi
  if [ -n "${work:-}" ]; then
    rm -rf "$work"
  fi
  unset DATABASE_URL || true
}
trap on_signal HUP INT TERM
trap on_exit EXIT

refuse() {
  handled_exit=1
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

prove_runtime() {
  if [ "$phase" = "production" ]; then
    runtime_container=$app_container
  else
    runtime_container=${STELL22_AC_RUNTIME_CONTAINER:-}
  fi
  if [ "$phase" = "runtime-proof" ]; then
    case "$runtime_container" in
      acrel-app-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *) return 1 ;;
    esac
  fi
  if [ -z "$runtime_container" ]; then
    return 1
  fi
  runtime_image=$(docker inspect -f '{{.Image}}' "$runtime_container" 2>/dev/null) || return 1
  case "$runtime_image" in
    sha256:*) ;;
    *) return 1 ;;
  esac
  docker image inspect "$runtime_image" >/dev/null 2>&1 || return 1
  if docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$runtime_image" | awk -F= '
    $1 == "DATABASE_URL" || index($1, "PASSWORD") || index($1, "SECRET") {
      if (length($2) > 0) found = 1
    }
    END { exit found ? 0 : 1 }
  '; then
    return 1
  fi
  MSYS_NO_PATHCONV=1 docker run --rm --network none --pull never --read-only --tmpfs /tmp \
    --entrypoint node \
    "$runtime_image" -e 'process.exit(0)' >/dev/null 2>&1 || return 1
  runtime_ready=1
}

runtime_node() {
  if [ "$runtime_ready" != 1 ] || [ -z "$runtime_image" ]; then
    return 1
  fi
  runtime_stage="$work/runtime-stage"
  rm -rf "$runtime_stage"
  mkdir -p "$runtime_stage"
  chmod 700 "$runtime_stage" || return 1
  runtime_script=$1
  shift
  if [ ! -f "$runtime_script" ]; then
    return 1
  fi
  cp "$runtime_script" "$runtime_stage/decide.mjs" || return 1
  chmod 600 "$runtime_stage/decide.mjs" || return 1
  : > "$work/runtime-argv"
  printf '%s\n' /opt/stell22-ac/decide.mjs >> "$work/runtime-argv"
  runtime_n=0
  for runtime_arg in "$@"; do
    if [ -f "$runtime_arg" ] || [ -d "$runtime_arg" ]; then
      case "$runtime_arg" in
        *" "*|*"'"*|*"$"*|*'\\'*) return 1 ;;
      esac
    fi
    if [ -f "$runtime_arg" ]; then
      runtime_n=$((runtime_n + 1))
      cp "$runtime_arg" "$runtime_stage/f$runtime_n" || return 1
      chmod 600 "$runtime_stage/f$runtime_n" || return 1
      printf '%s\n' "/opt/stell22-ac/f$runtime_n" >> "$work/runtime-argv"
    elif [ -d "$runtime_arg" ]; then
      runtime_n=$((runtime_n + 1))
      mkdir -p "$runtime_stage/d$runtime_n" || return 1
      cp -a "$runtime_arg"/. "$runtime_stage/d$runtime_n"/ || return 1
      find "$runtime_stage/d$runtime_n" -type d -exec chmod 700 {} \; || return 1
      find "$runtime_stage/d$runtime_n" -type f -exec chmod 600 {} \; || return 1
      printf '%s\n' "/opt/stell22-ac/d$runtime_n" >> "$work/runtime-argv"
    else
      case "$runtime_arg" in
        *" "*|*"'"*) return 1 ;;
      esac
      printf '%s\n' "$runtime_arg" >> "$work/runtime-argv"
    fi
  done
  set --
  while IFS= read -r runtime_arg; do
    set -- "$@" "$runtime_arg"
  done < "$work/runtime-argv"
  runtime_mount=$runtime_stage
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*)
      if command -v cygpath >/dev/null 2>&1; then
        runtime_mount=$(cygpath -w "$runtime_stage")
      fi
      ;;
  esac
  runtime_status=0
  MSYS_NO_PATHCONV=1 docker run --rm --network none --pull never --read-only --tmpfs /tmp \
    --entrypoint node \
    -v "${runtime_mount}:/opt/stell22-ac:ro" \
    "$runtime_image" "$@" || runtime_status=$?
  rm -rf "$runtime_stage"
  return "$runtime_status"
}

decide_exec() {
  if [ "$runtime_docker" = 1 ]; then
    runtime_node "$DECIDE" "$@"
    return
  fi
  command node "$DECIDE" "$@"
}

capture_decision() {
  decision_file=$1
  shift
  decision_status=0
  decide_exec "$@" > "$decision_file" || decision_status=$?
  if [ ! -s "$decision_file" ]; then
    decision_status=127
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
  require_absent "${STELL22_AC_SESSION_STATUS:-}"
  require_absent "${STELL22_AC_SQL_FAIL:-}"
  require_absent "${STELL22_AC_PS_FAIL:-}"
  require_absent "${STELL22_AC_DIAG_DIR:-}"
  require_absent "${STELL22_AC_BACKUP_ROOT:-}"
  require_absent "${STELL22_AC_BACKUP_STDOUT:-}"
  require_absent "${STELL22_AC_BACKUP_BEFORE:-}"
  require_absent "${STELL22_AC_CHECKOUT_LOG:-}"
  require_absent "${STELL22_AC_SIGNAL_AT:-}"
  require_absent "${STELL22_AC_FAIL_AFTER_STOP:-}"
  require_absent "${STELL22_AC_FAIL_AFTER_MIGRATE:-}"
  require_absent "${STELL22_AC_GATE_ONLY:-}"
  require_absent "${STELL22_AC_RUNTIME_CONTAINER:-}"
  require_absent "${STELL22_AC_INVENTORY_DIR:-}"
  if [ "$phase" != "production" ]; then
    refuse STOP_LOCKED
  fi
else
  case "$phase" in
    migrate-only|fixture|backup-gate|gated|server-checkout|runtime-proof) ;;
    *) refuse STOP_LOCKED ;;
  esac
fi
if [ "$phase" = "fixture" ] || [ "$phase" = "gated" ]; then
  facts_mode=1
fi

work="$(mktemp -d)"
if [ "$phase" = "production" ] || [ "$phase" = "runtime-proof" ]; then
  runtime_docker=1
  if ! prove_runtime; then
    refuse STOP_RUNTIME
  fi
fi
cat > "$work/lock.env" <<EOF
execute=${STELL22_ADMIN_CORRECTIONS_EXECUTE:-}
maintenance=${STELL22_ADMIN_CORRECTIONS_MAINTENANCE:-}
authorization=${STELL22_ADMIN_CORRECTIONS_AUTHORIZATION:-}
restore=${STELL22_ADMIN_CORRECTIONS_RESTORE:-}
ci=${STELL22_ADMIN_CORRECTIONS_CI:-}
EOF
capture_decision "$work/lock.out" lock "$work/lock.env"
if [ "$decision_status" = 127 ]; then
  refuse STOP_RUNTIME
fi
if [ "$decision_status" != 0 ]; then
  code=$(awk -F= '$1 == "CODE" { print $2; exit }' "$work/lock.out" 2>/dev/null || true)
  if [ -z "$code" ]; then
    refuse STOP_RUNTIME
  fi
  refuse "$code"
fi

if [ "$phase" = "runtime-proof" ]; then
  inventory="${STELL22_AC_INVENTORY_DIR:-}"
  if [ -z "$inventory" ] || [ ! -d "$inventory" ]; then
    refuse STOP_RUNTIME
  fi
  capture_decision "$work/pinned-inventory.txt" inventory "$inventory"
  if [ "$decision_status" != 0 ]; then
    refuse STOP_RUNTIME
  fi
  count=$(grep -c . "$work/pinned-inventory.txt" || true)
  echo "PINNED_MIGRATIONS=$count"
  if [ "$count" != "47" ]; then
    refuse STOP_PENDING
  fi
  if ! docker stop "$runtime_container" >/dev/null; then
    refuse STOP_RUNTIME
  fi
  capture_decision "$work/lock.after" lock "$work/lock.env"
  if [ "$decision_status" != 0 ]; then
    refuse STOP_RUNTIME
  fi
  echo "RESULT=RUNTIME_OK"
  echo "RUNTIME_IMAGE=$runtime_image"
  echo "APP_STOPPED=1"
  echo "MIGRATION_ATTEMPTED=0"
  handled_exit=1
  exit 0
fi

if [ "$disposable" = 1 ]; then
  cat > "$work/identity.env" <<EOF
database=$database
dbContainer=$db_container
appContainer=$app_container
inspectUser=$inspect_user
EOF
  capture_decision "$work/identity.out" identity "$work/identity.env"
  if [ "$decision_status" = 127 ]; then
    refuse STOP_RUNTIME
  fi
  if [ "$decision_status" != 0 ]; then
    refuse STOP_LOCKED
  fi
fi

sha="${STELL22_ADMIN_CORRECTIONS_SHA:-}"
if [ "$phase" = "production" ] || [ "$phase" = "server-checkout" ]; then
  if ! git fetch origin main; then
    refuse STOP_CHECKOUT
  fi
  origin_main="$(git rev-parse origin/main)"
  if ! git cat-file -e "${sha}^{commit}"; then
    refuse STOP_CHECKOUT
  fi
  head="$(git rev-parse HEAD)"
  cat > "$work/sha.env" <<EOF
sha=$sha
originMain=$origin_main
head=$head
ci=${STELL22_ADMIN_CORRECTIONS_CI:-}
EOF
  capture_decision "$work/sha.out" remote-sha "$work/sha.env"
  if [ "$decision_status" = 127 ]; then
    refuse STOP_RUNTIME
  fi
  if [ "$decision_status" != 0 ]; then
    refuse STOP_CHECKOUT
  fi
  if git cat-file -e "${sha}:prisma/migrations/${MIGRATION_NAME}/migration.sql"; then
    blob_sha=$(git cat-file blob "${sha}:prisma/migrations/${MIGRATION_NAME}/migration.sql" | sha256sum | awk 'NR == 1 { print $1; exit }')
  else
    blob_sha=""
  fi
else
  origin_main="${STELL22_AC_ORIGIN_MAIN:-$sha}"
  head="${STELL22_AC_HEAD:-$sha}"
  cat > "$work/sha.env" <<EOF
sha=$sha
originMain=$origin_main
head=$head
ci=${STELL22_ADMIN_CORRECTIONS_CI:-}
EOF
  capture_decision "$work/sha.out" sha "$work/sha.env"
  if [ "$decision_status" = 127 ]; then
    refuse STOP_RUNTIME
  fi
  if [ "$decision_status" != 0 ]; then
    refuse STOP_CHECKOUT
  fi
  blob_sha=$(git cat-file blob "HEAD:prisma/migrations/${MIGRATION_NAME}/migration.sql" | sha256sum | awk 'NR == 1 { print $1; exit }')
fi
if [ -n "$blob_sha" ] && [ "$blob_sha" != "$MIGRATION_SHA256" ]; then
  refuse STOP_CHECKSUM
fi

# RESTART_OLD_IMAGE_BEGIN
restart_old_image() {
  docker start "$app_container" >/dev/null
}
# RESTART_OLD_IMAGE_END

fact_value() {
  key=$1
  file=$2
  awk -F= -v wanted="$key" '$1 == wanted { print $2; exit }' "$file"
}

schema_objects_absent() {
  file=$1
  key=""
  value=""
  for key in batchPackageEdit productionOperationCancellation cancelledAtPresent indexProductionOperationCancelledAt indexBatchRequest indexBatchBatchRecorded indexCancelRequest indexCancelOperation indexCancelOperationRecorded; do
    value=$(fact_value "$key" "$file")
    if [ "$value" != "false" ] && [ "$value" != "0" ]; then
      return 1
    fi
  done
  return 0
}

sentinels_match() {
  key=""
  left=""
  right=""
  for key in sentinelProductionOperation sentinelInventoryMovement; do
    left=$(fact_value "$key" "$1")
    right=$(fact_value "$key" "$2")
    if [ -z "$left" ] || [ "$left" != "$right" ]; then
      return 1
    fi
  done
  return 0
}

normalize_archive() {
  target=$1
  parent=$(dirname "$target")
  name=$(basename "$target")
  if [ ! -d "$parent" ]; then
    return 1
  fi
  (CDPATH= cd "$parent" && printf '%s/%s\n' "$(pwd -P)" "$name")
}

require_schema_absent() {
  out=$1
  when=$2
  write_schema "$out" "$when" || return 1
  schema_objects_absent "$out"
}

verify_published_backup() {
  success_file=$1
  before_file=$2
  line=""
  archive=""
  base=""
  sumfile=""
  recorded_name=""
  recorded_hash=""
  count=0
  dir=""
  if [ ! -f "$success_file" ] || [ ! -f "$before_file" ]; then
    return 1
  fi
  count=$(grep -c 'BACKUP SUCCESS:' "$success_file" || true)
  if [ "$count" != "1" ]; then
    return 1
  fi
  line=$(grep 'BACKUP SUCCESS:' "$success_file")
  archive=${line#*BACKUP SUCCESS: }
  archive=${archive#"${archive%%[![:space:]]*}"}
  archive=${archive%"${archive##*[![:space:]]}"}
  case "$archive" in
    *stell22_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9].sql.gz) ;;
    *) return 1 ;;
  esac
  published_norm=$(normalize_archive "$archive") || return 1
  while IFS= read -r prior || [ -n "$prior" ]; do
    [ -n "$prior" ] || continue
    prior_norm=$(normalize_archive "$prior") || return 1
    if [ "$prior_norm" = "$published_norm" ]; then
      return 1
    fi
  done < "$before_file"
  base=$(basename "$archive")
  sumfile="${archive}.sha256"
  if [ ! -f "$archive" ] || [ ! -f "$sumfile" ]; then
    return 1
  fi
  recorded_hash=$(awk 'NR == 1 { print $1; exit }' "$sumfile")
  recorded_name=$(awk 'NR == 1 { print $2; exit }' "$sumfile")
  case "$recorded_name" in
    \**) recorded_name=${recorded_name#\*} ;;
  esac
  if [ "$recorded_name" != "$base" ]; then
    return 1
  fi
  printf '%s\n' "$recorded_hash" | grep -Eq '^[0-9a-f]{64}$' || return 1
  dir=$(dirname "$archive")
  (CDPATH= cd "$dir" && sha256sum -c "$(basename "$sumfile")") >/dev/null 2>&1
}

if [ "$phase" = "backup-gate" ]; then
  if verify_published_backup "${STELL22_AC_BACKUP_STDOUT:-}" "${STELL22_AC_BACKUP_BEFORE:-}"; then
    handled_exit=1
    echo "RESULT=BACKUP_OK"
    exit 0
  fi
  handled_exit=1
  echo "RESULT=STOP_BACKUP"
  echo "DATABASE_RESTORE=NO"
  echo "OLD_IMAGE_RESTART=NO"
  exit 1
fi

finish() {
  stage=$1
  code=$2
  if [ "$stage" = "after-stop" ]; then
    if ! prove_old_restart; then
      :
    fi
  fi
  cat > "$work/recovery.env" <<EOF
stage=$stage
historyUnchanged=$history_unchanged
schemaUnchanged=$schema_unchanged
targetObjectsAbsent=$target_objects_absent
schemaCompared=$schema_compared
oldImageIdentity=$old_image_identity
unexpectedWrites=$unexpected_writes
sessionClear=$session_clear
processesClear=$processes_clear
migrationAttempted=$migration_attempted
oldImageAppOnly=$old_image_app_only
EOF
  capture_decision "$work/recovery.decision" recovery "$work/recovery.env"
  if [ "$decision_status" = 127 ]; then
    echo "RESULT=STOP_RUNTIME"
    echo "DATABASE_RESTORE=NO"
    echo "RETRY_MIGRATION=NO"
    echo "OLD_IMAGE_RESTART=NO"
    handled_exit=1
    exit 1
  fi
  action=$(awk -F= '$1 == "ACTION" { print $2; exit }' "$work/recovery.decision")
  echo "RESULT=$code"
  echo "DATABASE_RESTORE=NO"
  echo "RETRY_MIGRATION=NO"
  case "$action" in
    restart-old)
      if [ "$app_stopped" != 1 ] || [ "$migration_attempted" = 1 ]; then
        echo "OLD_IMAGE_RESTART=NO"
        echo "RESULT=STOP_OLD_RESTART"
        handled_exit=1
        exit 1
      fi
      if ! restart_old_image; then
        echo "OLD_IMAGE_RESTART=NO"
        echo "RESULT=STOP_OLD_RESTART"
        handled_exit=1
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
    forward-recovery)
      echo "OLD_IMAGE_RESTART=NO"
      echo "FORWARD_RECOVERY=YES"
      ;;
    *)
      echo "OLD_IMAGE_RESTART=NO"
      ;;
  esac
  handled_exit=1
  exit 1
}

prove_old_restart() {
  history_unchanged=0
  schema_unchanged=0
  target_objects_absent=0
  schema_compared=0
  old_image_identity=0
  unexpected_writes=1
  session_clear=0
  processes_clear=0
  if [ "$migration_attempted" = 1 ] || [ "$app_stopped" != 1 ] || [ "$old_image_app_only" != 1 ]; then
    return 1
  fi
  if [ ! -f "$work/history.before" ] || [ ! -f "$work/schema.before" ]; then
    return 1
  fi
  if ! confirm_old_image; then
    return 1
  fi
  if ! note_processes; then
    process_check_ok=0
    return 1
  fi
  process_check_ok=1
  if ! read_sessions "$work/sessions.prove"; then
    session_state=failed
    return 1
  fi
  if [ -s "$work/sessions.prove" ]; then
    session_state=present
  else
    session_state=clear
  fi
  if [ "$session_state" != "clear" ]; then
    return 1
  fi
  if [ "$backup_running" != 0 ] || [ "$import_running" != 0 ] || [ "$migrate_process" != 0 ] || [ "$conflicting" != 0 ]; then
    return 1
  fi
  session_clear=1
  processes_clear=1
  if ! write_history "$work/history.prove"; then
    return 1
  fi
  if cmp -s "$work/history.before" "$work/history.prove"; then
    history_unchanged=1
  fi
  if ! write_schema "$work/schema.prove" recheck; then
    return 1
  fi
  schema_compared=1
  if cmp -s "$work/schema.before" "$work/schema.prove"; then
    schema_unchanged=1
  fi
  if schema_objects_absent "$work/schema.before" && schema_objects_absent "$work/schema.prove"; then
    target_objects_absent=1
  fi
  if sentinels_match "$work/schema.before" "$work/schema.prove"; then
    unexpected_writes=0
  fi
  [ "$history_unchanged" = 1 ] && [ "$schema_unchanged" = 1 ] && [ "$target_objects_absent" = 1 ] && [ "$unexpected_writes" = 0 ] && [ "$old_image_identity" = 1 ] && [ "$session_clear" = 1 ] && [ "$processes_clear" = 1 ]
}

confirm_old_image() {
  now=""
  entry=""
  if [ "$facts_mode" = 1 ]; then
    if [ "$old_image_app_only" != 1 ]; then
      return 1
    fi
    old_image_identity=1
    return 0
  fi
  now=$(docker inspect -f '{{.Image}}' "$app_container") || return 1
  if [ -z "$legacy_image" ] || [ "$now" != "$legacy_image" ]; then
    return 1
  fi
  entry=$(docker image inspect --format '{{json .Config.Entrypoint}}' "$now") || return 1
  case "$entry" in
    *docker-entrypoint-app-only.sh*) ;;
    *) return 1 ;;
  esac
  case "$entry" in
    *"prisma migrate"*) return 1 ;;
  esac
  old_image_identity=1
  return 0
}

note_processes() {
  backup_running=0
  import_running=0
  migrate_process=0
  conflicting=0
  if [ "${STELL22_AC_PS_FAIL:-}" = "after-stop" ] && [ "$app_stopped" = 1 ]; then
    return 1
  fi
  if [ "$facts_mode" = 1 ]; then
    if [ "$app_stopped" = 1 ] && [ -f "${STELL22_AC_FACTS_DIR:-}/processes.now" ]; then
      cp "$STELL22_AC_FACTS_DIR/processes.now" "$work/processes.txt"
    elif [ -f "${STELL22_AC_FACTS_DIR:-}/processes.txt" ]; then
      cp "$STELL22_AC_FACTS_DIR/processes.txt" "$work/processes.txt"
    else
      : > "$work/processes.txt"
    fi
  else
    ps -eo args > "$work/processes.txt" 2>/dev/null || ps > "$work/processes.txt" || return 1
  fi
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
  if [ "$facts_mode" = 1 ]; then
    if [ "${STELL22_AC_SQL_FAIL:-}" = "after-stop" ] && [ "$app_stopped" = 1 ]; then
      return 1
    fi
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
  if [ "$facts_mode" = 1 ]; then
    if [ "${STELL22_AC_SQL_FAIL:-}" = "after-stop" ] && [ "$app_stopped" = 1 ]; then
      return 1
    fi
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
  if [ "$facts_mode" = 1 ]; then
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

write_schema() {
  out=$1
  when=$2
  if [ "$facts_mode" = 1 ]; then
    if [ "${STELL22_AC_SQL_FAIL:-}" = "preflight" ] && [ "$app_stopped" != 1 ]; then
      return 1
    fi
    if [ "${STELL22_AC_SQL_FAIL:-}" = "after-stop" ] && [ "$app_stopped" = 1 ]; then
      return 1
    fi
    if [ "$when" = "recheck" ] && [ -f "$STELL22_AC_FACTS_DIR/schema.now" ]; then
      cp "$STELL22_AC_FACTS_DIR/schema.now" "$out"
      return 0
    fi
    cp "$STELL22_AC_FACTS_DIR/schema.env" "$out"
    return 0
  fi
  cat > "$work/schema.sql" <<'SQL'
SELECT 'batchPackageEdit=' || (to_regclass('public."BatchPackageEditCommand"') IS NOT NULL)::text
UNION ALL
SELECT 'productionOperationCancellation=' || (to_regclass('public."ProductionOperationCancellation"') IS NOT NULL)::text
UNION ALL
SELECT 'cancelledAtPresent=' || EXISTS (
  SELECT 1 FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'ProductionOperation' AND a.attname = 'cancelledAt' AND a.attnum > 0 AND NOT a.attisdropped
)::text
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
SELECT 'sentinelProductionOperation=' || (SELECT count(*)::text FROM public."ProductionOperation")
UNION ALL
SELECT 'sentinelInventoryMovement=' || (SELECT count(*)::text FROM public."InventoryMovement")
SQL
  run_sql "$work/schema.sql" > "$out"
}

read_sessions() {
  out=$1
  if [ "$facts_mode" = 1 ]; then
    if [ "${STELL22_AC_SESSION_STATUS:-0}" != "0" ]; then
      return 1
    fi
    cat "$STELL22_AC_FACTS_DIR/sessions.txt" > "$out"
    return 0
  fi
  cat > "$work/sessions.sql" <<'SQL'
SELECT COALESCE(usename, '') || '|' || COALESCE(application_name, '') || '|' || backend_type
FROM pg_stat_activity
WHERE datname = current_database() AND backend_type = 'client backend'
SQL
  if ! run_sql "$work/sessions.sql" > "$work/sessions.raw"; then
    return 1
  fi
  if [ ! -f "$work/sessions.raw" ]; then
    return 1
  fi
  awk -F'|' -v app="$INSPECT_APP" '$2 != app { print }' "$work/sessions.raw" > "$out"
}

unexpected_sessions() {
  read_sessions "$work/sessions.filtered"
  if [ -f "$work/sessions.filtered" ]; then
    cat "$work/sessions.filtered"
  fi
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
  capture_decision "$work/url-assert.out" assert-url "$url_file" "$mode"
  if [ "$decision_status" = 127 ]; then
    return 2
  fi
  if [ "$decision_status" != 0 ]; then
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

pin_target_inventory() {
  pin="$work/pinned-tree"
  resolved=""
  target_sum=""
  count=0
  pin_status=unreadable
  rm -rf "$pin"
  mkdir -p "$pin"
  chmod 700 "$pin" || return 1
  resolved=$(git rev-parse --verify "${sha}^{commit}") || return 1
  if [ "$resolved" != "$sha" ]; then
    return 1
  fi
  if ! git archive --format=tar "$sha" prisma/migrations > "$work/pinned.tar"; then
    return 1
  fi
  if ! tar -xf "$work/pinned.tar" -C "$pin"; then
    return 1
  fi
  if [ ! -d "$pin/prisma/migrations" ]; then
    return 1
  fi
  find "$pin" -type d -exec chmod 700 {} \; || return 1
  find "$pin" -type f -exec chmod 600 {} \; || return 1
  capture_decision "$work/pinned-inventory.txt" inventory "$pin/prisma/migrations"
  if [ "$decision_status" = 127 ]; then
    pin_status=runtime
    return 1
  fi
  if [ "$decision_status" != 0 ]; then
    return 1
  fi
  count=$(grep -c . "$work/pinned-inventory.txt" || true)
  if [ "$count" != "47" ]; then
    pin_status=pending
    return 1
  fi
  target_sum=$(awk -v name="$MIGRATION_NAME" '$1 == name { print $2; exit }' "$work/pinned-inventory.txt")
  if [ "$target_sum" != "$MIGRATION_SHA256" ]; then
    pin_status=checksum
    return 1
  fi
  pin_status=ready
  return 0
}

compare_inventory() {
  if [ "$facts_mode" = 1 ]; then
    root=$(schema_root)
    capture_decision "$work/inventory.txt" inventory "$root/prisma/migrations"
    if [ "$decision_status" = 127 ]; then
      pin_status=runtime
      return 1
    fi
    if [ "$decision_status" != 0 ]; then
      return 1
    fi
  else
    if [ ! -s "$work/pinned-inventory.txt" ]; then
      return 1
    fi
    cp "$work/pinned-inventory.txt" "$work/inventory.txt"
  fi
  capture_decision "$2" compare "$work/inventory.txt" "$1"
  if [ "$decision_status" = 127 ]; then
    pin_status=runtime
    return 1
  fi
  return "$decision_status"
}

merge_facts() {
  cat "$1" "$2" > "$3"
}

decide_ok() {
  capture_decision "$3" "$1" "$2"
  if [ "$decision_status" = 127 ]; then
    printf '%s\n' 'OK=NO' 'CODE=STOP_RUNTIME' > "$3"
    return 1
  fi
  return "$decision_status"
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
  if [ "$runtime_ready" != 1 ] || [ "$legacy_image" != "$runtime_image" ]; then
    finish before-stop STOP_RUNTIME
  fi
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
  if [ "$phase" = "fixture" ] || [ "$phase" = "gated" ]; then
    # shellcheck disable=SC1091
    . "$STELL22_AC_FACTS_DIR/runtime.env"
  fi
fi

note_processes || finish before-stop STOP_WRITER
write_history "$work/history.before" || finish before-stop STOP_HISTORY
write_schema "$work/schema.before" baseline || finish before-stop STOP_SCHEMA
if [ "$facts_mode" != 1 ]; then
  pin_status=""
  if ! pin_target_inventory; then
    if [ "$pin_status" = "runtime" ]; then
      finish before-stop STOP_RUNTIME
    fi
    if [ "$pin_status" = "pending" ]; then
      finish before-stop STOP_PENDING
    fi
    if [ "$pin_status" = "checksum" ]; then
      finish before-stop STOP_CHECKSUM
    fi
    finish before-stop STOP_CHECKOUT
  fi
fi
compare_inventory "$work/history.before" "$work/history.env" || {
  if [ "$pin_status" = "runtime" ]; then
    finish before-stop STOP_RUNTIME
  fi
  finish before-stop STOP_HISTORY
}
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
schema_objects_absent "$work/schema.before" || finish before-stop STOP_SCHEMA

checkout_after_gate() {
  backup_hash=""
  restore_hash=""
  blob_now=""
  if [ "$disposable" = 1 ] && [ "$phase" != "server-checkout" ]; then
    if [ -z "${STELL22_AC_CHECKOUT_LOG:-}" ]; then
      return 1
    fi
    printf '%s\n' "$sha" >> "$STELL22_AC_CHECKOUT_LOG"
    return 0
  fi
  if [ ! -f scripts/backup-db.sh ] || [ ! -f scripts/restore-db.sh ]; then
    return 1
  fi
  sha256sum scripts/backup-db.sh > "$work/backup.protected" || return 1
  sha256sum scripts/restore-db.sh > "$work/restore.protected" || return 1
  sh "${STELL22_AC_CHECKOUT:-scripts/release-checkout.sh}" "$sha" > "$work/checkout.out" || return 1
  if [ "$(git rev-parse HEAD)" != "$sha" ]; then
    return 1
  fi
  backup_hash=$(sha256sum scripts/backup-db.sh) || return 1
  restore_hash=$(sha256sum scripts/restore-db.sh) || return 1
  if [ "$backup_hash" != "$(cat "$work/backup.protected")" ] || [ "$restore_hash" != "$(cat "$work/restore.protected")" ]; then
    return 1
  fi
  blob_now=$(git cat-file blob "HEAD:prisma/migrations/${MIGRATION_NAME}/migration.sql" | sha256sum | awk 'NR == 1 { print $1; exit }')
  if [ "$blob_now" != "$MIGRATION_SHA256" ]; then
    return 1
  fi
  write_history "$work/history.recheck" || return 1
  cmp -s "$work/history.before" "$work/history.recheck" || return 1
  write_privilege_facts "$work/privileges.recheck" || return 1
  cmp -s "$work/privileges.env" "$work/privileges.recheck" || return 1
  if [ ! -s "$work/pinned-inventory.txt" ]; then
    return 1
  fi
  capture_decision "$work/worktree-inventory.txt" inventory "$PWD/prisma/migrations"
  if [ "$decision_status" != 0 ]; then
    pin_status=runtime
    return 1
  fi
  cmp -s "$work/pinned-inventory.txt" "$work/worktree-inventory.txt"
}

if [ "$phase" = "production" ] || [ "$phase" = "gated" ] || [ "$phase" = "server-checkout" ]; then
  if [ "$phase" = "server-checkout" ]; then
    echo "CHECKOUT_BEFORE=$(git rev-parse HEAD)"
  fi
  checkout_status=0
  checkout_after_gate || checkout_status=$?
  if [ "$pin_status" = "runtime" ]; then
    finish before-stop STOP_RUNTIME
  fi
  if [ "$checkout_status" != 0 ]; then
    finish before-stop STOP_CHECKOUT
  fi
  if [ "$phase" = "gated" ] && [ "${STELL22_AC_GATE_ONLY:-}" = "1" ]; then
    handled_exit=1
    echo "RESULT=GATE_ACCEPTED"
    echo "CHECKOUT=YES"
    exit 0
  fi
  if [ "$phase" = "server-checkout" ]; then
    echo "CHECKOUT_AFTER=$(git rev-parse HEAD)"
    echo "PINNED_MIGRATIONS=$(grep -c . "$work/pinned-inventory.txt")"
    echo "RESULT=GATE_ACCEPTED"
    echo "CHECKOUT=YES"
    handled_exit=1
    exit 0
  fi
fi

if [ "$phase" = "migrate-only" ]; then
  history_unchanged=1
  schema_unchanged=1
  probe_status=0
  probe_login disposable "$STELL22_AC_URL_FILE" || probe_status=$?
  if [ "$probe_status" = 2 ]; then
    finish before-stop STOP_RUNTIME
  fi
  if [ "$probe_status" != 0 ]; then
    finish before-stop STOP_MIGRATOR
  fi
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
  if ! compare_inventory "$work/history.after" "$work/history.after.env"; then
    if [ "$pin_status" = "runtime" ]; then
      finish migration-uncertain STOP_RUNTIME
    fi
    finish migration-uncertain STOP_HISTORY
  fi
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
  handled_exit=1
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
  capture_decision "$work/url.out" assert-url "$work/migrator.url" production
  if [ "$decision_status" = 127 ]; then
    finish before-stop STOP_RUNTIME
  fi
  if [ "$decision_status" != 0 ]; then
    finish before-stop STOP_MIGRATOR
  fi
  probe_status=0
  probe_login production "$work/migrator.url" || probe_status=$?
  if [ "$probe_status" = 2 ]; then
    finish before-stop STOP_RUNTIME
  fi
  if [ "$probe_status" != 0 ]; then
    finish before-stop STOP_MIGRATOR
  fi
fi

require_schema_absent "$work/schema.prestop" baseline || finish before-stop STOP_SCHEMA

if [ "$phase" = "production" ]; then
  if ! docker stop "$app_container" >/dev/null; then
    finish after-stop STOP_WRITER
  fi
else
  if ! docker stop "$app_container" >/dev/null; then
    finish after-stop STOP_WRITER
  fi
fi
app_stopped=1
if [ "$disposable" = 1 ] && [ "${STELL22_AC_SIGNAL_AT:-}" = "after-stop" ]; then
  on_signal
fi
if [ "$disposable" = 1 ] && [ "${STELL22_AC_FAIL_AFTER_STOP:-}" = "1" ]; then
  false
fi
if [ "$phase" = "production" ]; then
  sleep_seconds=0
  while [ "$sleep_seconds" -lt 10 ]; do
    if ! read_sessions "$work/sessions.drain"; then
      session_state=failed
      finish after-stop STOP_WRITER
    fi
    if [ ! -s "$work/sessions.drain" ]; then
      break
    fi
    sleep 1
    sleep_seconds=$((sleep_seconds + 1))
  done
fi
if ! read_sessions "$work/sessions.now"; then
  session_state=failed
  finish after-stop STOP_WRITER
fi
if [ -s "$work/sessions.now" ]; then
  session_state=present
  unexpected=1
  inspection_only=0
else
  session_state=clear
  unexpected=0
  inspection_only=1
fi
if ! note_processes; then
  process_check_ok=0
  finish after-stop STOP_WRITER
fi
process_check_ok=1
cat > "$work/writers.env" <<EOF
appStopped=1
inspectionOnly=$inspection_only
unexpectedSessions=$unexpected
backupRunning=$backup_running
importRunning=$import_running
migrateProcess=$migrate_process
conflictingDeploy=$conflicting
sessionProbe=ok
EOF
if [ "$session_state" != "clear" ]; then
  finish after-stop STOP_WRITER
fi
if ! decide_ok writers "$work/writers.env" "$work/writers.out"; then
  finish after-stop STOP_WRITER
fi

if [ "$phase" = "fixture" ] || [ "$phase" = "gated" ]; then
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
  backup_root="${STELL22_AC_BACKUP_ROOT:-backups}"
  : > "$work/backups.before"
  if [ -d "$backup_root" ]; then
    if ! find "$backup_root" -maxdepth 1 -type f -name 'stell22_*.sql.gz' > "$work/backups.before"; then
      finish after-stop STOP_BACKUP
    fi
  fi
  sh scripts/backup-db.sh > "$work/backup.out" 2>&1 || backup_status=$?
  backup_ok=0
  checksum_ok=0
  if [ "$backup_status" = 0 ] && grep -q 'BACKUP SUCCESS:' "$work/backup.out"; then
    backup_ok=1
  fi
  if [ "$backup_ok" = 1 ] && verify_published_backup "$work/backup.out" "$work/backups.before"; then
    checksum_ok=1
  fi
fi
cat > "$work/backup.env" <<EOF
backupOk=$backup_ok
checksumOk=$checksum_ok
EOF
if ! decide_ok backup "$work/backup.env" "$work/backup.decision"; then
  finish after-stop STOP_BACKUP
fi

write_history "$work/history.ready" || finish after-stop STOP_HISTORY
write_schema "$work/schema.ready" recheck || finish after-stop STOP_SCHEMA
history_unchanged=0
schema_unchanged=0
target_objects_absent=0
if cmp -s "$work/history.before" "$work/history.ready"; then
  history_unchanged=1
fi
if cmp -s "$work/schema.before" "$work/schema.ready" && schema_objects_absent "$work/schema.before" && schema_objects_absent "$work/schema.ready"; then
  schema_unchanged=1
  target_objects_absent=1
fi
compare_inventory "$work/history.ready" "$work/history.ready.env" || {
  if [ "$pin_status" = "runtime" ]; then
    finish after-stop STOP_RUNTIME
  fi
  finish after-stop STOP_HISTORY
}
write_privilege_facts "$work/privileges.ready" || finish after-stop STOP_SCHEMA
if ! read_sessions "$work/sessions.ready"; then
  session_state=failed
  finish after-stop STOP_WRITER
fi
unexpected=0
if [ -s "$work/sessions.ready" ]; then
  unexpected=1
fi
if ! note_processes; then
  process_check_ok=0
  finish after-stop STOP_WRITER
fi
process_check_ok=1
migrator_ready=0
migrate_login=refused
if [ "$phase" = "fixture" ]; then
  migrator_ready=1
  migrate_login=stell22_migrator
else
  capture_decision "$work/url.ready" assert-url "$work/migrator.url" production
  if [ "$decision_status" = 127 ]; then
    finish after-stop STOP_RUNTIME
  fi
  if [ "$decision_status" = 0 ]; then
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

write_object_facts "$work/sentinels.before" || finish after-stop STOP_SCHEMA
sentinel_before_operation=$(awk -F= '$1 == "sentinelProductionOperation" { print $2; exit }' "$work/sentinels.before")
sentinel_before_movement=$(awk -F= '$1 == "sentinelInventoryMovement" { print $2; exit }' "$work/sentinels.before")
if [ "$disposable" = 1 ] && [ "${STELL22_AC_SIGNAL_AT:-}" = "during-migrate" ]; then
  migration_attempted=1
  on_signal
fi
if [ "$disposable" = 1 ] && [ "${STELL22_AC_FAIL_AFTER_MIGRATE:-}" = "1" ]; then
  migration_attempted=1
  false
fi
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
  if ! compare_inventory "$work/history.after" "$work/history.after.env"; then
    if [ "$pin_status" = "runtime" ]; then
      finish migration-uncertain STOP_RUNTIME
    fi
    finish migration-uncertain STOP_HISTORY
  fi
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
handled_exit=1
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
