#!/bin/sh
# Disposable restore drill for one identified PostgreSQL 17 service container.
# localhost, a container name, or a name prefix is not identity.
# The container must carry label stell22.restore-drill-run=<STELL22_RESTORE_DRILL_RUN>,
# image postgres:17-alpine, and a nonce row created inside that service.
# This script never reads DATABASE_URL or INTEGRITY_TEST_DATABASE_URL.
# It never calls docker compose and never targets stell22 or stell22_integrity.
# A successful run is not verification of a production backup.
set -eu
umask 077

fail() {
  echo "[restore-drill] ОШИБКА: $1" >&2
  exit 1
}

RUN=${STELL22_RESTORE_DRILL_RUN:-}
case "$RUN" in
  *[!0-9A-Za-z-]*) fail "некорректный идентификатор прогона" ;;
  "") fail "нет STELL22_RESTORE_DRILL_RUN" ;;
esac
if [ "${#RUN}" -lt 8 ]; then
  fail "слишком короткий идентификатор прогона"
fi

CONTAINER=""
PORT_BINDING=""
WORK=""

cleanup() {
  if [ -n "$WORK" ]; then
    rm -rf "$WORK" || true
  fi
}
trap cleanup EXIT

psql_at() {
  db=$1
  sql=$2
  docker exec "$CONTAINER" \
    psql -X -U stell22 -d "$db" -q -v ON_ERROR_STOP=1 -At -c "$sql"
}

prove_container() {
  if ! ids=$(docker ps -q --filter "label=stell22.restore-drill-run=${RUN}"); then
    fail "docker ps не выполнен"
  fi
  ids=$(printf '%s' "$ids" | tr -d '\r')
  count=0
  short=""
  for id in $ids; do
    [ -n "$id" ] || continue
    count=$((count + 1))
    short=$id
  done
  if [ "$count" -ne 1 ]; then
    fail "нужен ровно один контейнер drill, найдено ${count}"
  fi

  if ! raw=$(docker inspect -f '{{.Id}}' "$short"); then
    fail "не удалось прочитать id контейнера"
  fi
  raw=$(printf '%s' "$raw" | tr -d '\r')
  case "$raw" in
    sha256:*) raw=${raw#sha256:} ;;
  esac
  case "$raw" in
    *[!0-9a-f]*) fail "id контейнера не является hex" ;;
  esac
  if [ "${#raw}" -ne 64 ]; then
    fail "id контейнера не является полным"
  fi
  CONTAINER=$raw

  if ! image=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER"); then
    fail "не удалось прочитать образ"
  fi
  image=$(printf '%s' "$image" | tr -d '\r')
  case "$image" in
    postgres:17-alpine|docker.io/library/postgres:17-alpine) ;;
    *) fail "образ контейнера не postgres:17-alpine" ;;
  esac

  if ! label=$(docker inspect -f '{{index .Config.Labels "stell22.restore-drill-run"}}' "$CONTAINER"); then
    fail "не удалось прочитать метку"
  fi
  label=$(printf '%s' "$label" | tr -d '\r')
  if [ "$label" != "$RUN" ]; then
    fail "метка контейнера не совпала с прогоном"
  fi

  if ! project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER"); then
    fail "не удалось прочитать метку compose"
  fi
  project=$(printf '%s' "$project" | tr -d '\r')
  case "$project" in
    ""|"<no value>") ;;
    *) fail "контейнер принадлежит docker compose" ;;
  esac

  if ! net=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER"); then
    fail "не удалось прочитать сеть"
  fi
  net=$(printf '%s' "$net" | tr -d '\r')
  if [ "$net" = "host" ]; then
    fail "network host запрещён"
  fi

  if ! name=$(docker inspect -f '{{.Name}}' "$CONTAINER"); then
    fail "не удалось прочитать имя"
  fi
  name=$(printf '%s' "$name" | tr -d '\r')
  case "$name" in
    /stell22-db|/stell22-db-prod) fail "это контейнер приложения, не drill" ;;
  esac

  ok_db=0
  ok_user=0
  if ! envdump=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER"); then
    fail "не удалось прочитать окружение контейнера"
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      POSTGRES_DB=stell22_restore_drill_admin) ok_db=1 ;;
      POSTGRES_DB=stell22|POSTGRES_DB=stell22_integrity)
        fail "контейнер объявляет запрещённую базу"
        ;;
      POSTGRES_USER=stell22) ok_user=1 ;;
    esac
  done <<EOF
