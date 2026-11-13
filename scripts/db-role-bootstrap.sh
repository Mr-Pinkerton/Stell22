#!/bin/sh
# Prepare stell22_app and stell22_migrator on the disposable database restored
# from the 2026-10-28 archive. This is not a general dump tool and it does not
# restore production, apply 20261105120000_statement_period_coverage, or start
# the application.
#
# SCOPE=disposable is the only accepted scope. SCOPE=production is refused.
# Passwords come from the environment and are not written to the image,
# Compose, or this script's status output.
set -eu
umask 077

if [ -n "${MSYSTEM:-}" ]; then
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
fi

DEST_DB=stell22_pbr_dst
ADMIN_DB=stell22_pbr_admin
IMAGE_DIGEST=sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb
IMAGE_REF="postgres:17-alpine@${IMAGE_DIGEST}"
P1_MIGRATION=20261010210000_psr_p3_s2_b_batch_receipt_provenance
ABSENT_MIGRATION=20261105120000_statement_period_coverage
EXPECTED_TABLES=56
EXPECTED_CONSTRAINTS=159
EXPECTED_MIGRATIONS=47
EXPECTED_MIGRATION_SHA=568490f22d9829f909333907beb8643083cdbbc5f97b3ed638a53d4cb29371cb
EXPECTED_COLUMN_FP=9ff8c23907980e711cdd05daf3857918625633181f9437d51c57483ab94c198a
EXPECTED_CONSTRAINT_FP=60fe6ede4990f429caaa22379cd4dfb0f62b8d8403502ad4ec11461bd05dc2bc
CONFIRM=stell22-db-role-bootstrap-disposable-v1
RESTRICTED='0000000|nopw'
PREPARED='0000100|pw'

WORK=""
CONTAINER=""

finish() {
  code=$1
  shift
  printf '%s\n' "$@"
  exit "$code"
}

on_exit() {
  if [ -n "$WORK" ]; then
    case "$WORK" in
      /tmp/stell22-roleboot.*) rm -rf "$WORK" || true ;;
    esac
  fi
}
trap on_exit EXIT

hex64() {
  case "$1" in
    *[!0-9a-f]*|"") return 1 ;;
  esac
  [ "${#1}" -eq 64 ]
}

password_ok() {
  case "$1" in
    *[!A-Za-z0-9]*|"") return 1 ;;
  esac
  [ "${#1}" -ge 24 ] && [ "${#1}" -le 128 ]
}

hostpath() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

strip_id() {
  raw=$(printf '%s' "$1" | tr -d '[:space:]')
  case "$raw" in
    sha256:*) raw=${raw#sha256:} ;;
  esac
  printf '%s' "$raw"
}

psql_at() {
  docker exec "$CONTAINER" \
    psql -X -U stell22 -d "$1" -q -v ON_ERROR_STOP=1 -At -c "$2"
}

require_value() {
  got=$(printf '%s' "$1" | tr -d '[:space:]')
  if [ "$got" != "$2" ]; then
    finish 1 "RESULT=REFUSED_STATE"
  fi
}

authorize() {
  case "${STELL22_DB_ROLE_BOOTSTRAP_SCOPE:-}" in
    disposable) ;;
    production) finish 1 "RESULT=REFUSED_PRODUCTION_AUTHORIZATION" ;;
    *) finish 1 "RESULT=REFUSED_AUTHORIZATION" ;;
  esac
  if [ "${STELL22_DB_ROLE_BOOTSTRAP_CONFIRM:-}" != "$CONFIRM" ]; then
    finish 1 "RESULT=REFUSED_AUTHORIZATION"
  fi
}

