#!/bin/sh
# Безопасное обновление Stell22 на проде (Beget VPS, Docker).
# Порядок: бэкап БД → обновление кода → сборка (миграции применит entrypoint) →
# проверка здоровья. При сбое build/start/health откатывает только приложение
# на предыдущий SHA. Базу и Prisma-миграции назад не откатывает.
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

rollback_app() {
  echo "" >&2
  echo "!! Откатываю приложение на $PREV_COMMIT ($PREV_COMMIT_FULL)" >&2
  echo "!! Откат только кода/контейнера. Схема БД и Prisma-миграции НЕ откатываются." >&2
  if [ -n "$LAST_BACKUP" ]; then
    echo "!! Бэкап БД (вручную, если миграция испортила данные): $LAST_BACKUP" >&2
  fi

  if ! git cat-file -e "${PREV_COMMIT_FULL}^{commit}"; then
    echo "DEPLOY FAILED, ROLLBACK FAILED" >&2
    echo "!! Предыдущий SHA $PREV_COMMIT_FULL недоступен" >&2
    exit 1
  fi

  if git show-ref --verify --quiet refs/heads/main; then
    git checkout main
    git reset --hard "$PREV_COMMIT_FULL"
  else
    git checkout -B main "$PREV_COMMIT_FULL"
  fi

  if docker compose -f "$COMPOSE_FILE" up -d --build && wait_for_health; then
    echo "DEPLOY FAILED, ROLLBACK SUCCESSFUL" >&2
    echo "    Восстановлен релиз $PREV_COMMIT" >&2
    exit 1
  fi

  echo "DEPLOY FAILED, ROLLBACK FAILED" >&2
  echo "!! Логи: docker compose -f $COMPOSE_FILE logs --tail=50 app" >&2
  exit 1
}

echo "==> [1/5] Бэкап базы перед деплоем"
sh scripts/backup-db.sh
LAST_BACKUP="$(ls -1t backups/stell22_*.sql.gz 2>/dev/null | head -1 || true)"

echo "==> [2/5] Забираю свежий код (был на $PREV_COMMIT)"
if [ -n "${DEPLOY_SHA:-}" ]; then
  echo "    Целевой SHA: $DEPLOY_SHA"
  git fetch origin
  DEPLOY_SHA="$(git rev-parse "$DEPLOY_SHA")"
  if git show-ref --verify --quiet refs/heads/main; then
    git checkout main
    git reset --hard "$DEPLOY_SHA"
  else
    git checkout -B main "$DEPLOY_SHA"
  fi
else
  git pull
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

echo "==> [3/5] Сборка и запуск (migrate deploy выполнит entrypoint контейнера)"
if ! docker compose -f "$COMPOSE_FILE" up -d --build; then
  echo "!! Сборка или запуск не удались." >&2
  rollback_app
fi

echo "==> [4/5] Жду готовности приложения ($HEALTH_URL)"
if wait_for_health; then
  echo "    OK: приложение отвечает."
else
  echo "" >&2
  echo "!! Приложение не поднялось за $HEALTH_RETRIES попыток." >&2
  echo "!! Логи:   docker compose -f $COMPOSE_FILE logs --tail=50 app" >&2
  rollback_app
fi

echo "==> [5/5] Готово. Релиз $NEW_COMMIT в проде."
echo "    Логи:    docker compose -f $COMPOSE_FILE logs -f app"
echo "    Откат приложения (код, не БД): git checkout $PREV_COMMIT && docker compose -f $COMPOSE_FILE up -d --build"
