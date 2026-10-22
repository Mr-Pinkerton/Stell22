#!/bin/sh
# Isolated restore check for one explicitly selected backup archive.
#
# This is not scripts/restore-db.sh and it never invokes that entry point.
# It never targets the application database, the integrity database, or a
# Compose project. A .sha256 sidecar proves byte integrity only. It is not
# provenance. The synthetic drill contract stell22_drill_archive_provenance
# is a different contract and is not accepted here.
#
# Trust is an operator file with contract PRODUCTION_BACKUP_V1 and
# origin OPERATOR_SELECTED_PRODUCTION_BACKUP, plus the same digest repeated
# in the environment. That is an explicit selection, not proof that the
# bytes were produced by a production server.
#
# RESTORE_VERIFIED means the isolated PostgreSQL 17 destination passed the
# independent checks below. It does not authorize production restore, P1
# apply, role split, or deploy. P1_STATE is reported separately.
#
# Cleanup removes only the container id recorded in the evidence file, and
# anonymous volumes attached to it, after the name, label, and image match.
# The container uses --network none, so no Docker network is created.
# It does not prune Docker.
set -eu
umask 077

if [ -n "${MSYSTEM:-}" ]; then
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
fi

P1_MIGRATION='20261010210000_psr_p3_s2_b_batch_receipt_provenance'
ADMIN_DB=stell22_pbr_admin
DEST_DB=stell22_pbr_dst
IMAGE=postgres:17-alpine

WORK=""
CONTAINER=""
NETWORK=""
EVIDENCE=""
STAGED_SHA=""
TRUST_NAME=""
TRUST_SHA=""
TRUST_SELECTOR=""

finish() {
  code=$1
  shift
  printf '%s\n' "$@"
  if [ "${PRINT_EVIDENCE:-}" = "1" ] && [ -n "${EVIDENCE:-}" ]; then
    case " $* " in
      *"EVIDENCE_FILE="*) ;;
      *) printf 'EVIDENCE_FILE=%s\nCONTAINER=%s\n' "$EVIDENCE" "$CONTAINER" ;;
    esac
  fi
  exit "$code"
}

hostpath() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

disposable() {
  [ "${STELL22_PBR_DISPOSABLE:-}" = "1" ]
}

failpoint() {
  if disposable && [ "${STELL22_PBR_FAILPOINT:-}" = "$1" ]; then
    return 0
  fi
  return 1
}

require_run() {
  RUN=${STELL22_PBR_RUN:-}
  case "$RUN" in
    *[!0-9a-z]*|"") finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY" ;;
  esac
  if [ "${#RUN}" -lt 12 ] || [ "${#RUN}" -gt 32 ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
  fi
  CNAME="stell22-pbr-${RUN}"
  NNAME="stell22-pbr-net-${RUN}"
  case "$CNAME" in
    stell22-db-prod|stell22-db|stell22-app|stell22-caddy) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" ;;
  esac
}

reject_overrides() {
  case "${STELL22_PBR_CONTAINER_NAME:-}" in
    "") ;;
    *) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" ;;
  esac
  case "${STELL22_PBR_IMAGE:-}" in
    ""|postgres:17-alpine) ;;
    *) finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" ;;
  esac
  case "${STELL22_PBR_DATABASE:-}" in
    ""|stell22_pbr_dst) ;;
    *) finish 1 "RESULT=REFUSED_DESTINATION" ;;
  esac
}

