# CI/CD Stell22

Обычный `git push` в `main` **не** выкатывает production. На каждый push и PR
в `main` гоняется только проверка кода. Выкат на прод — отдельная ручная
кнопка в GitHub Actions.

```text
Cursor → commit / push в main
        ↓
GitHub Actions: CI
  checkout → npm ci → prisma generate
  → typecheck → eslint → tests → production build
        ↓
вручную: Actions → Production Deploy → Run workflow
        ↓
resolve origin/main SHA
        ↓
тот же reusable CI (workflow_call) на этом SHA
        ↓ only green
production environment
        ↓
preflight (read-only проверки БД, сейчас — PIN сотрудников)
        ↓
scripts/deploy.sh
  backup → checkout того же SHA → build → migrate → health
  при сбое build/start/health — откат приложения на предыдущий SHA
        ↓
повторный health-check и сверка задеплоенного SHA
```

## CI

Файл: `.github/workflows/ci.yml`

- Триггеры: `push` и `pull_request` в `main`, плюс `workflow_call`
- Секретов production **нет**
- Деплоя **нет**
- Production Deploy вызывает этот же файл (`uses: ./.github/workflows/ci.yml`)
  на том SHA, который затем уйдёт на сервер. Набор команд не дублируется.

Если CI красный — в логе видно упавший шаг (`TypeScript`, `Lint`, `Test`, `Build`).

## Production Deploy

Файл: `.github/workflows/deploy-production.yml`

- Триггер: только `workflow_dispatch` (кнопка **Run workflow**)
- Environment: `production` — сюда же кладутся секреты; позже можно включить
  required reviewers в настройках Environment без правки YAML
- Concurrency: группа `production-deploy`, второй запуск **ждёт** первый
  (`cancel-in-progress: false`)
- Деплоится тот же SHA `origin/main`, который только что проверил reusable CI
- Job `deploy` имеет `needs: [resolve-sha, ci]` и `environment: production`
  — SSH-секреты недоступны, пока CI не зелёный

Перед SSH workflow материализует orchestrator из `EXPECTED_SHA` во временный
файл и запускает его **без checkout**. Preflight тоже берётся из `EXPECTED_SHA`
во временный файл; git tree не меняется, пока preflight не прошёл. До checkout
фиксируется `PREVIOUS_SHA` (текущий HEAD). Checkout — только после `PREFLIGHT OK`,
затем `deploy.sh` с `PREVIOUS_SHA` + `DEPLOY_SHA`, verify SHA и health.
При сбое нового релиза `deploy.sh` откатывает приложение на `PREVIOUS_SHA`,
не на уже переключённый `EXPECTED_SHA`.

## GitHub Secrets

Создайте Environment **`production`** в настройках репозитория
(Settings → Environments) и добавьте секреты **туда**, не в CI.

| Secret | Назначение | Пример значения (не коммитить) |
|---|---|---|
| `PROD_HOST` | IP или DNS сервера | *(ваш хост)* |
| `PROD_USER` | SSH-пользователь | `root` на текущем проде допустим |
| `PROD_SSH_KEY` | Приватный ключ целиком | `-----BEGIN … PRIVATE KEY-----` |
| `PROD_PORT` | SSH-порт, необязательный | `22` (если пусто — 22) |
| `PROD_APP_DIR` | Каталог репозитория на сервере | `/root/Stell22` |

Значения секретов в git и в эту документацию не записывать.

### SSH-ключ (один раз)

На своей машине, не в репозитории:

```bash
ssh-keygen -t ed25519 -f stell22-prod-deploy -C "github-actions-stell22" -N ""
```

Публичный ключ (`stell22-prod-deploy.pub`) — в `~/.ssh/authorized_keys`
пользователя `PROD_USER` на сервере. Приватный — в секрет `PROD_SSH_KEY`.

Отдельный deploy-user пока не создаём: текущий production user можно оставить.

## Preflight

Файл: `scripts/preflight-prod.sh`

Только чтение БД через `docker compose -f docker-compose.prod.yml exec db`.
Никаких `UPDATE`/`DELETE`/`INSERT`.

Сейчас:

1. ACTIVE сотрудники с PIN не из 4 цифр
2. Дубли ACTIVE PIN

В лог Actions попадают `id / fullName` и факт проблемы. Сами PIN не печатаются.

При ошибке скрипт пишет `PRECHECK FAILED` и выходит с кодом 1.

Вручную на сервере:

