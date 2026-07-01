#!/bin/sh
# Резервная копия базы Stell22 из docker-контейнера.
# Кладёт сжатый дамп в ./backups и удаляет копии старше RETENTION_DAYS.
#
# Ручной запуск:   sh scripts/backup-db.sh
# Автозапуск:      добавить в crontab (см. DEPLOY-BEGET.md).
set -e

COMPOSE_FILE="docker-compose.prod.yml"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_USER="${DB_USER:-stell22}"
DB_NAME="${DB_NAME:-stell22}"

cd "$PROJECT_DIR"
mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
OUT="$BACKUP_DIR/stell22_$STAMP.sql.gz"

echo "[backup] Создаю дамп $OUT ..."
docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$OUT"

# Проверяем, что файл не пустой.
if [ ! -s "$OUT" ]; then
  echo "[backup] ОШИБКА: дамп пустой, удаляю $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

echo "[backup] Готово: $(du -h "$OUT" | cut -f1)"

echo "[backup] Удаляю копии старше $RETENTION_DAYS дней ..."
find "$BACKUP_DIR" -name "stell22_*.sql.gz" -type f -mtime +"$RETENTION_DAYS" -delete

echo "[backup] Текущие копии:"
ls -1t "$BACKUP_DIR"/stell22_*.sql.gz 2>/dev/null | head -5 || true
