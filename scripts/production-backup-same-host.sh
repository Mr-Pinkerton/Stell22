#!/bin/sh
# One-shot same-host restore check. This file does not replace
# scripts/restore-db.sh or scripts/production-backup-restore.sh and it
# never invokes restore-db.sh. Those two entry points stay as they are.
#
# production-backup-restore.sh refuses a Docker engine that already has
# stell22-app, stell22-db-prod, or stell22-caddy. This scenario does not
# remove that refusal. It is a separate runner for one named archive.
# RESTORE_VERIFIED is not production restore, P1 apply, role split, or release.
#
# The container is PostgreSQL 17 on tmpfs, with no published port, no
# network, no Compose project, and no production volume. Cleanup removes
# only the container id recorded for this run, after the name, label, and
# image still match. It does not prune Docker.
set -eu
umask 077

# Git Bash's curl is a Windows binary. Without this, a URL such as
# http://127.0.0.1:3000/api/health is rewritten before curl sees it.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

PRODUCTION_NAME='stell22_2026-10-23_03-00-01.sql.gz'
PRODUCTION_SHA='37c3bed02a9a89c0ddf88fe99a516f8f347b323dac91c93702fda20bdf6360e4'
P1_MIGRATION='20261010210000_psr_p3_s2_b_batch_receipt_provenance'
IMAGE_DIGEST='sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb'
IMAGE_REF="postgres:17-alpine@${IMAGE_DIGEST}"
ADMIN_DB='stell22_samehost_admin'
DEST_DB='stell22_samehost_dst'
MEMORY_BYTES=805306368
NANO_CPUS=500000000
PIDS_LIMIT=128
TMPFS_SIZE=268435456
RESERVE_KB=1048576
NEED_KB=$((MEMORY_BYTES / 1024 + RESERVE_KB))

MODE=""
RUN=""
CNAME=""
CONTAINER=""
EVIDENCE=""
WORK=""
OWNED=0
RELEASED=0

finish() {
  code=$1
  shift
  printf '%s\n' "$@"
  exit "$code"
}

hostpath() {
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

strip_id() {
  raw=$1
  raw=$(printf '%s' "$raw" | tr -d '[:space:]')
  case "$raw" in
    sha256:*) raw=${raw#sha256:} ;;
  esac
  printf '%s' "$raw"
}

require_run() {
  RUN=${STELL22_SAME_HOST_RUN:-}
  case "$RUN" in
    *[!0-9a-z]*|"") finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY" ;;
  esac
  if [ "${#RUN}" -lt 12 ] || [ "${#RUN}" -gt 32 ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
  fi
  CNAME="stell22-samehost-${RUN}"
  case "$CNAME" in
    stell22-db-prod|stell22-db|stell22-app|stell22-caddy) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" ;;
  esac
}

production_names_present() {
  names=$(docker ps -a --format '{{.Names}}') || return 1
  printf '%s\n' "$names" | grep -x -q -e stell22-db-prod -e stell22-app -e stell22-caddy
}

available_kb() {
  if [ "$MODE" = "synthetic" ] && [ -n "${STELL22_SAME_HOST_MEM_AVAILABLE_KB:-}" ]; then
    printf '%s\n' "$STELL22_SAME_HOST_MEM_AVAILABLE_KB"
    return 0
  fi
  if [ -r /proc/meminfo ]; then
    kb=$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo)
    if [ -n "$kb" ]; then
      printf '%s\n' "$kb"
      return 0
    fi
  fi
  if [ "$MODE" = "synthetic" ]; then
    bytes=$(docker info --format '{{.MemTotal}}') || return 1
    printf '%s\n' "$((bytes / 1024))"
    return 0
  fi
  return 1
}

memory_kb() {
  kb=$(available_kb) || return 1
  case "$kb" in
    ""|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$kb"
}

