#!/bin/sh
# Обновление приложения Stell22 на проде.
# Сборка не применяет миграции. Роль stell22_app и pinned P1 должны уже быть готовы.
# Сбой после запуска не восстанавливает старую базу.
#
# Запуск на сервере:  cd /root/Stell22 && sh scripts/deploy.sh
# Из CI:              PREVIOUS_SHA=<старый SHA> DEPLOY_SHA=<новый SHA> sh scripts/deploy.sh
set -e

COMPOSE_FILE="docker-compose.prod.yml"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-20}"

# Точка отката приложения. Из CI передаётся PREVIOUS_SHA, снятый ДО checkout
# на новый релиз. Ручной запуск без переменной — текущий HEAD.
if [ -n "${PREVIOUS_SHA:-}" ]; then
  if ! git cat-file -e "${PREVIOUS_SHA}^{commit}"; then
    echo "!! PREVIOUS_SHA не является коммитом: $PREVIOUS_SHA" >&2
    exit 1
  fi
  PREV_COMMIT_FULL="$(git rev-parse "$PREVIOUS_SHA")"
else
  PREV_COMMIT_FULL="$(git rev-parse HEAD)"
fi
PREV_COMMIT="$(git rev-parse --short "$PREV_COMMIT_FULL")"
echo "    Rollback target: $PREV_COMMIT_FULL"
LAST_BACKUP=""

wait_for_health() {
  i=1
  while [ "$i" -le "$HEALTH_RETRIES" ]; do
    if docker compose -f "$COMPOSE_FILE" exec -T app \
        node -e "fetch('$HEALTH_URL').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    if [ "$i" -eq "$HEALTH_RETRIES" ]; then
      return 1
    fi
    sleep 3
    i=$((i + 1))
  done
  return 1
}

forward_recovery() {
  echo "RESULT=FORWARD_RECOVERY" >&2
  echo "SCHEMA_ROLLBACK=NO" >&2
  echo "DATABASE_RESTORE=NO" >&2
  docker compose -f "$COMPOSE_FILE" stop app >/dev/null 2>&1 || true
  echo "!! Приложение остановлено. Старая база не восстанавливается." >&2
  echo "!! Логи: docker compose -f $COMPOSE_FILE logs --tail=50 app" >&2
  exit 1
}

app_role_ready() {
  ready=$(docker exec stell22-db-prod psql -X -U stell22 -d stell22 -q -v ON_ERROR_STOP=1 -At -c "BEGIN TRANSACTION READ ONLY; SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stell22_app' AND rolcanlogin AND NOT rolsuper) AND EXISTS (SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = '20261010210000_psr_p3_s2_b_batch_receipt_provenance' AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count > 0) THEN 'READY' ELSE 'NOT_READY' END; ROLLBACK;") || return 1
  [ "$ready" = "READY" ]
}

echo "==> [0/5] Проверка P1 перед выкатом нового писателя"
sh scripts/p1-writer-preflight.sh

echo "==> [1/5] Бэкап базы перед деплоем"
sh scripts/backup-db.sh
LAST_BACKUP="$(ls -1t backups/stell22_*.sql.gz 2>/dev/null | head -1 || true)"

echo "==> [2/5] Забираю свежий код без reset --hard (был на $PREV_COMMIT)"
if [ -n "${DEPLOY_SHA:-}" ]; then
  echo "    Целевой SHA: $DEPLOY_SHA"
  git fetch origin
  DEPLOY_SHA="$(git rev-parse "$DEPLOY_SHA")"
  sh scripts/release-checkout.sh "$DEPLOY_SHA"
else
  echo "RESULT=STOP_CHECKOUT" >&2
  echo "DATABASE_RESTORE=NO" >&2
  exit 1
fi

NEW_COMMIT="$(git rev-parse --short HEAD)"
NEW_COMMIT_FULL="$(git rev-parse HEAD)"
if [ -n "${DEPLOY_SHA:-}" ] && [ "$NEW_COMMIT_FULL" != "$DEPLOY_SHA" ]; then
  echo "!! HEAD $NEW_COMMIT_FULL != DEPLOY_SHA $DEPLOY_SHA" >&2
  exit 1
fi
if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then
  echo "    Изменений нет ($NEW_COMMIT). Пересобираю на всякий случай."
else
  echo "    Обновление: $PREV_COMMIT -> $NEW_COMMIT"
fi

echo "==> [3/5] Проверяю роль stell22_app и pinned P1 до запуска образа"
if ! app_role_ready; then
  echo "RESULT=STOP_APP_ROLE" >&2
  echo "DATABASE_RESTORE=NO" >&2
  echo "!! Новый образ не запускается: stell22_app не готов или P1 не применён мигратором." >&2
  exit 1
fi

echo "==> [4/5] Сборка и запуск приложения без миграции на старте"
if ! docker compose -f "$COMPOSE_FILE" build app; then
  echo "RESULT=STOP_APP_START" >&2
  echo "DATABASE_RESTORE=NO" >&2
  exit 1
fi
if ! docker compose -f "$COMPOSE_FILE" up -d --no-deps app; then
  echo "RESULT=STOP_APP_START" >&2
  echo "DATABASE_RESTORE=NO" >&2
  exit 1
fi

echo "==> [5/5] Жду готовности приложения ($HEALTH_URL)"
if wait_for_health; then
  echo "    OK: приложение отвечает."
else
  echo "" >&2
  echo "!! Приложение не поднялось за $HEALTH_RETRIES попыток." >&2
  forward_recovery
fi

echo "==> Готово. Релиз $NEW_COMMIT в проде. Схема назад не откатывается."
echo "    Логи:    docker compose -f $COMPOSE_FILE logs -f app"
echo "    Повторный запуск приложения не откатывает схему и не вызывает restore-db.sh."