psql_at() {
  db=$1
  sql=$2
  docker exec "$CONTAINER" \
    psql -X -U stell22 -d "$db" -q -v ON_ERROR_STOP=1 -At -c "$sql"
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

inspect_field() {
  docker inspect -f "$2" "$1"
}

prove_identity() {
  if ! raw=$(inspect_field "$CONTAINER" '{{.Id}}'); then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" ${EVIDENCE:+"EVIDENCE=KEPT"}
  fi
  raw=$(strip_id "$raw")
  if ! hex64 "$raw"; then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" ${EVIDENCE:+"EVIDENCE=KEPT"}
  fi
  CONTAINER=$raw

  if ! name=$(inspect_field "$CONTAINER" '{{.Name}}'); then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  name=$(printf '%s' "$name" | tr -d '\r')
  case "$name" in
    /stell22-db-prod|/stell22-db|/stell22-app|/stell22-caddy)
      finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT"
      ;;
    "/$CNAME") ;;
    *) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT" ;;
  esac

  if ! image=$(inspect_field "$CONTAINER" '{{.Config.Image}}'); then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  image=$(printf '%s' "$image" | tr -d '[:space:]')
  case "$image" in
    postgres:17-alpine|docker.io/library/postgres:17-alpine) ;;
    *) finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT" ;;
  esac

  if ! label=$(inspect_field "$CONTAINER" '{{index .Config.Labels "stell22.production-backup-restore"}}'); then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  label=$(printf '%s' "$label" | tr -d '[:space:]')
  if [ "$label" != "$RUN" ]; then
    finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT"
  fi

  if ! project=$(inspect_field "$CONTAINER" '{{index .Config.Labels "com.docker.compose.project"}}'); then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  project=$(printf '%s' "$project" | tr -d '\r')
  case "$project" in
    ""|"<no value>") ;;
    *) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT" ;;
  esac

  if ! net=$(inspect_field "$CONTAINER" '{{.HostConfig.NetworkMode}}'); then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  net=$(printf '%s' "$net" | tr -d '[:space:]')
  case "$net" in
    none) ;;
    *) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT" ;;
  esac

  if ! mounts=$(inspect_field "$CONTAINER" '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}}{{println}}{{end}}'); then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  saw_data=0
  while IFS= read -r mount; do
    [ -n "$mount" ] || continue
    type=${mount%%|*}
    rest=${mount#*|}
    volname=${rest%%|*}
    dest=${rest#*|}
    case "$volname" in
      db-data|caddy-data|caddy-config) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT" ;;
    esac
    case "$type" in
      tmpfs)
        if [ "$dest" = "/var/lib/postgresql/data" ]; then
          saw_data=1
        fi
        ;;
      volume)
        if ! hex64 "$volname"; then
          finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT"
        fi
        ;;
      *) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT" ;;
    esac
  done <<EOF
$mounts
EOF
  if ! tmpfs=$(inspect_field "$CONTAINER" '{{json .HostConfig.Tmpfs}}'); then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  case "$tmpfs" in
    *'"/var/lib/postgresql/data"'*) saw_data=1 ;;
  esac
  if [ "$saw_data" -ne 1 ]; then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi

  if ! ports=$(inspect_field "$CONTAINER" '{{json .NetworkSettings.Ports}}'); then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  case "$ports" in
    *HostPort*) finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT" ;;
  esac

  ok_db=0
  ok_user=0
  if ! envdump=$(inspect_field "$CONTAINER" '{{range .Config.Env}}{{println .}}{{end}}'); then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      POSTGRES_DB="$ADMIN_DB") ok_db=1 ;;
      POSTGRES_DB=stell22|POSTGRES_DB=stell22_integrity)
        finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT"
        ;;
      POSTGRES_USER=stell22) ok_user=1 ;;
    esac
  done <<EOF
$envdump
EOF
  if [ "$ok_db" -ne 1 ] || [ "$ok_user" -ne 1 ]; then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi

  if [ "${SKIP_SQL:-}" = "1" ]; then
    return 0
  fi

  ready=0
  i=0
  while [ "$i" -lt 40 ]; do
    if docker exec "$CONTAINER" psql -X -U stell22 -d "$ADMIN_DB" -q -v ON_ERROR_STOP=1 -At -c "SELECT 1" >/dev/null 2>&1; then
      ready=1
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi

  if ! admin=$(psql_at "$ADMIN_DB" "SELECT current_database()"); then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi
  admin=$(printf '%s' "$admin" | tr -d '[:space:]')
  if [ "$admin" != "$ADMIN_DB" ]; then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi

  if ! role=$(psql_at "$ADMIN_DB" "SELECT current_user"); then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi
  role=$(printf '%s' "$role" | tr -d '[:space:]')
  if [ "$role" != "stell22" ]; then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi

  if ! version=$(psql_at "$ADMIN_DB" "SHOW server_version"); then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi
  version=$(printf '%s' "$version" | tr -d '[:space:]')
  case "$version" in
    17|17.*) ;;
    *) finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" ;;
  esac

  if ! names=$(psql_at "$ADMIN_DB" "SELECT datname FROM pg_database ORDER BY 1"); then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi
  if printf '%s\n' "$names" | grep -x -q -e stell22 -e stell22_integrity; then
    finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi
  if ! printf '%s\n' "$names" | grep -x -q "$ADMIN_DB"; then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi
  NETWORK=none
  NNAME=none
}