require_resources() {
  kb=$(memory_kb) || finish 1 "RESULT=STOP_RESOURCES" "DETAIL=memory-unreadable"
  if [ "$kb" -lt "$NEED_KB" ]; then
    finish 1 "RESULT=STOP_RESOURCES" "MEM_AVAILABLE_KB=$kb" "NEED_KB=$NEED_KB"
  fi
  printf '%s\n' "MEM_AVAILABLE_KB=$kb" "NEED_KB=$NEED_KB"
}

docker_health() {
  name=$1
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null \
    | tr -d '[:space:]'
}

require_health() {
  if [ "$MODE" = "synthetic" ]; then
    # Synthetic runs have no production containers to inspect. A command
    # fixture can fail on a later probe. Execute mode ignores it and reads
    # the live container health below.
    cmd=${STELL22_SAME_HOST_HEALTH_CMD:-}
    if [ -z "$cmd" ]; then
      return 0
    fi
    if ! sh -c "$cmd"; then
      return 1
    fi
    return 0
  fi
  app=$(docker_health stell22-app)
  db=$(docker_health stell22-db-prod)
  caddy=$(docker inspect -f '{{.State.Status}}' stell22-caddy 2>/dev/null | tr -d '[:space:]' || true)
  if [ "$app" != "healthy" ] || [ "$db" != "healthy" ] || [ "$caddy" != "running" ]; then
    return 1
  fi
  return 0
}

stop_health() {
  release_owned || true
  finish 1 "RESULT=STOP_HEALTH"
}

require_image() {
  if ! docker image inspect "$IMAGE_REF" --format '{{.Id}}' >/dev/null 2>&1; then
    finish 1 "RESULT=STOP_IMAGE" "DETAIL=pinned-image-absent"
  fi
}

scan_dump() {
  if ! grep -qx -e "-- PostgreSQL database dump" "$WORK/dump.sql"; then
    finish 1 "RESULT=REFUSED_FORMAT"
  fi
  if ! grep -qx -e "-- PostgreSQL database dump complete" "$WORK/dump.sql"; then
    finish 1 "RESULT=REFUSED_FORMAT"
  fi
  if grep -E -q -i '^[[:space:]]*(CREATE|DROP)[[:space:]]+DATABASE([[:space:]]|$)' "$WORK/dump.sql"; then
    finish 1 "RESULT=REFUSED_FORMAT"
  fi
  if ! awk '
    function trim(s) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", s); return s }
    BEGIN { state = "code"; escape = 0; depth = 0; tag = ""; stmt = ""; q = "\047"; dq = "\042" }
    {
      sub(/\r$/, "")
      if (state == "copy") {
        if ($0 == "\\.") state = "code"
        next
      }
      n = length($0)
      i = 1
      while (i <= n) {
        c = substr($0, i, 1)
        if (state == "linecom") break
        if (state == "block") {
          if (c == "*" && substr($0, i + 1, 1) == "/") {
            i += 2; depth--; if (depth == 0) state = "code"; continue
          }
          if (c == "/" && substr($0, i + 1, 1) == "*") { i += 2; depth++; continue }
          i++; continue
        }
        if (state == "squote") {
          if (escape && c == "\\") { i += 2; continue }
          if (c == q && substr($0, i + 1, 1) == q) { i += 2; continue }
          if (c == q) { state = "code"; i++; continue }
          i++; continue
        }
        if (state == "dquote") {
          if (c == dq && substr($0, i + 1, 1) == dq) { i += 2; continue }
          if (c == dq) { state = "code"; i++; continue }
          i++; continue
        }
        if (state == "dollar") {
          closer = "$" tag "$"
          if (substr($0, i, length(closer)) == closer) {
            i += length(closer); state = "code"; continue
          }
          i++; continue
        }
        if (c == "-" && substr($0, i + 1, 1) == "-") { state = "linecom"; break }
        if (c == "/" && substr($0, i + 1, 1) == "*") { state = "block"; depth = 1; i += 2; continue }
        if (c == dq) { state = "dquote"; i++; continue }
        if (c == q) {
          prev = substr($0, i - 1, 1)
          escape = (prev == "E" || prev == "e")
          state = "squote"; i++; continue
        }
        if (c == "$") {
          rest = substr($0, i + 1)
          if (match(rest, /^([A-Za-z_][A-Za-z0-9_]*)?\$/)) {
            tag = substr(rest, 1, RLENGTH - 1)
            i += 1 + RLENGTH
            state = "dollar"
            continue
          }
          i++
          continue
        }
        if (c == "\\") {
          name = ""
          j = i + 1
          one = substr($0, j, 1)
          if (one == "!") name = "!"
          else {
            while (j <= n && substr($0, j, 1) ~ /[A-Za-z]/) {
              name = name substr($0, j, 1)
              j++
            }
          }
          if (name != "restrict" && name != "unrestrict") exit 2
          break
        }
        if (c == ";") {
          plain = trim(stmt)
          if (plain ~ /^[Cc][Oo][Pp][Yy][[:space:]]/ && plain ~ /[Ff][Rr][Oo][Mm][[:space:]]+[Ss][Tt][Dd][Ii][Nn][[:space:]]*$/)
            state = "copy"
          stmt = ""
          i++
          continue
        }
        stmt = stmt c
        i++
      }
      if (state == "linecom") state = "code"
    }
    END { if (state != "code") exit 3 }
  ' "$WORK/dump.sql"; then
    finish 1 "RESULT=REFUSED_FORMAT"
  fi
}

