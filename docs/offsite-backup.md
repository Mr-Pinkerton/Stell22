# Ежедневная offsite-копия STELL22

STATUS: CODE ONLY  
PRODUCTION: NOT DEPLOYED  
SCHEDULER: NOT INSTALLED  
DELETION: SUSPENDED  
RESTORE OF PRODUCTION: NOT AUTHORIZED

Этот документ описывает код ежедневного резервного копирования. Он не разрешает включить его на боевом сервере, создать bucket, положить ключи, поставить timer или удалять старые копии.

Расписание новой системы: **03:00 Europe/Moscow**. Это **00:00 UTC**. Это не 03:00 UTC.

Старые инструкции в `DEPLOY-BEGET.md` и фраза «03:00 UTC» в `docs/production-backup-restore.md` относятся к прежнему локальному cron. Этот пакет их не меняет и timer не включает. Пока cron ещё запускает `scripts/backup-db.sh`, новый timer включать нельзя: два активных планировщика одновременно не допускаются. Переключение — отдельный контролируемый cutover.

## Архитектура

```text
PostgreSQL 17
    |
scripts/backup-db.sh          локальный producer, без замены
    |
проверенный локальный архив и sidecar SHA-256
    |
age, только публичный recipient, до сети
    |
Yandex Object Storage         приватный bucket, If-None-Match
    |
повторное скачивание ciphertext и сравнение SHA-256
    |
manifest
    |
success marker                публикуется последним
    |
health-check и внешняя проверка
```

Producer остаётся `scripts/backup-db.sh`: отдельный код выхода `pg_dump`, непустой plain SQL, gzip, `gzip -t`, SHA-256, публикация sidecar и затем архива, запрет перезаписи, `RETENTION SUSPENDED`. Orchestrator — `scripts/offsite-backup.sh`. Он не вызывает клиент базы и не подменяет producer.

Состояния:

| Состояние | Смысл |
| --- | --- |
| `BACKUP_CREATED` | Локальный producer этой попытки завершился, архив и sidecar проверены. Offsite ещё не подтверждён. |
| `OFFSITE_VERIFIED` | Шифр, upload, повторное чтение, SHA-256 ciphertext, manifest и marker подтверждены. |
| `RESTORE_VERIFIED` | Только отдельная изолированная проверка восстановления. Этот pipeline его не выдаёт. |
| `FAILED` | Попытка остановилась. Успешный marker не публикуется. |
| `INCOMPLETE` | Объект или локальная попытка есть, полный success contract нет. |
| `MISSING_BACKUP` | Подтверждённой копии за ожидаемый день нет, либо она старше лимита. |

`BACKUP SUCCESS` producer и HTTP 200 не являются `OFFSITE_VERIFIED`. ETag не используется как SHA-256. Наличие ключа без сверки байтов не является успехом.

## Инструменты

На хосте scheduler, не в git и не в CI этой задачи:

- `sh`, `flock` (util-linux), `sha256sum`, `gzip`, `df`, `find`, `awk`, `grep`, `mktemp`
- `age` — шифрование публичным recipient
- AWS CLI v2 с `aws s3api put-object --if-none-match`
- `systemd` достаточно новый, чтобы принять календарь с часовым поясом и `AccuracySec=1us`
- уже существующий producer и его `docker` / PostgreSQL 17 — только внутри `scripts/backup-db.sh`

Часовой пояс `Europe/Moscow` должен давать смещение `+0300`. Иначе orchestrator завершается с `REASON=timezone` и ничего не публикует.

## Конфигурация

Пример без секретов: `deploy/offsite-backup.env.example`.

Боевой файл, когда его отдельно разрешат, лежит вне git, режим `0600`, например `/etc/stell22/offsite-backup.env`. В нём только публичный recipient `age1...`. Строка `AGE-SECRET-KEY` запрещена.

Переменные:

| Имя | Смысл |
| --- | --- |
| `OFFSITE_ENDPOINT` | Только `https://storage.yandexcloud.net` |
| `OFFSITE_BUCKET` | Приватный bucket |
| `OFFSITE_REGION` | `ru-central1` |
| `OFFSITE_PREFIX` | `stell22/offsite/v1` |
| `OFFSITE_AGE_RECIPIENT` | Публичный recipient |
| `OFFSITE_BACKUP_DIR` | Каталог локальных архивов producer |
| `OFFSITE_STATE_DIR` | Состояние попыток, не замена архивов |
| `OFFSITE_MIN_FREE_KB` | Минимум свободного места до старта |
| `OFFSITE_MAX_AGE_HOURS` | Порог health, по умолчанию 36 |
| `OFFSITE_GRACE_HHMM` | После 03:00, по умолчанию `0330` |
| `AWS_ACCESS_KEY_ID` | Только в окружении процесса при activation |
| `AWS_SECRET_ACCESS_KEY` | То же. Скрипт его не печатает |

`STELL22_OFFSITE_TEST_HOOKS=1` работает только вместе с `OFFSITE_ENVIRONMENT=synthetic`. На сервере это запрещено. `OFFSITE_ENVIRONMENT=production` такой режим отвергает.