write_evidence() {
  dir=$(dirname "$EVIDENCE")
  tmp="${dir}/evidence.tmp"
  cat > "$tmp" <<EOF
v=1
run=${RUN}
container_id=${CONTAINER}
container_name=${CNAME}
network_id=${NETWORK}
network_name=${NNAME}
image=postgres:17-alpine
EOF
  mv "$tmp" "$EVIDENCE"
  chmod 600 "$EVIDENCE" || true
}

prepare_cluster() {
  require_run
  reject_overrides
  if [ -z "$EVIDENCE" ]; then
    if ! dir=$(mktemp -d /tmp/stell22-pbr.XXXXXX); then
      finish 1 "RESULT=UNCERTAIN"
    fi
    EVIDENCE="${dir}/evidence"
  fi
  PRINT_EVIDENCE=1
  if docker inspect "$CNAME" >/dev/null 2>&1; then
    if ! existing=$(inspect_field "$CNAME" '{{.Id}}'); then
      finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER"
    fi
    CONTAINER=$(strip_id "$existing")
    NETWORK=none
    NNAME=none
    write_evidence
    prove_identity
    write_evidence
    return 0
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

  NETWORK=none
  NNAME=none
  if ! created=$(docker run -d \
    --name "$CNAME" \
    --network none \
    --label "stell22.production-backup-restore=${RUN}" \
    --label "stell22.pbr-owner=disposable" \
    --env-file "$(hostpath "$envfile")" \
    --tmpfs /var/lib/postgresql/data:rw,size=1073741824 \
    --restart no \
    "$IMAGE" 2>"$(dirname "$EVIDENCE")/docker.err"); then
    finish 1 "RESULT=UNCERTAIN" "DETAIL=container-create"
  fi
  CONTAINER=$(strip_id "$created")
  write_evidence
  prove_identity
  write_evidence
}