stage_archive() {
  archive=$1
  expect=$2
  if [ -z "$archive" ] || [ -L "$archive" ] || [ ! -f "$archive" ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
  fi
  base=$(basename "$archive")
  case "$MODE" in
    synthetic)
      case "$base" in
        synthetic-*.sql.gz) ;;
        *) finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY" ;;
      esac
      if [ "$base" = "$PRODUCTION_NAME" ] || [ "$expect" = "$PRODUCTION_SHA" ]; then
        finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
      fi
      ;;
    execute)
      if [ "$base" != "$PRODUCTION_NAME" ] || [ "$expect" != "$PRODUCTION_SHA" ]; then
        finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
      fi
      ;;
    *) finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY" ;;
  esac
  sidecar="${archive}.sha256"
  if [ -L "$sidecar" ] || [ ! -f "$sidecar" ]; then
    finish 1 "RESULT=REFUSED_CHECKSUM"
  fi
  if ! WORK=$(mktemp -d /tmp/stell22-samehost-work.XXXXXX); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  chmod 700 "$WORK" || finish 1 "RESULT=UNCERTAIN"
  case "$WORK" in
    /tmp/stell22-samehost-work.*) ;;
    *) finish 1 "RESULT=UNCERTAIN" ;;
  esac
  cp -p -- "$archive" "$WORK/$base"
  cp -p -- "$sidecar" "$WORK/${base}.sha256"
  if ! awk -v name="$base" '
    NR == 1 {
      if (NF != 2) exit 1
      if ($1 !~ /^[0-9a-f]{64}$/) exit 1
      if ($2 != name) exit 1
      if (index($0, $1 "  " $2) != 1) exit 1
      seen = 1
      next
    }
    { if ($0 != "") exit 1 }
    END { if (!seen) exit 1 }
  ' "$WORK/${base}.sha256"; then
    finish 1 "RESULT=REFUSED_CHECKSUM"
  fi
  side_sha=$(awk 'NR==1 { print $1; exit }' "$WORK/${base}.sha256")
  if [ "$side_sha" != "$expect" ]; then
    finish 1 "RESULT=REFUSED_CHECKSUM"
  fi
  if ! staged_line=$(sha256sum -t "$WORK/$base"); then
    finish 1 "RESULT=REFUSED_CHECKSUM"
  fi
  staged=$(printf '%s' "$staged_line" | awk 'NR==1 { print $1; exit }' | tr -d '\r')
  if [ "$staged" != "$expect" ]; then
    finish 1 "RESULT=REFUSED_CHECKSUM"
  fi
  if ! gzip -t "$WORK/$base"; then
    finish 1 "RESULT=REFUSED_GZIP"
  fi
  if ! gunzip -c "$WORK/$base" > "$WORK/dump.sql"; then
    finish 1 "RESULT=REFUSED_GZIP"
  fi
  if [ ! -s "$WORK/dump.sql" ]; then
    finish 1 "RESULT=REFUSED_FORMAT"
  fi
  scan_dump
  if [ "$MODE" = "execute" ]; then
    trust=$3
    script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
    if ! STELL22_PBR_SHA256="$expect" STELL22_PBR_SELECTOR="${STELL22_SAME_HOST_SELECTOR:-}" \
      sh "$script_dir/production-backup-restore.sh" verify "$archive" "$trust"; then
      finish 1 "RESULT=REFUSED_FORMAT" "DETAIL=accepted-verify-refused"
    fi
  fi
}