$envdump
EOF
  if [ "$ok_db" -ne 1 ] || [ "$ok_user" -ne 1 ]; then
    fail "контейнер не является изолированным drill-сервисом"
  fi

  if ! binding=$(docker port "$CONTAINER" 5432/tcp); then
    fail "не удалось прочитать порт контейнера"
  fi
  binding=$(printf '%s' "$binding" | tr -d '\r')
  case "$binding" in
    *'
'*|*' '*) fail "неоднозначный порт контейнера" ;;
    127.0.0.1:[0-9]*)
      portpart=${binding#127.0.0.1:}
      case "$portpart" in
        *[!0-9]*) fail "порт контейнера не локальный" ;;
      esac
      ;;
    *) fail "порт контейнера не локальный" ;;
  esac
  PORT_BINDING=$binding

  if ! admin_db=$(psql_at stell22_restore_drill_admin "SELECT current_database()"); then
    fail "не удалось прочитать current_database"
  fi
  admin_db=$(printf '%s' "$admin_db" | tr -d '[:space:]')
  if [ "$admin_db" != "stell22_restore_drill_admin" ]; then
    fail "current_database админской базы не совпал"
  fi

  if ! role=$(psql_at stell22_restore_drill_admin "SELECT current_user"); then
    fail "не удалось прочитать роль"
  fi
  role=$(printf '%s' "$role" | tr -d '[:space:]')
  if [ "$role" != "stell22" ]; then
    fail "роль подключения не stell22"
  fi

  if ! names=$(psql_at stell22_restore_drill_admin "SELECT datname FROM pg_database ORDER BY 1"); then
    fail "не удалось прочитать список баз"
  fi
  if printf '%s\n' "$names" | grep -x -q -e stell22 -e stell22_integrity; then
    fail "в кластере есть stell22 или stell22_integrity"
  fi
  if ! printf '%s\n' "$names" | grep -x -q stell22_restore_drill_admin; then
    fail "нет изолированной админской базы"
  fi
  CLUSTER_NAMES=$names
}

prove_marker() {
  nonce=$1
  case "$nonce" in
    *[!0-9a-f]*|"") fail "некорректный маркер кластера" ;;
  esac
  if [ "${#nonce}" -ne 32 ]; then
    fail "некорректный маркер кластера"
  fi
  if ! got=$(psql_at stell22_restore_drill_admin "SELECT nonce FROM stell22_drill_cluster_marker"); then
    fail "маркер кластера не прочитан"
  fi
  got=$(printf '%s' "$got" | tr -d '[:space:]')
  if [ "$got" != "$nonce" ]; then
    fail "маркер внутри сервиса не совпал"
  fi
}

create_database_if_absent() {
  db=$1
  if printf '%s\n' "$CLUSTER_NAMES" | grep -x -q "$db"; then
    fail "база $db уже существует; перезапись и DROP запрещены"
  fi
  if ! psql_at stell22_restore_drill_admin "CREATE DATABASE ${db}" >/dev/null; then
    fail "не удалось создать $db"
  fi
}

