#!/bin/sh
# Owner-gated production role split and pinned P1.
# Without the authorization phrase this script does not connect to a database.
# It does not call restore-db.sh and it does not run git reset --hard.
# After pinned P1 commits, a failed application start does not restore an older database.
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

if ps -eo args | grep -E 'scripts/backup-db.sh|fetch-statements' | grep -v grep | grep -q .; then
  echo "RESULT=STOP_WRITER" >&2
  exit 1
fi

sh scripts/release-checkout.sh "$sha"

work="$(mktemp -d)"
restart_old=0
cleanup() {
  rm -rf "$work"
  docker exec stell22-db-prod rm -f /tmp/stell22-release-app.pgpass /tmp/stell22-release-migrator.pgpass >/dev/null 2>&1 || true
  if [ "$restart_old" = 1 ]; then
    docker start stell22-app >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if ! docker stop stell22-app >/dev/null; then
  echo "RESULT=STOP_WRITER" >&2
  exit 1
fi
restart_old=1

if ! docker compose -f docker-compose.prod.yml build app >/dev/null; then
  echo "RESULT=STOP_APP_START" >&2
  echo "DATABASE_RESTORE=NO" >&2
  exit 1
fi

catalog="$work/catalog.txt"
sql_file="$work/roles.sql"
db_image="$(docker inspect -f '{{.Image}}' stell22-app)"
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

if command -v node >/dev/null 2>&1; then
  APP_DB_PASSWORD="$APP_DB_PASSWORD" MIGRATOR_DB_PASSWORD="$MIGRATOR_DB_PASSWORD" node scripts/release-plan.cjs "$catalog" > "$sql_file" || {
    echo "RESULT=STOP_ROLE_TRANSITION" >&2
    echo "DATABASE_RESTORE=NO" >&2
    exit 1
  }
else
  APP_DB_PASSWORD="$APP_DB_PASSWORD" MIGRATOR_DB_PASSWORD="$MIGRATOR_DB_PASSWORD" docker run --rm --network none --memory 268435456 --cpus 0.25 --pids-limit 64 --entrypoint node \
    -e APP_DB_PASSWORD -e MIGRATOR_DB_PASSWORD \
    -v "$PWD/scripts/release-plan.cjs":/plan.cjs:ro \
    -v "$catalog":/catalog.txt:ro \
    "$db_image" /plan.cjs /catalog.txt > "$sql_file" || {
    echo "RESULT=STOP_ROLE_TRANSITION" >&2
    echo "DATABASE_RESTORE=NO" >&2
    exit 1
  }
fi
if grep -q '^RESULT=' "$sql_file"; then
  echo "RESULT=STOP_ROLE_TRANSITION" >&2
  echo "DATABASE_RESTORE=NO" >&2
  exit 1
fi

if ! docker exec -i stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At < "$sql_file" >/dev/null; then
  echo "RESULT=STOP_ROLE_TRANSITION" >&2
  echo "DATABASE_RESTORE=NO" >&2
  exit 1
fi

restriction="$(docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT has_schema_privilege('stell22_app', 'public', 'CREATE')::text || '|' || pg_has_role('stell22_app', 'stell22_migrator', 'member')::text || '|' || has_table_privilege('stell22_app', 'public.\"_prisma_migrations\"', 'SELECT')::text || '|' || has_table_privilege('stell22_app', 'public.\"_prisma_migrations\"', 'INSERT')::text")"
case "$restriction" in
  'false|false|true|false') ;;
  *)
    echo "RESULT=STOP_WRITER" >&2
    echo "DATABASE_RESTORE=NO" >&2
    exit 1
    ;;
esac