psql_at() {
  db=$1
  sql=$2
  docker exec "$CONTAINER" psql -X -U stell22 -d "$db" -q -v ON_ERROR_STOP=1 -At -c "$sql"
}

prove_container() {
  raw=$(docker inspect -f '{{.Id}}' "$CONTAINER") || return 1
  raw=$(strip_id "$raw")
  hex64 "$raw" || return 1
  CONTAINER=$raw
  name=$(docker inspect -f '{{.Name}}' "$CONTAINER" | tr -d '\r')
  [ "$name" = "/$CNAME" ] || return 1
  image=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" | tr -d '[:space:]')
  case "$image" in
    "$IMAGE_REF"|"docker.io/library/${IMAGE_REF}") ;;
    *) return 1 ;;
  esac
  expected=$(docker image inspect --format '{{.Id}}' "$IMAGE_REF") || return 1
  actual=$(docker inspect -f '{{.Image}}' "$CONTAINER") || return 1
  [ "$(strip_id "$expected")" = "$(strip_id "$actual")" ] || return 1
  label=$(docker inspect -f '{{index .Config.Labels "stell22.same-host-restore"}}' "$CONTAINER" | tr -d '[:space:]')
  [ "$label" = "$RUN" ] || return 1
  project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER" | tr -d '\r')
  case "$project" in
    ""|"<no value>") ;;
    *) return 1 ;;
  esac
  net=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER" | tr -d '[:space:]')
  [ "$net" = "none" ] || return 1
  bindings=$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$CONTAINER" | tr -d '[:space:]')
  case "$bindings" in
    ""|null|{}|"<no value>") ;;
    *) return 1 ;;
  esac
  ports=$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$CONTAINER")
  case "$ports" in
    *HostPort*) return 1 ;;
  esac
  memory=$(docker inspect -f '{{.HostConfig.Memory}}' "$CONTAINER" | tr -d '[:space:]')
  cpus=$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$CONTAINER" | tr -d '[:space:]')
  pids=$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$CONTAINER" | tr -d '[:space:]')
  [ "$memory" = "$MEMORY_BYTES" ] && [ "$cpus" = "$NANO_CPUS" ] && [ "$pids" = "$PIDS_LIMIT" ] || return 1
  tmpfs=$(docker inspect -f '{{json .HostConfig.Tmpfs}}' "$CONTAINER")
  case "$tmpfs" in
    *'"/var/lib/postgresql/data"'*"size=${TMPFS_SIZE}"*) ;;
    *) return 1 ;;
  esac
  mounts=$(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}}{{println}}{{end}}' "$CONTAINER" | tr -d '\r')
  printf '%s\n' "$mounts" | while IFS= read -r mount; do
    [ -n "$mount" ] || continue
    type=${mount%%|*}
    rest=${mount#*|}
    volname=${rest%%|*}
    case "$volname" in
      db-data|caddy-data|caddy-config) exit 9 ;;
    esac
    case "$type" in
      tmpfs|volume) ;;
      *) exit 9 ;;
    esac
    if [ "$type" = "volume" ]; then
      case "$volname" in
        *[!0-9a-f]*|"") exit 9 ;;
      esac
      [ "${#volname}" -eq 64 ] || exit 9
    fi
  done || return 1
  return 0
}

