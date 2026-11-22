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
проверка bucket: versioning Enabled, Object Lock COMPLIANCE >= 90 дней
    |
Selectel S3, пул ru-6, Москва  приватный bucket, If-None-Match
    |
повторное скачивание ciphertext и сравнение SHA-256
    |
manifest
    |
success marker                публикуется последним
    |
health-check и внешняя проверка
    |
еженедельная копия на SSD в РФ, отдельным компьютером
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
| `OFFSITE_ENDPOINT` | Только `https://s3.ru-6.storage.selcloud.ru` |
| `OFFSITE_BUCKET` | Приватный bucket в пуле ru-6 |
| `OFFSITE_REGION` | Только `ru-6` |
| `OFFSITE_PREFIX` | `stell22/offsite/v1` |
| `OFFSITE_AGE_RECIPIENT` | Публичный recipient |
| `OFFSITE_BACKUP_DIR` | Каталог локальных архивов producer |
| `OFFSITE_STATE_DIR` | Состояние попыток, не замена архивов |
| `OFFSITE_MIN_FREE_KB` | Минимум свободного места до старта |
| `OFFSITE_MAX_AGE_HOURS` | Порог свежести подтверждённой копии, по умолчанию 36 |
| `OFFSITE_RUN_MAX_SECONDS` | Допустимая длительность попытки после захвата lock, по умолчанию 21600. Отсчёт пишет только владелец lock. Превышение не останавливает процесс |
| `OFFSITE_GRACE_HHMM` | После 03:00, по умолчанию `0330` |
| `AWS_ACCESS_KEY_ID` | Только в окружении процесса при activation |
| `AWS_SECRET_ACCESS_KEY` | То же. Скрипт его не печатает |

`STELL22_OFFSITE_TEST_HOOKS=1` работает только вместе с `OFFSITE_ENVIRONMENT=synthetic`. На сервере это запрещено. `OFFSITE_ENVIRONMENT=production` такой режим отвергает.

## Selectel и территория РФ

Единственное облачное хранилище этого пакета — Selectel S3, пул `ru-6` (Москва). Endpoint и region заданы точно. Другой endpoint, другой пул Selectel и зарубежный region отвергаются до сети с `REASON=configuration`. Произвольный endpoint не конфигурируется.

Порядок подготовки аккаунта, когда его отдельно разрешат. Этот документ его не выполняет:

1. Отдельный аккаунт Selectel, не аккаунт Beget и не место хранения приватного ключа age.
2. Бакет в пуле `ru-6`. Versioning включён. Object Lock включён: это WORM. Default retention — `COMPLIANCE`, не короче 90 дней.
3. Публичный ACL не ставить. Lifecycle deletion не включать: ни Expiration, ни удаление неактуальных версий.
4. Отдельный ключ доступа только на этот бакет.

Перед первым `PutObject` каждого запуска orchestrator читает только поддерживаемые Selectel S3 вызовы:

- `GetBucketVersioning` — статус `Enabled`;
- `get-object-lock-configuration` — Object Lock включён, режим `COMPLIANCE`, `Days` не меньше 90 или `Years` не меньше 1.

`GOVERNANCE`, выключенный lock, suspended versioning, retention короче 90 дней и ошибка чтения дают `REASON=bucket-protection`. Объекты не пишутся. `OFFSITE_VERIFIED` не выдаётся. Уже лежащие объекты не переписываются и не удаляются.