load_trust() {
  trust=$1
  if [ -L "$trust" ] || [ ! -f "$trust" ]; then
    finish 1 "RESULT=REFUSED_PROVENANCE"
  fi
  if [ -n "$2" ] && [ "$trust" = "$2" ]; then
    finish 1 "RESULT=REFUSED_PROVENANCE"
  fi
  if grep -q "$(printf '\r')" "$trust"; then
    finish 1 "RESULT=REFUSED_PROVENANCE"
  fi
  contract=""
  origin=""
  TRUST_NAME=""
  TRUST_SHA=""
  TRUST_SELECTOR=""
  lines=0
  while IFS= read -r line || [ -n "$line" ]; do
    lines=$((lines + 1))
    case "$lines" in
      1) [ "$line" = "contract=PRODUCTION_BACKUP_V1" ] || finish 1 "RESULT=REFUSED_PROVENANCE" ;;
      2) [ "$line" = "origin=OPERATOR_SELECTED_PRODUCTION_BACKUP" ] || finish 1 "RESULT=REFUSED_PROVENANCE" ;;
      3) TRUST_NAME=${line#name=} ;;
      4) TRUST_SHA=${line#sha256=} ;;
      5) TRUST_SELECTOR=${line#selector=} ;;
      *) finish 1 "RESULT=REFUSED_PROVENANCE" ;;
    esac
  done < "$trust"
  if [ "$lines" -ne 5 ]; then
    finish 1 "RESULT=REFUSED_PROVENANCE"
  fi
  case "$TRUST_NAME" in
    stell22_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9].sql.gz) ;;
    *) finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY" ;;
  esac
  if ! hex64 "$TRUST_SHA"; then
    finish 1 "RESULT=REFUSED_CHECKSUM_MISMATCH"
  fi
  case "$TRUST_SELECTOR" in
    *[!0-9A-Za-z_-]*|"") finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY" ;;
  esac
  if [ "${#TRUST_SELECTOR}" -lt 8 ] || [ "${#TRUST_SELECTOR}" -gt 64 ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
  fi
  pin=${STELL22_PBR_SHA256:-}
  selector=${STELL22_PBR_SELECTOR:-}
  if [ "$pin" != "$TRUST_SHA" ]; then
    finish 1 "RESULT=REFUSED_CHECKSUM_MISMATCH"
  fi
  if [ "$selector" != "$TRUST_SELECTOR" ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
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
  # Same psql meta-command boundary as the disposable drill. A sidecar does
  # not prove these bytes came from pg_dump. \restrict and \unrestrict are the
  # only backslash commands accepted, because current plain dumps emit them.
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

verify_archive() {
  archive=$1
  trust=$2
  if [ -z "$archive" ] || [ -z "$trust" ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
  fi
  if [ -L "$archive" ] || [ ! -f "$archive" ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
  fi
  base=$(basename "$archive")
  case "$base" in
    stell22_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9].sql.gz) ;;
    *) finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY" ;;
  esac
  sidecar="${archive}.sha256"
  load_trust "$trust" "$sidecar"
  if [ "$TRUST_NAME" != "$base" ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
  fi
  if [ -L "$sidecar" ]; then
    finish 1 "RESULT=REFUSED_MISSING_CHECKSUM"
  fi
  if [ ! -f "$sidecar" ]; then
    finish 1 "RESULT=REFUSED_MISSING_CHECKSUM"
  fi
  if ! WORK=$(mktemp -d /tmp/stell22-pbr-work.XXXXXX); then
    finish 1 "RESULT=UNCERTAIN"
  fi
  chmod 700 "$WORK" || finish 1 "RESULT=UNCERTAIN"
  case "$WORK" in
    /tmp/stell22-pbr-work.*) ;;
    *) finish 1 "RESULT=UNCERTAIN" ;;
  esac
  if ! cp -p -- "$archive" "$WORK/$base"; then
    finish 1 "RESULT=UNCERTAIN"
  fi
  if ! cp -p -- "$sidecar" "$WORK/${base}.sha256"; then
    finish 1 "RESULT=UNCERTAIN"
  fi
  if ! awk -v name="$base" '
    NR == 1 {
      if (NF != 2) exit 1
      if ($1 !~ /^[0-9a-f]{64}$/) exit 1
      if ($2 != name) exit 1
      if (index($0, $1 "  " $2) != 1) exit 1
      if (length($0) != length($1) + 2 + length($2)) exit 1
      seen = 1
      next
    }
    { if ($0 != "") exit 1 }
    END { if (!seen) exit 1 }
  ' "$WORK/${base}.sha256"; then
    finish 1 "RESULT=REFUSED_CHECKSUM_MISMATCH"
  fi
  side_sha=$(awk 'NR==1 { print $1; exit }' "$WORK/${base}.sha256")
  if [ "$side_sha" != "$TRUST_SHA" ]; then
    finish 1 "RESULT=REFUSED_CHECKSUM_MISMATCH"
  fi
  if ! staged_line=$(sha256sum -t "$WORK/$base"); then
    finish 1 "RESULT=REFUSED_CHECKSUM_MISMATCH"
  fi
  STAGED_SHA=$(printf '%s' "$staged_line" | awk 'NR==1 { print $1; exit }' | tr -d '\r')
  if ! hex64 "$STAGED_SHA"; then
    finish 1 "RESULT=REFUSED_CHECKSUM_MISMATCH"
  fi
  if [ "$STAGED_SHA" != "$TRUST_SHA" ]; then
    finish 1 "RESULT=REFUSED_CHECKSUM_MISMATCH"
  fi
  if ! (CDPATH= cd "$WORK" && sha256sum -c "${base}.sha256" >/dev/null); then
    finish 1 "RESULT=REFUSED_CHECKSUM_MISMATCH"
  fi
  if ! source_line=$(sha256sum -t "$archive"); then
    finish 1 "RESULT=REFUSED_ARCHIVE_CHANGED"
  fi
  source_sha=$(printf '%s' "$source_line" | awk 'NR==1 { print $1; exit }' | tr -d '\r')
  if [ "$source_sha" != "$STAGED_SHA" ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_CHANGED"
  fi
  if ! gzip -t "$WORK/$base"; then
    finish 1 "RESULT=REFUSED_GZIP"
  fi
  if ! after_line=$(sha256sum -t "$WORK/$base"); then
    finish 1 "RESULT=REFUSED_ARCHIVE_CHANGED"
  fi
  after_sha=$(printf '%s' "$after_line" | awk 'NR==1 { print $1; exit }' | tr -d '\r')
  if [ "$after_sha" != "$STAGED_SHA" ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_CHANGED"
  fi
  if ! gunzip -c "$WORK/$base" > "$WORK/dump.sql"; then
    finish 1 "RESULT=REFUSED_GZIP"
  fi
  if [ ! -s "$WORK/dump.sql" ]; then
    finish 1 "RESULT=REFUSED_FORMAT"
  fi
  scan_dump
  if ! source_line=$(sha256sum -t "$archive"); then
    finish 1 "RESULT=REFUSED_ARCHIVE_CHANGED"
  fi
  source_sha=$(printf '%s' "$source_line" | awk 'NR==1 { print $1; exit }' | tr -d '\r')
  if [ "$source_sha" != "$STAGED_SHA" ]; then
    finish 1 "RESULT=REFUSED_ARCHIVE_CHANGED"
  fi
  chmod a-w "$WORK/$base" "$WORK/${base}.sha256" || true
}

destination_exists() {
  if ! count=$(psql_at "$ADMIN_DB" "SELECT count(*) FROM pg_database WHERE datname = '${DEST_DB}'"); then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  count=$(printf '%s' "$count" | tr -d '[:space:]')
  [ "$count" != "0" ]
}

public_tables() {
  psql_at "$DEST_DB" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')"
}

restore_sql() {
  if destination_exists; then
    finish 1 "RESULT=REFUSED_POPULATED" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  if ! psql_at "$ADMIN_DB" "CREATE DATABASE ${DEST_DB}" >/dev/null; then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  single="--single-transaction"
  if failpoint split-transaction; then
    single=""
  fi
  # shellcheck disable=SC2086
  if ! docker exec -i "$CONTAINER" \
    psql -X -U stell22 -d "$DEST_DB" -q -v ON_ERROR_STOP=1 $single -f - \
    < "$WORK/dump.sql" >/dev/null 2>"$(dirname "$EVIDENCE")/psql.err"; then
    if ! left=$(public_tables); then
      finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
    fi
    left=$(printf '%s' "$left" | tr -d '[:space:]')
    case "$left" in
      ""|*[!0-9]*) finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE" ;;
      0) finish 1 "RESULT=FAILED_RESTORE_SQL" "ROLLBACK=YES" "PUBLIC_TABLES=0" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE" ;;
      *) finish 1 "RESULT=FAILED_PARTIAL" "EVIDENCE=KEPT" "PUBLIC_TABLES=$left" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE" ;;
    esac
  fi
}

