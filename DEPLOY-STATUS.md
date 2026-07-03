# Статус боевого развёртывания

Прод развёрнут на VPS Beget (Ubuntu 24.04, Docker). Инструкция по установке
с нуля — `DEPLOY-BEGET.md`. Здесь — факты о текущем проде и шпаргалка по
обслуживанию.

## Что где

| Параметр | Значение |
|---|---|
| Сайт | https://stell22.ru (www → редирект на основной) |
| Сервер | VPS Beget, IP `109.172.46.138`, Ubuntu 24.04 |
| Вход по SSH | `ssh root@109.172.46.138` |
| Папка проекта | `/root/Stell22` |
| Оркестрация | `docker compose -f docker-compose.prod.yml` |
| Контейнеры | `stell22-db-prod` (Postgres), `stell22-app` (Next.js), `stell22-caddy` (HTTPS) |
| HTTPS | Caddy + Let's Encrypt (авто-продление) |
| Фаервол | ufw: открыты 22 (SSH), 80, 443 |
| Секреты | `/root/Stell22/.env` (НЕ в гите) |
| Логин админа | email задан скриптом (см. ниже), не для писем — просто логин |

## Обновление до новой версии

Безопасный путь (бэкап → pull → сборка → health-check → подсказка отката):

```bash
cd /root/Stell22
sh scripts/deploy.sh
```

Вручную то же самое:

```bash
cd /root/Stell22
sh scripts/backup-db.sh                                   # бэкап ПЕРЕД обновлением
git pull
docker compose -f docker-compose.prod.yml up -d --build   # миграции применит entrypoint
docker compose -f docker-compose.prod.yml logs -f app     # смотрим старт
```

> Код вшивается в образ при сборке — после `git pull` ОБЯЗАТЕЛЬНА пересборка
> (`--build`). Просто `git pull` без пересборки прод не обновит.

## Бэкапы БД

- Автоматически: cron каждую ночь в 03:00 (`crontab -l` для проверки).
  Копии в `/root/Stell22/backups/`, хранятся 14 дней, лог — `backups/backup.log`.
- Вручную: `sh scripts/backup-db.sh`
- Восстановление: `sh scripts/restore-db.sh backups/ИМЯ_ФАЙЛА.sql.gz`

## Смена email / пароля админа

```bash
docker compose -f docker-compose.prod.yml exec app \
  npx tsx scripts/set-admin-password.ts "email@домен.ru" "НОВЫЙ_ПАРОЛЬ"
```

Обновляет одну запись админа (id `user-admin`), дубля не создаёт.

## Приём выписок с почты (IMAP)

Банк присылает выписки 1С (`.txt`/`.zip`) на выделенный ящик (`tochka@stell22.ru`).
Cron-эндпойнт `/api/cron/fetch-statements` раз в час забирает непрочитанные
письма, распаковывает вложения и импортирует их той же логикой, что и ручная
загрузка (дедупликация, якорь остатка, карантин новых счетов).

Настройка (в `/root/Stell22/.env`, затем пересборка — см. «Обновление»):

```env
CRON_SECRET=<openssl rand -hex 24>
MAIL_IMAP_HOST=imap.beget.com
MAIL_IMAP_PORT=993
MAIL_IMAP_SECURE=true
MAIL_IMAP_USER=tochka@stell22.ru
MAIL_IMAP_PASSWORD=<пароль ящика>
MAIL_ALLOWED_SENDERS=informer@tochka.com   # отправитель банка «Точка»
MAIL_MARK_SEEN=true
```

Host-cron (раз в час). Через Caddy наружу; `-m 300` — таймаут:

```bash
0 * * * * curl -fsS -m 300 -X POST -H "Authorization: Bearer СЕКРЕТ" https://stell22.ru/api/cron/fetch-statements >> /root/Stell22/mail.log 2>&1
```

- Итог каждого прогона — в **Настройки → Логи** (источник «Выписки (почта)»);
  пустые прогоны без ошибок не логируются.
- Проверить вручную: тот же `curl` (ответ — JSON со счётчиками).
- Пусто `MAIL_IMAP_HOST` или `CRON_SECRET` → приём отключён (503/`disabled`).

## Частые команды

| Задача | Команда |
|---|---|
| Статус | `docker compose -f docker-compose.prod.yml ps` |
| Логи приложения | `docker compose -f docker-compose.prod.yml logs -f app` |
| Перезапуск app | `docker compose -f docker-compose.prod.yml restart app` |
| Остановить всё | `docker compose -f docker-compose.prod.yml down` |
| Health-check | `curl -s https://stell22.ru/api/health` → `{"status":"ok",...}` |

## Важные ограничения

- **Один инстанс** приложения (очередь пересчёта себестоимости в памяти).
  Горизонтальное масштабирование — только после переноса очереди в Redis/воркер.
- Ozon/WB, банк, термопринтер — заглушки; реальные API включаются вводом
  ключей в «Настройки → API».
- `POSTGRES_PASSWORD` в `.env` — только буквы/цифры (без `/ + @ %`), т.к.
  подставляется в URL подключения к БД.