release_owned() {
  [ "$OWNED" = 1 ] || return 0
  [ "$RELEASED" = 1 ] && return 0
  if ! prove_container; then
    printf '%s\n' "RESULT=FAILED_CLEANUP" "DETAIL=identity" "CONTAINER=${CONTAINER:-}"
    OWNED=0
    return 1
  fi
  if ! docker rm -f -v "$CONTAINER" >/dev/null; then
    printf '%s\n' "RESULT=FAILED_CLEANUP" "CONTAINER=$CONTAINER"
    return 1
  fi
  RELEASED=1
  OWNED=0
  if [ -n "$EVIDENCE" ]; then
    rm -f "$(dirname "$EVIDENCE")/db.env" "$(dirname "$EVIDENCE")/psql.err" || true
  fi
  printf '%s\n' "RESULT=CLEANED" "CONTAINER=$CONTAINER"
}

on_exit() {
  if [ -n "$WORK" ]; then
    case "$WORK" in
      /tmp/stell22-samehost-work.*) rm -rf "$WORK" || true ;;
    esac
  fi
  release_owned || true
}
trap on_exit EXIT
trap 'on_exit; exit 130' INT
trap 'on_exit; exit 143' TERM

create_container() {
  require_run
  if docker inspect "$CNAME" >/dev/null 2>&1; then
    finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "DETAIL=name-exists"
  fi
  if [ -z "$EVIDENCE" ]; then
    dir=$(mktemp -d /tmp/stell22-samehost.XXXXXX)
    EVIDENCE="${dir}/evidence"
  fi
  secret=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n' | tr 'A-F' 'a-f')
  envfile=$(dirname "$EVIDENCE")/db.env
  cat > "$envfile" <<EOF
POSTGRES_USER=stell22
POSTGRES_PASSWORD=${secret}
POSTGRES_DB=${ADMIN_DB}
POSTGRES_HOST_AUTH_METHOD=trust
EOF
  chmod 600 "$envfile" || true
  unset secret
  if ! created=$(docker run -d \
    --name "$CNAME" \
    --network none \
    --label "stell22.same-host-restore=${RUN}" \
    --label "stell22.same-host-owner=disposable" \
    --env-file "$(hostpath "$envfile")" \
    --memory "$MEMORY_BYTES" \
    --memory-swap "$MEMORY_BYTES" \
    --cpus 0.5 \
    --pids-limit "$PIDS_LIMIT" \
    --tmpfs "/var/lib/postgresql/data:rw,size=${TMPFS_SIZE}" \
    --restart no \
    "$IMAGE_REF" \
    -c shared_buffers=32MB \
    -c work_mem=4MB \
    -c maintenance_work_mem=32MB); then
    finish 1 "RESULT=UNCERTAIN" "DETAIL=container-create"
  fi
  CONTAINER=$(strip_id "$created")
  OWNED=1
  if ! prove_container; then
    finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "DETAIL=isolation"
  fi
  printf '%s\n' \
    "NETWORK=none" \
    "PORTS=none" \
    "MEMORY=$MEMORY_BYTES" \
    "NANO_CPUS=$NANO_CPUS" \
    "PIDS=$PIDS_LIMIT" \
    "TMPFS=$TMPFS_SIZE" \
    "CONTAINER=$CONTAINER"
  ready=0
  i=0
  while [ "$i" -lt 40 ]; do
    if ! require_health; then
      stop_health
    fi
    kb=$(memory_kb) || finish 1 "RESULT=STOP_RESOURCES" "DETAIL=memory-unreadable"
    if [ "$kb" -lt "$NEED_KB" ]; then
      release_owned || true
      finish 1 "RESULT=STOP_RESOURCES" "MEM_AVAILABLE_KB=$kb" "NEED_KB=$NEED_KB"
    fi
    if docker exec "$CONTAINER" psql -X -U stell22 -d "$ADMIN_DB" -q -v ON_ERROR_STOP=1 -At -c "SELECT 1" >/dev/null 2>&1; then
      ready=1
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    finish 1 "RESULT=UNCERTAIN" "DETAIL=postgres-not-ready" "CONTAINER=$CONTAINER"
  fi
  version=$(psql_at "$ADMIN_DB" "SHOW server_version" | tr -d '[:space:]')
  case "$version" in
    17|17.*) ;;
    *) finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" ;;
  esac
  buffers=$(psql_at "$ADMIN_DB" "SHOW shared_buffers" | tr -d '[:space:]')
  if [ "$buffers" != "32MB" ]; then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "DETAIL=shared-buffers"
  fi
  names=$(psql_at "$ADMIN_DB" "SELECT datname FROM pg_database ORDER BY 1")
  if printf '%s\n' "$names" | grep -x -q -e stell22 -e stell22_integrity -e stell22_pbr_dst; then
    finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER"
  fi
}