load_controls() {
  file=$1
  if [ -z "$file" ] || [ -L "$file" ] || [ ! -f "$file" ]; then
    finish 1 "RESULT=INSPECT_MISMATCH" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  CTL_TABLES=""
  CTL_CONSTRAINTS=""
  CTL_MIGRATIONS=""
  CTL_MIGRATION_SHA=""
  CTL_P1=""
  CTL_CONTROL=""
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      public_tables) CTL_TABLES=$value ;;
      public_constraints) CTL_CONSTRAINTS=$value ;;
      migration_rows) CTL_MIGRATIONS=$value ;;
      migration_names_sha256) CTL_MIGRATION_SHA=$value ;;
      p1) CTL_P1=$value ;;
      control_rows) CTL_CONTROL=$value ;;
      *) finish 1 "RESULT=INSPECT_MISMATCH" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE" ;;
    esac
  done < "$file"
  case "$CTL_TABLES" in
    ""|*[!0-9]*) finish 1 "RESULT=INSPECT_MISMATCH" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE" ;;
  esac
  case "$CTL_CONSTRAINTS" in
    ""|*[!0-9]*) finish 1 "RESULT=INSPECT_MISMATCH" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE" ;;
  esac
  case "$CTL_MIGRATIONS" in
    ABSENT|*[!0-9]*)
      if [ "$CTL_MIGRATIONS" != "ABSENT" ]; then
        finish 1 "RESULT=INSPECT_MISMATCH" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
      fi
      ;;
  esac
  case "$CTL_P1" in
    PRESENT|ABSENT) ;;
    *) finish 1 "RESULT=INSPECT_MISMATCH" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE" ;;
  esac
  if [ "$CTL_MIGRATIONS" = "ABSENT" ]; then
    [ "$CTL_MIGRATION_SHA" = "ABSENT" ] || finish 1 "RESULT=INSPECT_MISMATCH" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  elif ! hex64 "$CTL_MIGRATION_SHA"; then
    finish 1 "RESULT=INSPECT_MISMATCH" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
}