Bucket Lifecycle через S3 API Selectel не поддерживает. Источник: таблица совместимости [S3 API Selectel](https://docs.selectel.ru/en/api/object-storage-s3/), строка Bucket Lifecycle. Вызов чтения lifecycle удалён и не заменён фиктивной проверкой. Runtime не доказывает, что автоматическое удаление выключено.

### Control-plane preflight перед activation

Activation не разрешается, пока этот preflight не выполнен отдельно и его результат не записан. Скрипт его не выполняет и не обращается к новому внешнему API.

Оператор в панели Selectel подтверждает для этого бакета:

- пул `ru-6`, Москва;
- versioning включён;
- Object Lock включён, default retention `COMPLIANCE`, не короче 90 дней;
- автоматическое удаление по сроку жизни выключено: нет правила, которое удаляет объекты или неактуальные версии.

Пока этой записи нет, activation не начинается.

## IAM

Политика бакета Selectel устроена так: что не разрешено, то запрещено. Источник: [bucket policy Selectel](https://docs.selectel.ru/en/s3/buckets/bucket-policy/about-bucket-policy/). Producer получает отдельный Allow и не получает `Action *`.

Действия над бакетом, resource `arn:aws:s3:::stell22-offsite-backups`:

- `s3:GetBucketVersioning`;
- `s3:GetBucketObjectLockConfiguration`;
- `s3:ListBucket` с условием `s3:prefix` = `stell22/offsite/v1/`, чтобы отсутствие объекта отличалось от отказа в доступе.

Действия над объектами, resource `arn:aws:s3:::stell22-offsite-backups/stell22/offsite/v1/*`:

- `s3:PutObject`;
- `s3:GetObject`.

Ресурс бакета не покрывает объекты. Ресурс объектов не покрывает чтение конфигурации бакета. Эти две группы не смешиваются.

Этому ключу не выдаются `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:PutBucketVersioning`, `s3:PutBucketObjectLockConfiguration`, `s3:BypassGovernanceRetention` и расширенные admin permissions. `s3:GetBucketObjectLockConfiguration` разрешает только чтение статуса lock, не его смену.

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

`age` пишет во временный файл каталога попытки. Конечный локальный `archive.age` публикуется только после ненулевого ciphertext, checksum и размера. Обрыв `age` удаляет этот временный файл и не оставляет частичный ciphertext под конечным именем. Уже подтверждённый ciphertext не перезаписывается.

Имя локального архива `stell22_YYYY-MM-DD_HH-MM-SS.sql.gz` записано внутри manifest. Orchestrator берёт путь только из строки `BACKUP SUCCESS` текущего запуска и сверяет, что этого файла не было до запуска. Самый новый файл в каталоге не выбирается. Чужой или частичный архив (sidecar без архива) успехом не считается.

`PutObject` всегда с `If-None-Match: *`. Существующий ключ не перезаписывается. Повторная попытка продолжается только если скачанные байты совпали с локальным SHA-256 и размером. Иначе состояние `INCOMPLETE` / mismatch, объект остаётся как был.

Manifest версии 1 содержит: `version`, `backupDate`, `timezone`, `archiveName`, `createdAt`, `archiveSha256`, `ciphertextSha256`, `ciphertextSize`, `verificationResult`. Строк SQL и секретов в нём нет.

Marker пишется последним и только после проверки manifest и ciphertext. В нём `status=OFFSITE_VERIFIED`. Это не `RESTORE_VERIFIED`.

## Повторный запуск

- Уже проверенный marker этого дня: выход 0, `ALREADY=1`, producer не запускается, объекты не перезаписываются.
- Обрыв до marker: локальный архив и совпавший ciphertext сохраняются, запись продолжается с того же ключа только при совпадении байтов.
- Чужие байты по тому же ключу: остановка, без overwrite и без ложного успеха.
- Параллельный запуск: второй процесс не берёт `flock`, не меняет отметку старта владельца и выходит с `REASON=concurrent`.

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
| 10 | `configuration`, либо `bucket-protection` |
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

`scripts/offsite-backup-health.sh` сначала читает `last-run.env` текущей московской даты. `FAILED` или `INCOMPLETE` этой даты возвращается сразу, даже если вчерашний marker ещё `OFFSITE_VERIFIED`. Вчерашняя копия при этом остаётся. После успешного повтора статус снова `OFFSITE_VERIFIED`. Дальше проверяются свежий marker, его возраст и пропуск окна после `OFFSITE_GRACE_HHMM`. Длительность `RUNNING` считается от `offsite-run.started`, который записывает только процесс, уже взявший lock.

| Код | STATUS |
| --- | --- |
| 0 | `OFFSITE_VERIFIED`, либо `RUNNING`, пока отметка владельца lock моложе `OFFSITE_RUN_MAX_SECONDS` |
| 30 | `MISSING_BACKUP` (`missing` или `missed`) |
| 31 | `INCOMPLETE` или `BACKUP_CREATED` |
| 32 | `FAILED` с reason последнего запуска |
| 33 | `MISSING_BACKUP` / `stale` |
| 34 | внешняя проверка отказалась работать как проверка с самого VPS |
| 35 | `FAILED` / `run-exceeded` или `run-unmeasured`. Процесс backup не останавливается |

`scripts/offsite-backup-external-check.sh` применяет тот же предел возраста и то же окно текущего московского дня. Устаревшая или пропущенная копия даёт `MISSING_BACKUP` и ненулевой код. `OFFSITE_VERIFIED` в этом случае не печатается. Проверка читает только удалённые marker, manifest и ciphertext.

Проверка на VPS не видит гибель самого VPS. Внешнюю проверку нужно запускать с другой машины. `OFFSITE_EXTERNAL_LOCATION=vps` завершается отказом. Реальный внешний мониторинг в этой задаче не настраивается.

## Retention

Цель, не разрешение удалять:

- локально: 7 последних ежедневных копий;
- offsite: 30 ежедневных и 12 ежемесячных.

`scripts/offsite-backup-retention-plan.sh` только печатает классификацию. На вход — даты уже подтверждённых `OFFSITE_VERIFIED`, по одной на строку. Неподтверждённые, partial и неизвестные объекты классифицировать нельзя: скрипт останавливается и ничего не помечает к удалению.

Для дат старше 30 новейших ежедневных оставляется новейшая дата каждого месяца, не больше 12 месяцев. Остальные подтверждённые даты — `CANDIDATE`. `--delete` и `--apply` выходят с `DELETION_SUSPENDED` и ничего не стирают.

`RETENTION SUSPENDED` в `scripts/backup-db.sh` не изменён. Автоудаление по сроку жизни выключается в control-plane preflight; runtime это не проверяет. Неизвестные и частичные объекты не удаляются. Удаление на production возможно только отдельным решением после доказанного restore verification.

## Копия на SSD

Независимая копия лежит на съёмном SSD, который физически остаётся в РФ и не подключён к production VPS постоянно. Автоматического доступа к накопителю нет. Еженедельно оператор на отдельном компьютере, не на VPS, монтирует SSD сам.

Перед запуском оператор отдельно подтверждает, что `OFFSITE_SSD_ROOT` — каталог на этом смонтированном SSD и что диск физически находится в РФ. Скрипт этот факт не проверяет и не доказывает.

Затем оператор запускает:

```sh
OFFSITE_SSD_ROOT=/mnt/stell22-ssd \
OFFSITE_SSD_DATES='2026-11-16 2026-11-22' \
sh scripts/offsite-ssd-export.sh
```

Даты перечисляются явно. Для каждого дня скрипт сначала проверяет удалённый контракт `SUCCESS`, manifest и ciphertext. Затем объект скачивается во временный файл внутри `$OFFSITE_SSD_ROOT/daily/YYYY-MM-DD/` на той же файловой системе, что и конечный путь. SHA-256 считается по скачанным байтам. Конечное имя появляется одним POSIX `ln` и только если этого имени ещё нет. Временный файл после публикации или отказа удаляется. `SUCCESS` публикуется последним.

Повтор тех же байтов ничего не меняет. Другие байты по конечному имени останавливают запуск с `REASON=destination-mismatch` и не перезаписывают файл. Symlink на конечном имени не считается доверенной копией и не читается вместо файла. Отсутствующий день из заданного списка даёт `REASON=incomplete-set`.

Прерванный запуск не оставляет недописанный объект под конечным именем и не удаляет уже опубликованные файлы. Повтор после этого безопасен. Успех скрипта — `STATUS=SSD_COPIED`. Это не `OFFSITE_VERIFIED` и не `RESTORE_VERIFIED`.

Приватный ключ age на SSD не кладётся. Если в окружении есть `AGE_SECRET_KEY` или `OFFSITE_AGE_IDENTITY`, скрипт завершается с `REASON=private-key-refused` и ничего не скачивает. Удаления объектов в Selectel и на SSD нет.

Коды этого скрипта: `10` — `configuration`, `bucket-protection` или `private-key-refused`; `20` — `remote-get-failure`; `21` — `destination-mismatch` или `remote-checksum-mismatch`; `31` — `incomplete-set`; `0` — `SSD_COPIED`.

## Disaster recovery

Это порядок для человека после отдельного разрешения. Новый production restore здесь не реализован. `scripts/restore-db.sh` не меняется и остаётся отключённым. `scripts/production-backup-restore.sh` не ослабляется. На production Docker и production volume эта инструкция не выполняется.

1. Потерян Beget VPS. Бакет Selectel ru-6 в отдельном аккаунте и недельная копия на SSD этим фактом не уничтожаются.
2. С рабочей машины вне VPS открыть приватный bucket или каталог SSD и взять `daily/YYYY-MM-DD/SUCCESS`, `manifest.json` и `archive.age` нужного дня. Не брать объект без marker как успешную копию.
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

Не читает и не пишет production DB. Не ставит cron и systemd на сервер. Не создаёт бакет Selectel и не выпускает ключи. Не кладёт секреты. Не деплоит приложение. Не меняет `production_cost_flow`, маркетплейсы, банк, ДДС и инвентарь.
