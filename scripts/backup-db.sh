#!/bin/sh
# Резервная копия базы Stell22 из docker-контейнера.
#
# pg_dump запускается отдельной командой. Его код выхода проверяется сам
# по себе. gzip выполняется следующим шагом и не может скрыть ошибку дампа.
#
# Публикуются только оба имени:
#   backups/stell22_<timestamp>.sql.gz.sha256
#   backups/stell22_<timestamp>.sql.gz
# Сначала появляется checksum, затем архив. Архив — маркер публикации.
# Две жёсткие ссылки не являются одной файловой транзакцией.
# SIGKILL между ними может оставить checksum без архива. Это не копия.
# fsync и устойчивость к отключению питания скрипт не обещает.
# Строка BACKUP SUCCESS печатается только после всех проверок.
# Она не означает RESTORE-VERIFIED: отдельного disposable restore drill нет.
#
# Временный каталог лежит внутри каталога копий (тот же filesystem), umask 077.
# trap удаляет его при штатной ошибке и при HUP/INT/TERM.
# SIGKILL и отключение питания trap не выполняют. Каталог .stell22-backup.*
# может остаться. Это не опубликованная копия; удалить его нужно вручную.
# Уже опубликованные архивы этот сбой не удаляет.
#
# RETENTION_DAYS по умолчанию 14 и не меняется, но автоматическое удаление
# остановлено, пока нет доказанного restore drill. Диск будет расти.
# Неудачная попытка старые копии не удаляет.
#
# Ручной запуск:  sh scripts/backup-db.sh
# Автозапуск:     прежний crontab (см. DEPLOY-BEGET.md).
set -eu
umask 077

COMPOSE_FILE="docker-compose.prod.yml"
PROJECT_DIR="$(CDPATH= cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
BACKUP_DIR="${BACKUP_DIR%/}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_USER="${DB_USER:-stell22}"
DB_NAME="${DB_NAME:-stell22}"
MIN_FREE_KB=1024

WORK=""
DEST_GZ=""
DEST_SUM=""
PUBLISHED_ARCHIVE=""
PUBLISHED_CHECKSUM=""
SUM_INODE=""
GZ_INODE=""

fail() {
  echo "[backup] ОШИБКА: $1" >&2
  exit 1
}

remove_our_link() {
  path=$1
  inode=$2
  if [ -z "$path" ] || [ -z "$inode" ] || [ ! -e "$path" ]; then
    return 0
  fi
  got=$(stat -c %i "$path" 2>/dev/null || true)
  if [ "$got" = "$inode" ]; then
    rm -f "$path" || true
  fi
}

on_exit() {
  rc=$?
  if [ -n "$WORK" ]; then
    case "$WORK" in
      "$BACKUP_DIR"/.stell22-backup.*)
        rm -rf "$WORK" || true
        ;;
      *)
        echo "[backup] ОШИБКА: временный каталог вне каталога копий" >&2
        rc=1
        ;;
    esac
  fi
  if [ "$rc" -ne 0 ]; then
    remove_our_link "$DEST_SUM" "$SUM_INODE"
    remove_our_link "$DEST_GZ" "$GZ_INODE"
  fi
  exit "$rc"
}

trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$PROJECT_DIR"

if [ -z "$BACKUP_DIR" ] || [ "$BACKUP_DIR" = "/" ]; then
  fail "некорректный каталог копий"
fi

if ! mkdir -p "$BACKUP_DIR"; then
  fail "не удалось создать каталог копий"
fi

command -v docker >/dev/null 2>&1 || fail "docker не найден"
command -v gzip >/dev/null 2>&1 || fail "gzip не найден"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum не найден"
command -v df >/dev/null 2>&1 || fail "df не найден"
command -v awk >/dev/null 2>&1 || fail "awk не найден"
command -v grep >/dev/null 2>&1 || fail "grep не найден"
command -v mktemp >/dev/null 2>&1 || fail "mktemp не найден"
command -v date >/dev/null 2>&1 || fail "date не найден"

avail=$(df -Pk "$BACKUP_DIR" | awk 'NR > 1 {
  for (i = 1; i <= NF; i++) {
    if ($i ~ /%$/) {
      print $(i - 1)
      exit
    }
  }
}') || true

