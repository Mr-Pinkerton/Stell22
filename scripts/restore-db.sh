#!/bin/sh
# Production restore is not authorized.
# This entry point never connects to a database and never reads a dump.
# A typed confirmation is not authorization.
echo "[restore] ОТКЛЮЧЕНО: production restore не разрешён. Скрипт не подключается к базе и не читает дамп." >&2
exit 1