public_tables() {
  psql_at "$DEST_DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')"
}

schema_fingerprints() {
  fp_dir=$(dirname "$EVIDENCE")
  script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
  helper=$(hostpath "$script_dir/production-backup-restore-fingerprint.mjs")
  node "$helper" --print-column-sql > "$fp_dir/column.sql"
  node "$helper" --print-constraint-sql > "$fp_dir/constraint.sql"
  delim=$(printf '\037')
  docker exec -i "$CONTAINER" \
    psql -X -U stell22 -d "$DEST_DB" -q -v ON_ERROR_STOP=1 -At -F "$delim" -f - \
    < "$fp_dir/column.sql" > "$fp_dir/column.tsv"
  docker exec -i "$CONTAINER" \
    psql -X -U stell22 -d "$DEST_DB" -q -v ON_ERROR_STOP=1 -At -F "$delim" -f - \
    < "$fp_dir/constraint.sql" > "$fp_dir/constraint.tsv"
  mark=$(printf '\036')
  fp_text=$(
    {
      cat "$fp_dir/column.tsv"
      printf '%s' "$mark"
      cat "$fp_dir/constraint.tsv"
    } | node "$helper" --stdin
  )
  rm -f "$fp_dir/column.sql" "$fp_dir/constraint.sql" "$fp_dir/column.tsv" "$fp_dir/constraint.tsv"
  COLUMN_FP=$(printf '%s\n' "$fp_text" | awk -F= '$1 == "column_fingerprint" { print $2; exit }')
  CONSTRAINT_FP=$(printf '%s\n' "$fp_text" | awk -F= '$1 == "constraint_fingerprint" { print $2; exit }')
  hex64 "$COLUMN_FP" && hex64 "$CONSTRAINT_FP"
}

