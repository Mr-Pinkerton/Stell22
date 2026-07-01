#!/bin/sh
# Восстановление базы Stell22 из копии, созданной backup-db.sh.
# ВНИМАНИЕ: перезаписывает текущие данные БД! Используйте осознанно.
#
# Запуск:  sh scripts/restore-db.sh backups/stell22_2026-07-01_03-00-00.sql.gz
set -e

if [ -z "$1" ]; then
  echo "Использование: sh scripts/restore-db.sh <файл_копии.sql.gz>" >&2
  exit 1
fi

DUMP="$1"
if [ ! -f "$DUMP" ]; then
  echo "Файл не найден: $DUMP" >&2
  exit 1
fi

COMPOSE_FILE="docker-compose.prod.yml"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB_USER="${DB_USER:-stell22}"
DB_NAME="${DB_NAME:-stell22}"
cd "$PROJECT_DIR"

printf "Точно восстановить '%s' поверх текущей БД? [y/N] " "$DUMP"
read -r ans
case "$ans" in
  y|Y) ;;
  *) echo "Отменено."; exit 0 ;;
esac

echo "[restore] Восстанавливаю из $DUMP ..."
gunzip -c "$DUMP" | docker compose -f "$COMPOSE_FILE" exec -T db \
  psql -U "$DB_USER" -d "$DB_NAME"

echo "[restore] Готово. Перезапустите приложение:"
echo "  docker compose -f $COMPOSE_FILE restart app"