case "$avail" in
  ""|*[!0-9]*) fail "не удалось прочитать свободное место" ;;
esac

while :; do
  case "$avail" in
    0) break ;;
    0*) avail=${avail#0} ;;
    *) break ;;
  esac
done

if [ "$avail" -lt "$MIN_FREE_KB" ]; then
  fail "недостаточно свободного места (${avail} KiB). Существующие копии не изменены."
fi

if ! WORK=$(mktemp -d "$BACKUP_DIR/.stell22-backup.XXXXXX"); then
  fail "не удалось создать временный каталог. Существующие копии не изменены."
fi

case "$WORK" in
  "$BACKUP_DIR"/.stell22-backup.*) ;;
  *) fail "временный каталог создан вне каталога копий" ;;
esac

chmod 700 "$WORK" || fail "не удалось ограничить права временного каталога"

if ! STAMP=$(date +%Y-%m-%d_%H-%M-%S); then
  fail "не удалось получить метку времени"
fi

case "$STAMP" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) fail "некорректная метка времени" ;;
esac

BASE="stell22_${STAMP}.sql.gz"
SQL="$WORK/dump.sql"
GZ="$WORK/$BASE"
SUM="$WORK/$BASE.sha256"
DEST_GZ="$BACKUP_DIR/$BASE"
DEST_SUM="$BACKUP_DIR/$BASE.sha256"

if ! docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U "$DB_USER" "$DB_NAME" > "$SQL"; then
  fail "pg_dump завершился с ошибкой. Архив не опубликован."
fi

if [ ! -s "$SQL" ]; then
  fail "дамп пустой. Архив не опубликован."
fi

if ! grep -qx -e "-- PostgreSQL database dump" "$SQL"; then
  fail "в дампе нет заголовка plain SQL PostgreSQL. Архив не опубликован."
fi

if ! grep -qx -e "-- PostgreSQL database dump complete" "$SQL"; then
  fail "дамп не содержит завершающую строку plain SQL. Архив не опубликован."
fi

if ! gzip -c "$SQL" > "$GZ"; then
  fail "gzip не смог сжать дамп. Архив не опубликован."
fi

if ! gzip -t "$GZ"; then
  fail "проверка целостности gzip не пройдена. Архив не опубликован."
fi

if ! (CDPATH= cd "$WORK" && sha256sum "$BASE" > "$BASE.sha256"); then
  fail "не удалось вычислить SHA-256. Архив не опубликован."
fi

if ! (CDPATH= cd "$WORK" && sha256sum -c "$BASE.sha256"); then
  fail "проверка SHA-256 не пройдена. Архив не опубликован."
fi

if ! chmod 600 "$GZ" "$SUM"; then
  fail "не удалось ограничить права архива."
fi

if [ -e "$DEST_GZ" ] || [ -e "$DEST_SUM" ]; then
  fail "имя $BASE уже занято. Перезапись запрещена. Существующие копии не изменены."
fi

if ! SUM_INODE=$(stat -c %i "$SUM"); then
  fail "не удалось прочитать inode контрольной суммы."
fi
if ! GZ_INODE=$(stat -c %i "$GZ"); then
  fail "не удалось прочитать inode архива."
fi

# Checksum first. The archive link is the publication marker and is last.
# The two links are not one transaction. SIGKILL between them can leave
# an orphan checksum and must not leave the .sql.gz.
if ! ln "$SUM" "$DEST_SUM"; then
  fail "не удалось опубликовать контрольную сумму. Архив не опубликован."
fi
PUBLISHED_CHECKSUM=$DEST_SUM

if ! ln "$GZ" "$DEST_GZ"; then
  fail "не удалось опубликовать архив. Контрольная сумма этой попытки снята."
fi
PUBLISHED_ARCHIVE=$DEST_GZ

echo "[backup] RETENTION SUSPENDED: automatic deletion is blocked. RETENTION_DAYS=${RETENTION_DAYS} is unchanged and is not applied. disk usage will grow until a separate restore drill. This archive is NOT RESTORE-VERIFIED." >&2
echo "[backup] BACKUP SUCCESS: $DEST_GZ"