measure_restored() {
  tables=$(public_tables | tr -d '[:space:]')
  constraints=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'" | tr -d '[:space:]')
  p1_row=$(psql_at "$DEST_DB" "SELECT CASE WHEN to_regclass('public.\"_prisma_migrations\"') IS NULL THEN 'ABSENT' WHEN (SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '${P1_MIGRATION}') = 1 THEN 'PRESENT' WHEN (SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '${P1_MIGRATION}') = 0 THEN 'ABSENT' ELSE 'UNKNOWN' END" | tr -d '[:space:]')
  case "$p1_row" in
    PRESENT|ABSENT) ;;
    *) finish 1 "RESULT=UNCERTAIN" "P1_ROW=UNKNOWN" ;;
  esac
  if [ "$p1_row" = "ABSENT" ]; then
    p1_applied=NOT_APPLIED
  else
    p1_applied=$(psql_at "$DEST_DB" "SELECT CASE WHEN (SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '${P1_MIGRATION}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count > 0) = 1 THEN 'APPLIED' ELSE 'NOT_APPLIED' END" | tr -d '[:space:]')
  fi
  present=$(psql_at "$DEST_DB" "SELECT CASE WHEN to_regclass('public.\"_prisma_migrations\"') IS NULL THEN 'ABSENT' ELSE 'PRESENT' END" | tr -d '[:space:]')
  names_file=$(dirname "$EVIDENCE")/migration-names
  if [ "$present" = "ABSENT" ]; then
    mig_rows=ABSENT
    mig_sha=ABSENT
  else
    mig_rows=$(psql_at "$DEST_DB" "SELECT count(*) FROM \"_prisma_migrations\"" | tr -d '[:space:]')
    docker exec "$CONTAINER" psql -X -U stell22 -d "$DEST_DB" -q -v ON_ERROR_STOP=1 -At -c "SELECT migration_name FROM \"_prisma_migrations\" ORDER BY migration_name" > "$names_file"
    mig_sha=$(sha256sum -t "$names_file" | awk 'NR==1 { print $1; exit }' | tr -d '\r')
    rm -f "$names_file"
  fi
  schema_fingerprints
  printf '%s\n' \
    "public_tables=$tables" \
    "public_constraints=$constraints" \
    "migration_rows=$mig_rows" \
    "migration_names_sha256=$mig_sha" \
    "p1_row=$p1_row" \
    "p1_applied=$p1_applied" \
    "column_fingerprint=$COLUMN_FP" \
    "constraint_fingerprint=$CONSTRAINT_FP"
  MEASURED_TABLES=$tables
  MEASURED_CONSTRAINTS=$constraints
  MEASURED_MIGRATIONS=$mig_rows
  MEASURED_MIGRATION_SHA=$mig_sha
  MEASURED_P1_ROW=$p1_row
  MEASURED_P1_APPLIED=$p1_applied
}

restore_sql() {
  count=$(psql_at "$ADMIN_DB" "SELECT count(*) FROM pg_database WHERE datname = '${DEST_DB}'" | tr -d '[:space:]')
  if [ "$count" != "0" ]; then
    finish 1 "RESULT=REFUSED_POPULATED"
  fi
  psql_at "$ADMIN_DB" "CREATE DATABASE ${DEST_DB}" >/dev/null
  if ! docker exec -i "$CONTAINER" \
    psql -X -U stell22 -d "$DEST_DB" -q -v ON_ERROR_STOP=1 --single-transaction -f - \
    < "$WORK/dump.sql" >/dev/null 2>"$(dirname "$EVIDENCE")/psql.err"; then
    left=$(public_tables 2>/dev/null | tr -d '[:space:]' || true)
    if [ "$left" = "0" ] || [ -z "$left" ]; then
      finish 1 "RESULT=FAILED_RESTORE_SQL" "ROLLBACK=YES"
    fi
    finish 1 "RESULT=FAILED_PARTIAL" "PUBLIC_TABLES=$left"
  fi
}