validate_archive() {
  archive=$1
  case "$archive" in
    *.sql.gz) ;;
    *) fail "архив должен заканчиваться на .sql.gz" ;;
  esac
  if [ -L "$archive" ] || [ -L "${archive}.sha256" ]; then
    fail "symlink вместо архива или checksum запрещён"
  fi
  if [ ! -f "$archive" ]; then
    fail "архив не найден"
  fi
  if [ ! -f "${archive}.sha256" ]; then
    fail "нет sidecar checksum"
  fi
  base=$(basename "$archive")
  case "$base" in
    *[!A-Za-z0-9._-]*) fail "недопустимое имя архива" ;;
  esac
  if ! WORK=$(mktemp -d "${TMPDIR:-/tmp}/stell22-restore-drill.XXXXXX"); then
    fail "не удалось создать временный каталог"
  fi
  chmod 700 "$WORK" || fail "не удалось закрыть временный каталог"
  # Snapshot first. Later steps read only this copy, then compare it with the
  # source once so a change during the copy fails closed.
  if ! cp -p -- "$archive" "$WORK/$base"; then
    fail "не удалось снять копию архива"
  fi
  if ! cp -p -- "${archive}.sha256" "$WORK/${base}.sha256"; then
    fail "не удалось снять копию checksum"
  fi
  staged="$WORK/$base"
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
    {
      if ($0 != "") exit 1
    }
    END { if (!seen) exit 1 }
  ' "$WORK/${base}.sha256"; then
    fail "sidecar checksum имеет неверный формат"
  fi
  if ! staged_line=$(sha256sum -t "$staged"); then
    fail "SHA-256 архива не сошёлся"
  fi
  STAGED_SHA=$(printf '%s' "$staged_line" | awk 'NR == 1 { print $1; exit }' | tr -d '\r')
  case "$STAGED_SHA" in
    *[!0-9a-f]*|"") fail "SHA-256 архива не сошёлся" ;;
  esac
  if [ "${#STAGED_SHA}" -ne 64 ]; then
    fail "SHA-256 архива не сошёлся"
  fi
  if ! (CDPATH= cd "$WORK" && sha256sum -c "${base}.sha256" >&2); then
    fail "SHA-256 архива не сошёлся"
  fi
  if ! source_line=$(sha256sum -t "$archive"); then
    fail "архив изменился во время проверки"
  fi
  source_sha=$(printf '%s' "$source_line" | awk 'NR == 1 { print $1; exit }' | tr -d '\r')
  if [ "$source_sha" != "$STAGED_SHA" ]; then
    fail "архив изменился во время проверки"
  fi
  if ! gzip -t "$staged"; then
    fail "gzip -t не принял архив"
  fi
  if ! after_line=$(sha256sum -t "$staged"); then
    fail "архив изменился во время проверки"
  fi
  after_sha=$(printf '%s' "$after_line" | awk 'NR == 1 { print $1; exit }' | tr -d '\r')
  if [ "$after_sha" != "$STAGED_SHA" ]; then
    fail "архив изменился во время проверки"
  fi
  chmod a-w "$staged" "$WORK/${base}.sha256" || fail "не удалось закрыть копию архива"
  if ! gunzip -c "$staged" > "$WORK/dump.sql"; then
    fail "gunzip завершился с ошибкой"
  fi
  if [ ! -s "$WORK/dump.sql" ]; then
    fail "распакованный SQL пуст"
  fi
  if ! grep -qx -e "-- PostgreSQL database dump" "$WORK/dump.sql"; then
    fail "в дампе нет заголовка plain SQL"
  fi
  if ! grep -qx -e "-- PostgreSQL database dump complete" "$WORK/dump.sql"; then
    fail "в дампе нет завершающей строки plain SQL"
  fi
  if grep -E -q -i '^[[:space:]]*(CREATE|DROP)[[:space:]]+DATABASE([[:space:]]|$)' "$WORK/dump.sql"; then
    fail "дамп содержит CREATE или DROP DATABASE"
  fi
  # PostgreSQL 17.10 psql executes a backslash command outside quotes, comments,
  # dollar quotes, double-quoted identifiers and COPY data. An apostrophe inside
  # "..." is not a string. This scan is not a complete SQL parser and is not a
  # claim that arbitrary SQL is safe. Provenance binds the staged digest to this
  # run; it does not prove the bytes came from pg_dump.
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
    fail "дамп содержит запрещённую meta-команду psql"
  fi
}

prove_provenance() {
  nonce=$1
  # Digest of the staged archive that gunzip already consumed, not a fresh
  # read of the caller's mutable path.
  hash=$STAGED_SHA
  case "$hash" in
    *[!0-9a-f]*|"") fail "не удалось прочитать checksum архива" ;;
  esac
  if [ "${#hash}" -ne 64 ]; then
    fail "не удалось прочитать checksum архива"
  fi
  if ! registered=$(psql_at stell22_restore_drill_admin "SELECT count(*) FROM stell22_drill_archive_provenance WHERE nonce = '${nonce}' AND sha256 = '${hash}'"); then
    fail "не удалось проверить происхождение архива"
  fi
  registered=$(printf '%s' "$registered" | tr -d '[:space:]')
  if [ "$registered" != "1" ]; then
    fail "архив не создан этим прогоном"
  fi
}