## IAM

Отдельный аккаунт Yandex Cloud, отдельный приватный bucket, отдельный ключ доступа. Публичный ACL не ставить.

Минимальные действия: `s3:PutObject` и `s3:GetObject` на `stell22/offsite/v1/*`, плюс `s3:ListBucket` на этот prefix, если внешняя проверка перечисляет ключи. `s3:DeleteObject`, `s3:PutBucketAcl` и публичная политика не выдаются. Lifecycle deletion не включается.

## Шифрование и ключи

Шифруется локальный gzip до любого `PutObject`. В bucket уходит только ciphertext, manifest и marker.

Приватный ключ age:

- не коммитится;
- не кладётся на production VPS;
- не попадает в CI;
- не пишется в лог и manifest.

Хранить его в независимом офлайн-хранилище, не в том же аккаунте, где bucket, и не на Beget. Для расшифровки оператор приносит ключ в изолированную среду и уносит обратно.

Потеря recipient до upload останавливает запуск. Ошибка `age` ничего не помечает успешным и не удаляет уже лежащие копии.

Ротация: новый ключ создаётся офлайн, на сервер попадает только новый публичный recipient. Старые объекты остаются на старом ключе. Перешифровка старых объектов этим пакетом не делается: это была бы новая запись, и её нельзя проводить как перезапись.

## Ключи объектов

Дата — календарный день `Europe/Moscow`.

```text
stell22/offsite/v1/daily/YYYY-MM-DD/archive.age
stell22/offsite/v1/daily/YYYY-MM-DD/manifest.json
stell22/offsite/v1/daily/YYYY-MM-DD/SUCCESS
```

Имя локального архива `stell22_YYYY-MM-DD_HH-MM-SS.sql.gz` записано внутри manifest. Orchestrator берёт путь только из строки `BACKUP SUCCESS` текущего запуска и сверяет, что этого файла не было до запуска. Самый новый файл в каталоге не выбирается. Чужой или частичный архив (sidecar без архива) успехом не считается.

`PutObject` всегда с `If-None-Match: *`. Существующий ключ не перезаписывается. Повторная попытка продолжается только если скачанные байты совпали с локальным SHA-256 и размером. Иначе состояние `INCOMPLETE` / mismatch, объект остаётся как был.

Manifest версии 1 содержит: `version`, `backupDate`, `timezone`, `archiveName`, `createdAt`, `archiveSha256`, `ciphertextSha256`, `ciphertextSize`, `verificationResult`. Строк SQL и секретов в нём нет.

Marker пишется последним и только после проверки manifest и ciphertext. В нём `status=OFFSITE_VERIFIED`. Это не `RESTORE_VERIFIED`.

## Повторный запуск

- Уже проверенный marker этого дня: выход 0, `ALREADY=1`, producer не запускается, объекты не перезаписываются.
- Обрыв до marker: локальный архив и совпавший ciphertext сохраняются, запись продолжается с того же ключа только при совпадении байтов.
- Чужие байты по тому же ключу: остановка, без overwrite и без ложного успеха.
- Параллельный запуск: второй процесс не берёт `flock` и выходит с `REASON=concurrent`.

## Scheduler

Файлы лежат в репозитории и не устанавливаются:

- `deploy/systemd/stell22-offsite-backup.service`
- `deploy/systemd/stell22-offsite-backup.timer`
- `deploy/systemd/stell22-offsite-backup-onfailure.service`

```ini
OnCalendar=*-*-* 03:00:00 Europe/Moscow
Persistent=true
RandomizedDelaySec=0
AccuracySec=1us
```

`AccuracySec=1us` не даёт стандартной минутной точности systemd сдвинуть запуск. `RandomizedDelaySec=0` не добавляет случайную задержку.

- Ребут и пропущенный запуск при выключенной машине: `Persistent=true` запускает пропущенный слот один раз после включения.
- Долгий запуск: `Type=oneshot`, `TimeoutStartSec=6h`. Пока unit активен, timer не стартует вторую копию. Скрипт дополнительно держит `flock`.
- Сеть упала: marker не пишется, следующий запуск (следующая ночь или ручной старт unit после отдельного разрешения) продолжает ту же дату только при совпадении байтов.
- `OnFailure` вызывает `scripts/offsite-backup-health.sh`.

`systemctl enable` и `systemctl start` этим пакетом не выполняются. Crontab не меняется.

Cutover, когда его отдельно разрешат: в одном окне снять строку cron с `scripts/backup-db.sh` и только потом включить timer. Нельзя оставить оба активными. Откат automation: остановить и disable timer. Архивы при этом не удалять.

## Коды orchestrator