printf '%s\n' "127.0.0.1:*:*:stell22_app:${APP_DB_PASSWORD}" > "$work/app.pgpass"
docker cp "$work/app.pgpass" stell22-db-prod:/tmp/stell22-release-app.pgpass
docker exec -u root stell22-db-prod chown postgres:postgres /tmp/stell22-release-app.pgpass
docker exec -u root stell22-db-prod chmod 600 /tmp/stell22-release-app.pgpass
if docker exec -e PGPASSFILE=/tmp/stell22-release-app.pgpass stell22-db-prod psql -h 127.0.0.1 -X -U stell22_app -d stell22 -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "BEGIN; INSERT INTO public.\"_prisma_migrations\" (id, checksum, migration_name, started_at, applied_steps_count) VALUES ('writer-exclusion', 'x', 'writer_exclusion_probe', NOW(), 0); ROLLBACK;" >"$work/insert.out" 2>"$work/insert.err"; then
  echo "RESULT=STOP_WRITER" >&2
  echo "DATABASE_RESTORE=NO" >&2
  exit 1
fi
if ! grep -q '42501' "$work/insert.err"; then
  echo "RESULT=STOP_WRITER" >&2
  echo "DATABASE_RESTORE=NO" >&2
  exit 1
fi

app_image="$(docker compose -f docker-compose.prod.yml images -q app | awk 'NF { print; exit }')"
OUT="$work/app.url" ROLE=stell22_app python3 - <<'PY'
import os, pathlib, urllib.parse
url = "postgresql://" + os.environ["ROLE"] + ":" + urllib.parse.quote(os.environ["APP_DB_PASSWORD"], safe="") + "@127.0.0.1:5432/stell22?schema=public"
pathlib.Path(os.environ["OUT"]).write_text("DATABASE_URL=" + url + "\n")
PY
app_migrate=0
docker run --rm --pull never --network container:stell22-db-prod --memory 536870912 --cpus 0.25 --pids-limit 128 --entrypoint npx --env-file "$work/app.url" "$app_image" prisma migrate deploy --schema /app/prisma/schema.prisma >/dev/null 2>&1 || app_migrate=$?
p1_present="$(docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "SELECT CASE WHEN EXISTS (SELECT 1 FROM public.\"_prisma_migrations\" WHERE migration_name = '20261010210000_psr_p3_s2_b_batch_receipt_provenance' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count > 0) THEN 'PRESENT' ELSE 'ABSENT' END")"
if [ "$app_migrate" -eq 0 ] || [ "$p1_present" = "PRESENT" ]; then
  restart_old=0
  echo "RESULT=STOP_APP_ROLE" >&2
  echo "DATABASE_RESTORE=NO" >&2
  echo "SCHEMA_ROLLBACK=NO" >&2
  exit 1
fi

restart_old=0
OUT="$work/migrator.url" ROLE=stell22_migrator python3 - <<'PY'
import os, pathlib, urllib.parse
url = "postgresql://" + os.environ["ROLE"] + ":" + urllib.parse.quote(os.environ["MIGRATOR_DB_PASSWORD"], safe="") + "@127.0.0.1:5432/stell22?schema=public"
pathlib.Path(os.environ["OUT"]).write_text("DATABASE_URL=" + url + "\n")
PY
if ! docker run --rm --pull never --network container:stell22-db-prod --memory 536870912 --cpus 0.25 --pids-limit 128 --entrypoint npx --env-file "$work/migrator.url" "$app_image" prisma migrate deploy --schema /app/prisma/schema.prisma >/dev/null; then
  echo "RESULT=FORWARD_RECOVERY" >&2
  echo "DATABASE_RESTORE=NO" >&2
  echo "SCHEMA_ROLLBACK=NO" >&2
  exit 1
fi

if ! docker compose -f docker-compose.prod.yml up -d --no-deps app >/dev/null; then
  docker compose -f docker-compose.prod.yml stop app >/dev/null 2>&1 || true
  echo "RESULT=FORWARD_RECOVERY" >&2
  echo "DATABASE_RESTORE=NO" >&2
  echo "SCHEMA_ROLLBACK=NO" >&2
  exit 1
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
  docker compose -f docker-compose.prod.yml stop app >/dev/null 2>&1 || true
  echo "RESULT=FORWARD_RECOVERY" >&2
  echo "DATABASE_RESTORE=NO" >&2
  echo "SCHEMA_ROLLBACK=NO" >&2
  exit 1
fi

echo "RESULT=RELEASE_APPLIED"
echo "P1_APPLY=MIGRATOR"
echo "DATABASE_RESTORE=NO"