prove_container() {
  target=$1
  case "$target" in
    stell22-db|stell22-db-prod|stell22-app|stell22-caddy)
      finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER"
      ;;
  esac
  if ! raw=$(docker inspect -f '{{.Id}}' "$target" 2>/dev/null); then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  CONTAINER=$(strip_id "$raw")
  if ! hex64 "$CONTAINER"; then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  if ! name=$(docker inspect -f '{{.Name}}' "$CONTAINER"); then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  name=$(printf '%s' "$name" | tr -d '\r')
  case "$name" in
    /stell22-db|/stell22-db-prod|/stell22-app|/stell22-caddy)
      finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER"
      ;;
  esac
  run=${name#/stell22-pbr-}
  case "$name" in
    /stell22-pbr-*) ;;
    *) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" ;;
  esac
  case "$run" in
    *[!0-9a-z]*|"") finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" ;;
  esac
  if [ "${#run}" -lt 12 ] || [ "${#run}" -gt 32 ]; then
    finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER"
  fi
  if ! label=$(docker inspect -f '{{index .Config.Labels "stell22.production-backup-restore"}}' "$CONTAINER"); then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  label=$(printf '%s' "$label" | tr -d '[:space:]')
  if [ "$label" != "$run" ]; then
    finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER"
  fi
  if ! image=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER"); then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  image=$(printf '%s' "$image" | tr -d '[:space:]')
  case "$image" in
    "$IMAGE_REF"|"docker.io/library/${IMAGE_REF}") ;;
    *) finish 1 "RESULT=REFUSED_CONTAINER" ;;
  esac
  if ! expected_image=$(docker image inspect --format '{{.Id}}' "$IMAGE_REF"); then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  if ! actual_image=$(docker inspect -f '{{.Image}}' "$CONTAINER"); then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  expected_image=$(strip_id "$expected_image")
  actual_image=$(strip_id "$actual_image")
  if ! hex64 "$expected_image" || [ "$actual_image" != "$expected_image" ]; then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  if ! net=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER"); then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  net=$(printf '%s' "$net" | tr -d '[:space:]')
  if [ "$net" != "none" ]; then
    finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER"
  fi
  if ! ports=$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$CONTAINER"); then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  case "$ports" in
    *HostPort*) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" ;;
  esac
  if ! bindings=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$CONTAINER"); then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  bindings=$(printf '%s' "$bindings" | tr -d '[:space:]')
  case "$bindings" in
    ""|null|{}|"<no value>") ;;
    *) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" ;;
  esac
  if ! envdump=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER"); then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
  ok_db=0
  ok_user=0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      POSTGRES_DB="$ADMIN_DB") ok_db=1 ;;
      POSTGRES_DB=stell22|POSTGRES_DB=stell22_integrity)
        finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER"
        ;;
      POSTGRES_USER=stell22) ok_user=1 ;;
    esac
  done <<EOF
$envdump
EOF
  if [ "$ok_db" -ne 1 ] || [ "$ok_user" -ne 1 ]; then
    finish 1 "RESULT=REFUSED_CONTAINER"
  fi
}