| Код | REASON |
| --- | --- |
| 0 | `OFFSITE_VERIFIED` |
| 10 | `configuration` |
| 11 | `missing-tool:...` |
| 12 | `low-disk` |
| 13 | `concurrent` |
| 14 | `producer-failure` |
| 15 | `missing-archive` |
| 16 | `checksum-failure` |
| 17 | `encryption-failure` |
| 18 | `upload-failure` |
| 19 | `remote-head-failure` |
| 20 | `remote-get-failure` |
| 21 | `remote-checksum-mismatch` |
| 22 | `manifest-failure` |
| 23 | `marker-failure` |
| 24 | `timezone` |
| 25 | `missing-recipient` |
| 31 | `INCOMPLETE` |

Stdout — строки `STATUS=`, `REASON=`, `BACKUP_DATE=`, `ARCHIVE_SHA256=`, `CIPHERTEXT_SHA256=`, `ALREADY=`, `RESTORE_VERIFIED=0`.

## Мониторинг

`scripts/offsite-backup-health.sh` читает последний подтверждённый marker, его возраст, полноту contract, пропуск сегодняшнего окна после `OFFSITE_GRACE_HHMM` и `last-run.env`.

| Код | STATUS |
| --- | --- |
| 0 | `OFFSITE_VERIFIED` или `RUNNING` |
| 30 | `MISSING_BACKUP` (`missing` или `missed`) |
| 31 | `INCOMPLETE` или `BACKUP_CREATED` |
| 32 | `FAILED` с reason последнего запуска |
| 33 | `MISSING_BACKUP` / `stale` |
| 34 | внешняя проверка отказалась работать как проверка с самого VPS |

Проверка на VPS не видит гибель самого VPS. Для этого есть `scripts/offsite-backup-external-check.sh`. Его нужно будет запускать с другой машины. `OFFSITE_EXTERNAL_LOCATION=vps` завершается отказом. Реальный внешний мониторинг в этой задаче не настраивается.

## Retention

Цель, не разрешение удалять:

- локально: 7 последних ежедневных копий;
- offsite: 30 ежедневных и 12 ежемесячных.

`scripts/offsite-backup-retention-plan.sh` только печатает классификацию. На вход — даты уже подтверждённых `OFFSITE_VERIFIED`, по одной на строку. Неподтверждённые, partial и неизвестные объекты классифицировать нельзя: скрипт останавливается и ничего не помечает к удалению.

Для дат старше 30 новейших ежедневных оставляется новейшая дата каждого месяца, не больше 12 месяцев. Остальные подтверждённые даты — `CANDIDATE`. `--delete` и `--apply` выходят с `DELETION_SUSPENDED` и ничего не стирают.

`RETENTION SUSPENDED` в `scripts/backup-db.sh` не изменён. S3 lifecycle deletion не включается. Неизвестные и частичные объекты не удаляются. Удаление на production возможно только отдельным решением после доказанного restore verification.

## Disaster recovery

Это порядок для человека после отдельного разрешения. Новый production restore здесь не реализован. `scripts/restore-db.sh` не меняется и остаётся отключённым. `scripts/production-backup-restore.sh` не ослабляется. На production Docker и production volume эта инструкция не выполняется.

1. Потерян Beget VPS. Bucket в отдельном аккаунте Yandex Object Storage этим фактом не уничтожается.
2. С рабочей машины вне VPS открыть приватный bucket и взять `daily/YYYY-MM-DD/SUCCESS`, `manifest.json` и `archive.age` нужного дня. Не брать объект без marker как успешную копию.
3. Посчитать SHA-256 скачанного `archive.age` и сверить с `ciphertextSha256` в marker и manifest. Размер тоже должен совпасть.
4. Приватный ключ age взять из независимого хранилища. Не копировать его на восстановленный VPS «навсегда» и не класть в git.
5. Расшифровать в изолированной среде: `age -d -i key.txt -o archive.sql.gz archive.age`.
6. Сверить SHA-256 расшифрованного gzip с `archiveSha256`. Выполнить `gzip -t`.
7. Операторский trust file для уже существующей изолированной проверки — контракт `PRODUCTION_BACKUP_V1` из `docs/production-backup-restore.md`. Этот пакет его не заменяет.
8. Поднять disposable PostgreSQL 17, не production volume и не контейнер приложения.
9. Изолированную проверку делать только отдельным уже существующим контуром, когда она разрешена. `RESTORE_VERIFIED` ставит тот контур, не upload в S3.
10. Если расшифровка, checksum или изолированное восстановление не сошлись — это `FAILED` / незавершённое восстановление. Не помечать день `RESTORE_VERIFIED`. Не удалять объект в bucket, чтобы «убрать ошибку».
11. Возврат production — отдельный gate. Этот документ его не открывает.

## Остановка

Остановить timer и service, когда это будет разрешено. Не удалять локальные архивы, ciphertext, manifest, marker и неизвестные ключи. Не включать lifecycle. Producer `scripts/backup-db.sh` после остановки offsite по-прежнему не удаляет старые копии сам.

## Что этот пакет не делает

Не читает и не пишет production DB. Не ставит cron и systemd на сервер. Не ходит в настоящий Yandex Object Storage. Не кладёт секреты. Не деплоит приложение. Не меняет `production_cost_flow`, маркетплейсы, банк, ДДС и инвентарь.