inspect_restored() {
  controls=$1
  load_controls "$controls"
  if ! seen=$(psql_at "$DEST_DB" "SELECT current_database()"); then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  seen=$(printf '%s' "$seen" | tr -d '[:space:]')
  if [ "$seen" != "$DEST_DB" ]; then
    finish 1 "RESULT=REFUSED_DESTINATION" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  if ! tables=$(public_tables); then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  tables=$(printf '%s' "$tables" | tr -d '[:space:]')
  if ! constraints=$(psql_at "$DEST_DB" "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'"); then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  constraints=$(printf '%s' "$constraints" | tr -d '[:space:]')
  if ! p1=$(psql_at "$DEST_DB" "SELECT CASE WHEN to_regclass('public.\"_prisma_migrations\"') IS NULL THEN 'ABSENT' WHEN (SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '${P1_MIGRATION}') = 0 THEN 'ABSENT' WHEN (SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '${P1_MIGRATION}') = 1 THEN 'PRESENT' ELSE 'UNKNOWN' END"); then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  p1=$(printf '%s' "$p1" | tr -d '[:space:]')
  case "$p1" in
    PRESENT|ABSENT) ;;
    *) finish 1 "RESULT=UNCERTAIN" "P1_STATE=UNKNOWN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE" ;;
  esac
  if ! present=$(psql_at "$DEST_DB" "SELECT CASE WHEN to_regclass('public.\"_prisma_migrations\"') IS NULL THEN 'ABSENT' ELSE 'PRESENT' END"); then
    finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  present=$(printf '%s' "$present" | tr -d '[:space:]')
  names_file=$(dirname "$EVIDENCE")/migration-names
  if [ "$present" = "ABSENT" ]; then
    mig_rows=ABSENT
    mig_sha=ABSENT
  else
    if ! mig_rows=$(psql_at "$DEST_DB" "SELECT count(*) FROM \"_prisma_migrations\""); then
      finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
    fi
    mig_rows=$(printf '%s' "$mig_rows" | tr -d '[:space:]')
    if ! docker exec "$CONTAINER" psql -X -U stell22 -d "$DEST_DB" -q -v ON_ERROR_STOP=1 -At -c "SELECT migration_name FROM \"_prisma_migrations\" ORDER BY migration_name" > "$names_file"; then
      finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
    fi
    if ! mig_line=$(sha256sum -t "$names_file"); then
      finish 1 "RESULT=UNCERTAIN" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
    fi
    mig_sha=$(printf '%s' "$mig_line" | awk 'NR==1 { print $1; exit }' | tr -d '\r')
    rm -f "$names_file"
  fi
  control_line=""
  if [ -n "$CTL_CONTROL" ]; then
    if ! control_count=$(psql_at "$DEST_DB" "SELECT count(*) FROM stell22_pbr_control"); then
      finish 1 "RESULT=INSPECT_MISMATCH" "P1_STATE=$p1" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
    fi
    control_count=$(printf '%s' "$control_count" | tr -d '[:space:]')
    control_line="CONTROL_ROWS=$control_count"
  fi
  match=1
  [ "$tables" = "$CTL_TABLES" ] || match=0
  [ "$constraints" = "$CTL_CONSTRAINTS" ] || match=0
  [ "$mig_rows" = "$CTL_MIGRATIONS" ] || match=0
  [ "$mig_sha" = "$CTL_MIGRATION_SHA" ] || match=0
  [ "$p1" = "$CTL_P1" ] || match=0
  if [ -n "$CTL_CONTROL" ] && [ "$control_count" != "$CTL_CONTROL" ]; then
    match=0
  fi
  lines="P1_STATE=$p1
MIGRATION_ROWS=$mig_rows
PUBLIC_TABLES=$tables
PUBLIC_CONSTRAINTS=$constraints
MIGRATION_NAMES_SHA256=$mig_sha"
  if [ -n "$control_line" ]; then
    lines="${lines}
${control_line}"
  fi
  if [ "$match" -ne 1 ]; then
    # shellcheck disable=SC2086
    finish 1 "RESULT=INSPECT_MISMATCH" $lines "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  # shellcheck disable=SC2086
  finish 0 "RESULT=RESTORE_VERIFIED" $lines "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
}