restore_into() {
  target=$1
  case "$target" in
    stell22_restore_drill_dst|stell22_restore_drill_fail|stell22_restore_drill_dirty) ;;
    *) fail "целевая база не разрешена" ;;
  esac
  if ! seen=$(psql_at "$target" "SELECT current_database()"); then
    fail "цель недоступна"
  fi
  seen=$(printf '%s' "$seen" | tr -d '[:space:]')
  if [ "$seen" != "$target" ]; then
    fail "current_database цели не совпал"
  fi
  if ! count=$(psql_at "$target" "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')"); then
    fail "не удалось проверить пустоту цели"
  fi
  count=$(printf '%s' "$count" | tr -d '[:space:]')
  if [ "$count" != "0" ]; then
    fail "цель не пуста; восстановление отменено"
  fi
  if ! docker exec -i "$CONTAINER" \
    psql -X -U stell22 -d "$target" -q -v ON_ERROR_STOP=1 --single-transaction -f - \
    < "$WORK/dump.sql" >/dev/null 2>"$WORK/psql.err"; then
    fail "psql не восстановил дамп в одной транзакции"
  fi
  echo "[restore-drill] RESTORE OK" >&2
}

cmd=${1:-}
shift || true

case "$cmd" in
  init)
    prove_container
    if ! reg=$(psql_at stell22_restore_drill_admin "SELECT to_regclass('public.stell22_drill_cluster_marker')"); then
      fail "не удалось проверить маркер"
    fi
    reg=$(printf '%s' "$reg" | tr -d '[:space:]')
    if [ -n "$reg" ]; then
      fail "маркер кластера уже существует"
    fi
    if ! nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n' | tr 'A-F' 'a-f'); then
      fail "не удалось создать маркер"
    fi
    case "$nonce" in
      *[!0-9a-f]*|"") fail "не удалось создать маркер" ;;
    esac
    if [ "${#nonce}" -ne 32 ]; then
      fail "не удалось создать маркер"
    fi
    if ! psql_at stell22_restore_drill_admin "CREATE TABLE stell22_drill_cluster_marker (nonce text PRIMARY KEY)" >/dev/null; then
      fail "не удалось записать маркер"
    fi
    if ! psql_at stell22_restore_drill_admin "INSERT INTO stell22_drill_cluster_marker (nonce) VALUES ('${nonce}')" >/dev/null; then
      fail "не удалось записать маркер"
    fi
    if ! psql_at stell22_restore_drill_admin "CREATE TABLE stell22_drill_archive_provenance (nonce text NOT NULL, sha256 text NOT NULL, PRIMARY KEY (nonce, sha256))" >/dev/null; then
      fail "не удалось подготовить учёт архива"
    fi
    prove_marker "$nonce"
    for db in \
      stell22_restore_drill_src \
      stell22_restore_drill_dst \
      stell22_restore_drill_other \
      stell22_restore_drill_fail \
      stell22_restore_drill_dirty
    do
      create_database_if_absent "$db"
    done
    printf 'NONCE=%s\n' "$nonce"
    printf 'CONTAINER=%s\n' "$CONTAINER"
    printf 'PORT=%s\n' "$PORT_BINDING"
    ;;
  identity)
    nonce=${STELL22_RESTORE_DRILL_NONCE:-}
    prove_container
    prove_marker "$nonce"
    printf 'NONCE=%s\n' "$nonce"
    printf 'CONTAINER=%s\n' "$CONTAINER"
    printf 'PORT=%s\n' "$PORT_BINDING"
    ;;
  restore)
    archive=${1:-}
    target=${2:-}
    nonce=${STELL22_RESTORE_DRILL_NONCE:-}
    if [ -z "$archive" ] || [ -z "$target" ]; then
      fail "нужны архив и имя disposable-базы"
    fi
    prove_container
    prove_marker "$nonce"
    case "$target" in
      stell22|stell22_integrity) fail "целевая база не разрешена" ;;
    esac
    validate_archive "$archive"
    prove_provenance "$nonce"
    restore_into "$target"
    ;;
  *)
    fail "команда не поддерживается"
    ;;
esac
