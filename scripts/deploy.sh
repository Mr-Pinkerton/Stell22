#!/bin/sh
# Безопасное обновление Stell22 на проде (Beget VPS, Docker).
# Порядок: бэкап БД → git pull → сборка (миграции применит entrypoint) →
# проверка здоровья. При сбое подсказывает, как откатиться.
#
# Запуск на сервере:  cd /root/Stell22 && sh scripts/deploy.sh
set -e

COMPOSE_FILE="docker-compose.prod.yml"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_RETRIES="${HEALTH_RETRIES:-20}"

# Коммит до обновления — точка отката, если новый релиз окажется битым.
PREV_COMMIT="$(git rev-parse --short HEAD)"

echo "==> [1/5] Бэкап базы перед деплоем"
sh scripts/backup-db.sh
LAST_BACKUP="$(ls -1t backups/stell22_*.sql.gz 2>/dev/null | head -1 || true)"

echo "==> [2/5] Забираю свежий код (был на $PREV_COMMIT)"
git pull

NEW_COMMIT="$(git rev-parse --short HEAD)"
if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then
  echo "    Изменений нет ($NEW_COMMIT). Пересобираю на всякий случай."
else
  echo "    Обновление: $PREV_COMMIT -> $NEW_COMMIT"
fi

echo "==> [3/5] Сборка и запуск (migrate deploy выполнит entrypoint контейнера)"
docker compose -f "$COMPOSE_FILE" up -d --build

echo "==> [4/5] Жду готовности приложения ($HEALTH_URL)"
i=1
while [ "$i" -le "$HEALTH_RETRIES" ]; do
  if docker compose -f "$COMPOSE_FILE" exec -T app \
      node -e "fetch('$HEALTH_URL').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "    OK: приложение отвечает."
    break
  fi
  if [ "$i" -eq "$HEALTH_RETRIES" ]; then
    echo "" >&2
    echo "!! Приложение не поднялось за $HEALTH_RETRIES попыток." >&2
    echo "!! Логи:   docker compose -f $COMPOSE_FILE logs --tail=50 app" >&2
    echo "!! Откат кода:" >&2
    echo "     git checkout $PREV_COMMIT && docker compose -f $COMPOSE_FILE up -d --build" >&2
    if [ -n "$LAST_BACKUP" ]; then
      echo "!! Откат БД (только если миграция испортила данные):" >&2
      echo "     sh scripts/restore-db.sh $LAST_BACKUP" >&2
    fi
    exit 1
  fi
  sleep 3
  i=$((i + 1))
done

echo "==> [5/5] Готово. Релиз $NEW_COMMIT в проде."
echo "    Логи:    docker compose -f $COMPOSE_FILE logs -f app"
echo "    Откат:   git checkout $PREV_COMMIT && docker compose -f $COMPOSE_FILE up -d --build"