read_evidence() {
  file=$1
  if [ -z "$file" ] || [ -L "$file" ] || [ ! -f "$file" ]; then
    finish 1 "RESULT=UNCERTAIN"
  fi
  EVIDENCE=$file
  RUN=""
  CONTAINER=""
  CNAME=""
  NETWORK=""
  NNAME=""
  image_pin=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      run=*) RUN=${line#run=} ;;
      container_id=*) CONTAINER=${line#container_id=} ;;
      container_name=*) CNAME=${line#container_name=} ;;
      network_id=*) NETWORK=${line#network_id=} ;;
      network_name=*) NNAME=${line#network_name=} ;;
      image=*) image_pin=${line#image=} ;;
    esac
  done < "$file"
  if [ "$image_pin" != "postgres:17-alpine" ]; then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  case "$RUN" in
    *[!0-9a-z]*|"") finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT" ;;
  esac
  if [ "$CNAME" != "stell22-pbr-${RUN}" ] || [ "$NNAME" != "none" ] || [ "$NETWORK" != "none" ]; then
    finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT"
  fi
  if ! hex64 "$CONTAINER"; then
    finish 1 "RESULT=REFUSED_POSTGRES_IDENTITY" "EVIDENCE=KEPT"
  fi
  case "$CNAME" in
    stell22-db-prod|stell22-db|stell22-app|stell22-caddy)
      finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT"
      ;;
  esac
}

cleanup_resources() {
  read_evidence "$1"
  if failpoint cleanup-rm; then
    finish 1 "RESULT=FAILED_CLEANUP" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" "EVIDENCE_FILE=$EVIDENCE"
  fi
  if ! live=$(inspect_field "$CONTAINER" '{{.Id}}' 2>/dev/null); then
    finish 0 "RESULT=CLEANED" "DETAIL=already-absent" "CONTAINER=$CONTAINER"
  fi
  live=$(strip_id "$live")
  if [ "$live" != "$CONTAINER" ]; then
    finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT"
  fi
  SKIP_SQL=1
  prove_identity
  SKIP_SQL=0
  volumes=""
  if ! mounts=$(inspect_field "$CONTAINER" '{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Destination}}{{println}}{{end}}'); then
    finish 1 "RESULT=FAILED_CLEANUP" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi
  while IFS= read -r mount; do
    [ -n "$mount" ] || continue
    type=${mount%%|*}
    rest=${mount#*|}
    volname=${rest%%|*}
    case "$volname" in
      db-data|caddy-data|caddy-config)
        finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
        ;;
    esac
    case "$type" in
      tmpfs) ;;
      volume)
        if ! hex64 "$volname"; then
          finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
        fi
        volumes="${volumes} ${volname}"
        ;;
      *) finish 1 "RESULT=REFUSED_PRODUCTION_CONTAINER" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER" ;;
    esac
  done <<EOF
$mounts
EOF
  if ! docker rm -f "$CONTAINER" >/dev/null; then
    finish 1 "RESULT=FAILED_CLEANUP" "EVIDENCE=KEPT" "CONTAINER=$CONTAINER"
  fi
  for volname in $volumes; do
    if ! docker volume rm "$volname" >/dev/null; then
      finish 1 "RESULT=FAILED_CLEANUP" "EVIDENCE=KEPT" "VOLUME=$volname"
    fi
  done
  rm -f "$(dirname "$EVIDENCE")/db.env" "$(dirname "$EVIDENCE")/psql.err" || true
  finish 0 "RESULT=CLEANED" "CONTAINER=$CONTAINER" "NETWORK=$NETWORK"
}

on_exit() {
  if [ -n "$WORK" ]; then
    case "$WORK" in
      /tmp/stell22-pbr-work.*) rm -rf "$WORK" || true ;;
    esac
  fi
}
trap on_exit EXIT

cmd=${1:-}
shift || true
reject_overrides

case "$cmd" in
  verify)
    verify_archive "${1:-}" "${2:-}"
    finish 0 "SHA256=$STAGED_SHA" "RESULT=ARCHIVE_OK"
    ;;
  prepare)
    prepare_cluster
    finish 0 "RESULT=PREPARED" "CONTAINER=$CONTAINER" "NETWORK=$NETWORK" "EVIDENCE_FILE=$EVIDENCE"
    ;;
  restore)
    read_evidence "${4:-}"
    prove_identity
    verify_archive "${1:-}" "${2:-}"
    restore_sql
    inspect_restored "${3:-}"
    ;;
  run)
    verify_archive "${1:-}" "${2:-}"
    prepare_cluster
    restore_sql
    inspect_restored "${3:-}"
    ;;
  cleanup)
    cleanup_resources "${1:-}"
    ;;
  *)
    finish 1 "RESULT=REFUSED_ARCHIVE_IDENTITY"
    ;;
esac