```bash
cd /root/Stell22   # или ваш PROD_APP_DIR
bash scripts/preflight-prod.sh
```

Новые инварианты деплоя добавляйте в этот скрипт, а не в YAML.

## Что делает deploy.sh

Существующий `scripts/deploy.sh` остаётся источником деплоя:

1. Бэкап БД (`scripts/backup-db.sh`)
2. Обновление кода (`git pull` вручную, либо фиксированный `DEPLOY_SHA` из CI)
3. `docker compose -f docker-compose.prod.yml up -d --build`
   (миграции применяет `docker-entrypoint.sh`)
4. Health: `GET /api/health` внутри контейнера `app`
5. При сбое build / start / health — автоматический откат **приложения**
   на `PREVIOUS_SHA` (из CI) или на HEAD до `git pull` (ручной запуск),
   повторная сборка и health-check:
   `DEPLOY FAILED, ROLLBACK SUCCESSFUL` или `DEPLOY FAILED, ROLLBACK FAILED`

CI/CD этот скрипт не дублирует. Rollback живёт только в `deploy.sh`
(ручной запуск ведёт себя так же).

## Операция backup

Речь только о `scripts/backup-db.sh`. `scripts/restore-db.sh` здесь не
меняется и остаётся отдельным блокером.

`pg_dump` запускается отдельной командой, и проверяется его собственный код
выхода. Сжатие — следующий шаг. Заголовок gzip сам по себе не считается
успешным дампом.

Архив публикуется только если прошли все проверки:

- `pg_dump` завершился с кодом 0;
- plain SQL содержит строку `-- PostgreSQL database dump` и завершающую
  строку `-- PostgreSQL database dump complete`;
- `gzip` завершился с кодом 0 и `gzip -t` принял архив;
- SHA-256 архива записан и сходится при `sha256sum -c`.

Сначала жёсткой ссылкой публикуется
`backups/stell22_<timestamp>.sql.gz.sha256`, и только потом
`backups/stell22_<timestamp>.sql.gz`. Архив — маркер публикации. Это не
одна файловая транзакция и не гарантия fsync при отключении питания.
SIGKILL между двумя ссылками может оставить checksum без архива; такой
файл не является опубликованной копией. Занятое имя не перезаписывается.
Строка `BACKUP SUCCESS` печатается только после обоих имён. Она не
означает, что копию восстанавливали: архив **NOT RESTORE-VERIFIED**, пока
нет отдельного disposable restore drill.

Временный каталог создаётся внутри каталога копий с `umask 077`.
Обработанные ошибки и сигналы HUP, INT, TERM его удаляют. SIGKILL и
отключение питания этот trap не выполняют. Оставшийся `.stell22-backup.*`
не является опубликованной копией; его удаляют вручную. Уже опубликованные
архивы при этом не удаляются.

`RETENTION_DAYS` по-прежнему по умолчанию 14. Расписание cron не меняется.
Автоматическое удаление остановлено (`RETENTION SUSPENDED`): ни старые
`stell22_*.sql.gz`, ни новый архив с checksum скрипт не удаляет. Диск будет
расти (`disk usage will grow`), пока отдельное решение не вернёт retention.
Неудачная попытка старые копии не удаляет.

Если свободно меньше 1 МиБ или запись не удалась, скрипт завершается с
ненулевым кодом, убирает только свой неопубликованный временный каталог и
оставляет существующие архивы на месте.

## Откат

Откатывается только приложение (git tree + контейнер). **Схема БД и
Prisma-миграции автоматически назад не откатываются.** Если новая миграция
уже применилась, предыдущий код может быть несовместим с новой схемой —
это нужно разбирать вручную.

Откат БД — только если миграция испортила данные:

```bash
sh scripts/restore-db.sh backups/<файл>.sql.gz
```

`restore-db.sh` спрашивает подтверждение и для CI не используется.

## Health

Единственный служебный эндпоинт: `GET /api/health`.

- 200 — процесс жив и БД отвечает
- 503 — БД недоступна

Production health **не** вводит PIN сотрудника и не ходит в `/login`.

Проверка с хоста после деплоя (если нужен публичный URL):

```bash
curl -fsS https://<ваш-домен>/api/health
```

## Ручной деплой без GitHub (запасной путь)

```bash
ssh <PROD_USER>@<PROD_HOST>
cd /root/Stell22
bash scripts/preflight-prod.sh
sh scripts/deploy.sh
```