catalog_ok() {
  if ! tables=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$tables" "$EXPECTED_TABLES"
  if ! constraints=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$constraints" "$EXPECTED_CONSTRAINTS"
  if ! rows=$(psql_at "$DEST_DB" "SELECT count(*) FROM \"_prisma_migrations\""); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$rows" "$EXPECTED_MIGRATIONS"
  if ! incomplete=$(psql_at "$DEST_DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL OR started_at IS NULL OR applied_steps_count <> 1"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$incomplete" "0"
  if ! p1=$(psql_at "$DEST_DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '${P1_MIGRATION}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count = 1"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$p1" "1"
  if ! absent=$(psql_at "$DEST_DB" "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '${ABSENT_MIGRATION}'"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$absent" "0"
  names="$WORK/migration-names"
  if ! docker exec "$CONTAINER" psql -X -U stell22 -d "$DEST_DB" -q -v ON_ERROR_STOP=1 -At -c "SELECT migration_name FROM \"_prisma_migrations\" ORDER BY migration_name" > "$names"; then
    finish 1 "RESULT=UNCERTAIN"
  fi
  if ! line=$(sha256sum -t "$names"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$(printf '%s' "$line" | awk 'NR==1 { print $1; exit }')" "$EXPECTED_MIGRATION_SHA"
  rm -f "$names"

  script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
  helper=$(hostpath "$script_dir/production-backup-restore-fingerprint.mjs")
  if ! node "$helper" --print-column-sql > "$WORK/column.sql"; then
    finish 1 "RESULT=UNCERTAIN"
  fi
  if ! node "$helper" --print-constraint-sql > "$WORK/constraint.sql"; then
    finish 1 "RESULT=UNCERTAIN"
  fi
  delim=$(printf '\037')
  if ! docker exec -i "$CONTAINER" psql -X -U stell22 -d "$DEST_DB" -q -v ON_ERROR_STOP=1 -At -F "$delim" -f - < "$WORK/column.sql" > "$WORK/column.tsv"; then
    finish 1 "RESULT=UNCERTAIN"
  fi
  if ! docker exec -i "$CONTAINER" psql -X -U stell22 -d "$DEST_DB" -q -v ON_ERROR_STOP=1 -At -F "$delim" -f - < "$WORK/constraint.sql" > "$WORK/constraint.tsv"; then
    finish 1 "RESULT=UNCERTAIN"
  fi
  mark=$(printf '\036')
  if ! fp_text=$(
    {
      cat "$WORK/column.tsv"
      printf '%s' "$mark"
      cat "$WORK/constraint.tsv"
    } | node "$helper" --stdin
  ); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  column_fp=$(printf '%s\n' "$fp_text" | awk -F= '$1 == "column_fingerprint" { print $2; exit }')
  constraint_fp=$(printf '%s\n' "$fp_text" | awk -F= '$1 == "constraint_fingerprint" { print $2; exit }')
  require_value "$column_fp" "$EXPECTED_COLUMN_FP"
  require_value "$constraint_fp" "$EXPECTED_CONSTRAINT_FP"
  rm -f "$WORK/column.sql" "$WORK/constraint.sql" "$WORK/column.tsv" "$WORK/constraint.tsv"
}

privileges_ok() {
  if ! db_owner=$(psql_at "$DEST_DB" "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DEST_DB}'"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$db_owner" "stell22"
  if ! schema_owner=$(psql_at "$DEST_DB" "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  case "$(printf '%s' "$schema_owner" | tr -d '[:space:]')" in
    stell22_app|stell22_migrator) finish 1 "RESULT=REFUSED_STATE" ;;
  esac
  if ! members=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname IN ('stell22_app', 'stell22_migrator')"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$members" "0"
  if ! stray=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','i','I') AND pg_get_userbyid(c.relowner) <> 'stell22_migrator'"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$stray" "0"
  if ! stray_routines=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> 'stell22_migrator'"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$stray_routines" "0"
  if ! owned=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND r.rolname = 'stell22_migrator'"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$owned" "$EXPECTED_TABLES"
  if ! app_owned=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'public' AND r.rolname = 'stell22_app'"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$app_owned" "0"
  if ! app_routines=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner WHERE n.nspname = 'public' AND r.rolname = 'stell22_app'"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$app_routines" "0"
  if ! schema_priv=$(psql_at "$DEST_DB" "SELECT CASE WHEN has_schema_privilege('stell22_app','public','USAGE') AND NOT has_schema_privilege('stell22_app','public','CREATE') AND NOT has_database_privilege('stell22_app','${DEST_DB}','CREATE') AND has_schema_privilege('stell22_migrator','public','USAGE') AND has_schema_privilege('stell22_migrator','public','CREATE') AND NOT has_database_privilege('stell22_migrator','${DEST_DB}','CREATE') THEN 'yes' ELSE 'no' END"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$schema_priv" "yes"
  if ! dml=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname <> '_prisma_migrations' AND NOT (has_table_privilege('stell22_app', c.oid, 'SELECT') AND has_table_privilege('stell22_app', c.oid, 'INSERT') AND has_table_privilege('stell22_app', c.oid, 'UPDATE') AND has_table_privilege('stell22_app', c.oid, 'DELETE'))"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$dml" "0"
  if ! history_priv=$(psql_at "$DEST_DB" "SELECT CASE WHEN has_table_privilege('stell22_app','public.\"_prisma_migrations\"','SELECT') AND NOT has_table_privilege('stell22_app','public.\"_prisma_migrations\"','INSERT') AND NOT has_table_privilege('stell22_app','public.\"_prisma_migrations\"','UPDATE') AND NOT has_table_privilege('stell22_app','public.\"_prisma_migrations\"','DELETE') AND NOT has_table_privilege('stell22_app','public.\"_prisma_migrations\"','TRUNCATE') THEN 'yes' ELSE 'no' END"); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  require_value "$history_priv" "yes"
}

role_state() {
  psql_at "$ADMIN_DB" "SELECT rolname || '|' || rolsuper::int || rolcreatedb::int || rolcreaterole::int || rolinherit::int || rolcanlogin::int || rolreplication::int || rolbypassrls::int || '|' || CASE WHEN rolpassword IS NULL THEN 'nopw' ELSE 'pw' END FROM pg_authid WHERE rolname IN ('stell22_app', 'stell22_migrator') ORDER BY rolname"
}

read_passwords() {
  APP_PW=${STELL22_DB_ROLE_BOOTSTRAP_APP_PASSWORD:-}
  MIG_PW=${STELL22_DB_ROLE_BOOTSTRAP_MIGRATOR_PASSWORD:-}
  if ! password_ok "$APP_PW" || ! password_ok "$MIG_PW" || [ "$APP_PW" = "$MIG_PW" ]; then
    finish 1 "RESULT=REFUSED_PASSWORD"
  fi
}

apply_passwords() {
  if ! docker exec -i "$CONTAINER" \
    psql -X -U stell22 -d "$ADMIN_DB" -q -v ON_ERROR_STOP=1 --single-transaction -f - \
    >"$WORK/psql.out" 2>"$WORK/psql.err" <<SQL
ALTER ROLE stell22_app WITH LOGIN PASSWORD '${APP_PW}';
ALTER ROLE stell22_migrator WITH LOGIN PASSWORD '${MIG_PW}';
SQL
  then
    rm -f "$WORK/psql.out" "$WORK/psql.err"
    finish 1 "RESULT=FAILED_APPLY"
  fi
  rm -f "$WORK/psql.out" "$WORK/psql.err"
}

cmd=${1:-}
target=${2:-}
authorize
if [ "$cmd" != "apply" ] || [ -z "$target" ]; then
  finish 1 "RESULT=REFUSED_AUTHORIZATION"
fi
prove_container "$target"
if ! WORK=$(mktemp -d /tmp/stell22-roleboot.XXXXXX); then
  finish 1 "RESULT=UNCERTAIN"
fi
chmod 700 "$WORK" || finish 1 "RESULT=UNCERTAIN"
if ! seen=$(psql_at "$DEST_DB" "SELECT current_database()"); then
  finish 1 "RESULT=REFUSED_STATE"
fi
require_value "$seen" "$DEST_DB"
if ! catalog_ok; then
  finish 1 "RESULT=UNCERTAIN"
fi
if ! privileges_ok; then
  finish 1 "RESULT=UNCERTAIN"
fi
if ! state=$(role_state); then
  finish 1 "RESULT=UNCERTAIN"
fi
state=$(printf '%s\n' "$state" | tr -d '\r')
expected_restricted=$(printf 'stell22_app|%s\nstell22_migrator|%s' "$RESTRICTED" "$RESTRICTED")
expected_prepared=$(printf 'stell22_app|%s\nstell22_migrator|%s' "$PREPARED" "$PREPARED")
if [ "$state" = "$expected_prepared" ]; then
  finish 1 "RESULT=REFUSED_ALREADY_PREPARED"
fi
if [ "$state" != "$expected_restricted" ]; then
  finish 1 "RESULT=REFUSED_STATE"
fi
read_passwords
apply_passwords
if ! state=$(role_state); then
  finish 1 "RESULT=UNCERTAIN"
fi
state=$(printf '%s\n' "$state" | tr -d '\r')
if [ "$state" != "$expected_prepared" ]; then
  finish 1 "RESULT=UNCERTAIN"
fi
if ! privileges_ok; then
  finish 1 "RESULT=UNCERTAIN"
fi
finish 0 "RESULT=BOOTSTRAP_PREPARED"