compare_controls() {
  file=$1
  if [ -z "$file" ] || [ -L "$file" ] || [ ! -f "$file" ]; then
    finish 1 "RESULT=INSPECT_MISMATCH"
  fi
  CTL_TABLES=""
  CTL_CONSTRAINTS=""
  CTL_MIGRATIONS=""
  CTL_MIGRATION_SHA=""
  CTL_P1_ROW=""
  CTL_P1_APPLIED=""
  CTL_COLUMN_FP=""
  CTL_CONSTRAINT_FP=""
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      public_tables) CTL_TABLES=$value ;;
      public_constraints) CTL_CONSTRAINTS=$value ;;
      migration_rows) CTL_MIGRATIONS=$value ;;
      migration_names_sha256) CTL_MIGRATION_SHA=$value ;;
      p1_row) CTL_P1_ROW=$value ;;
      p1_applied) CTL_P1_APPLIED=$value ;;
      column_fingerprint) CTL_COLUMN_FP=$value ;;
      constraint_fingerprint) CTL_CONSTRAINT_FP=$value ;;
      *) finish 1 "RESULT=INSPECT_MISMATCH" ;;
    esac
  done < "$file"
  match=1
  [ "$MEASURED_TABLES" = "$CTL_TABLES" ] || match=0
  [ "$MEASURED_CONSTRAINTS" = "$CTL_CONSTRAINTS" ] || match=0
  [ "$MEASURED_MIGRATIONS" = "$CTL_MIGRATIONS" ] || match=0
  [ "$MEASURED_MIGRATION_SHA" = "$CTL_MIGRATION_SHA" ] || match=0
  [ "$MEASURED_P1_ROW" = "$CTL_P1_ROW" ] || match=0
  [ "$MEASURED_P1_APPLIED" = "$CTL_P1_APPLIED" ] || match=0
  [ "$COLUMN_FP" = "$CTL_COLUMN_FP" ] || match=0
  [ "$CONSTRAINT_FP" = "$CTL_CONSTRAINT_FP" ] || match=0
  printf '%s\n' \
    "P1_ROW=$MEASURED_P1_ROW" \
    "P1_STATE=$MEASURED_P1_APPLIED" \
    "PUBLIC_TABLES=$MEASURED_TABLES" \
    "MIGRATION_ROWS=$MEASURED_MIGRATIONS"
  if [ "$match" -ne 1 ]; then
    finish 1 "RESULT=INSPECT_MISMATCH"
  fi
  printf '%s\n' "RESULT=RESTORE_VERIFIED" "P1_APPLY=NOT_AUTHORIZED"
}

run_restore() {
  archive=$1
  sha=${STELL22_SAME_HOST_SHA256:-}
  hex64 "$sha" || finish 1 "RESULT=REFUSED_CHECKSUM"
  if [ "$MODE" = "execute" ]; then
    [ "${STELL22_SAME_HOST_EXECUTE:-}" = "1" ] || finish 1 "RESULT=STOP_LOCKED"
    if production_names_present; then
      true
    else
      finish 1 "RESULT=STOP_CONTEXT" "DETAIL=production-containers-absent"
    fi
    stage_archive "$archive" "$sha" "${2:-}"
  else
    if production_names_present; then
      finish 1 "RESULT=STOP_CONTEXT" "DETAIL=production-engine"
    fi
    stage_archive "$archive" "$sha"
  fi
  require_image
  require_resources
  if ! require_health; then
    stop_health
  fi
  create_container
  restore_sql
  if ! require_health; then
    stop_health
  fi
  measure_restored
}

cmd=${1:-}
shift || true
case "$cmd" in
  preflight)
    MODE=synthetic
    if production_names_present; then
      MODE=execute
    fi
    printf '%s\n' "NEED_KB=$NEED_KB" "MEMORY=$MEMORY_BYTES" "NANO_CPUS=$NANO_CPUS" "PIDS=$PIDS_LIMIT"
    if docker image inspect "$IMAGE_REF" --format '{{.Id}}' >/dev/null 2>&1; then
      printf '%s\n' "IMAGE=present"
    else
      printf '%s\n' "IMAGE=absent" "RESULT=STOP_IMAGE"
      exit 1
    fi
    require_resources
    if [ "$MODE" = "execute" ]; then
      if require_health; then
        printf '%s\n' "HEALTH=ok" "RESULT=PREFLIGHT_HOST"
      else
        printf '%s\n' "RESULT=STOP_HEALTH"
        exit 1
      fi
    else
      printf '%s\n' "RESULT=PREFLIGHT_WORKSTATION"
    fi
    ;;
  measure)
    MODE=synthetic
    run_restore "${1:-}"
    printf '%s\n' "RESULT=MEASURED"
    ;;
  synthetic)
    MODE=synthetic
    run_restore "${1:-}"
    compare_controls "${2:-}"
    ;;
  execute)
    MODE=execute
    [ "${STELL22_SAME_HOST_EXECUTE:-}" = "1" ] || finish 1 "RESULT=STOP_LOCKED"
    run_restore "${1:-}" "${2:-}"
    compare_controls "${3:-}"
    ;;
  *)
    finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
    ;;
esac
