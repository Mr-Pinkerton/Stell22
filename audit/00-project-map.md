# Этап 0: карта проекта и архитектуры Stell22

Аудит HEAD, **без правок приложения**. Назначение сущностей — по фактическому коду, не по имени.

Снимок: **2026-09-03**. Graphify (`graphify-out/GRAPH_REPORT.md`) собран с `cfb15cc8` и слегка отстаёт от HEAD — факты ниже сверены по исходникам.

---

## 1. Текущее состояние

| Параметр | Значение | Источник |
| -------- | -------- | -------- |
| Branch | `main` | `git rev-parse --abbrev-ref HEAD` |
| HEAD | `f3ebbef42f388f4da9761d430464c4b35117b925` | `git rev-parse HEAD` |
| Node | v22.13.1 (CI/Docker: 22) | `node -v`; `.github/workflows/ci.yml`; `Dockerfile` `node:22-bookworm-slim` |
| Package manager | npm (`package-lock.json`) | `package.json` |
| Next.js | 16.2.9 | `package.json` / lock |
| React | 19.2.4 | `package.json` / lock |
| Prisma / `@prisma/client` | 6.19.3 | lock |
| Zod | **нет в зависимостях** | `package.json` |
| PostgreSQL | 17-alpine, БД `stell22` | `docker-compose.yml` L3–9; prod — `docker-compose.prod.yml` |
| Локальный порт БД | хост `5434` → контейнер `5432` | `docker-compose.yml` L10–12; `.env.example` `DATABASE_URL` |
| Prisma migrations | **26** каталогов | `prisma/migrations/` |
| `middleware.ts` | **нет** | Next 16 gate: `src/proxy.ts` `export async function proxy` |

### npm scripts (`package.json`)

| Script | Назначение |
| ------ | ---------- |
| `dev` / `build` / `start` | Next webpack; prod `next start` |
| `lint` / `typecheck` / `format*` | eslint, `tsc --noEmit`, prettier |
| `test` / `test:watch` | Vitest через `scripts/vitest-run.mjs` |
| `db:up` / `db:down` | docker compose Postgres |
| `db:migrate` / `db:generate` / `db:seed` / `db:reset` / `db:studio` | Prisma |
| `smoke:production` | `tsx scripts/smoke-production-reversal.ts` |

Seed: `"prisma": { "seed": "tsx prisma/seed.ts" }`. Сид **стирает** таблицы (`prisma/seed.ts`) и создаёт `admin@stell22.local`. В проде сид не запускается (`.env.example` L10–11).

### Docker / production

```text
Локально:  docker-compose.yml  → только Postgres
Прод:      Dockerfile ENTRYPOINT docker-entrypoint.sh
           → prisma migrate deploy
           → npm run start
           docker-compose.prod.yml: db + app + caddy (80/443)
           health: GET /api/health
```

- `docker-entrypoint.sh` — migrate-on-start, seed **не** вызывается.
- `scripts/deploy.sh` — backup → pull → rebuild → health; rollback SHA при сбое.
- GitHub: `ci.yml` (push/PR `main` + `workflow_call`); `deploy-production.yml` — **только** `workflow_dispatch`, сначала CI, затем SSH `scripts/ci-prod-remote.sh`.

### Стек слоёв (факт)

```text
UI (src/app + src/components)
  ↓ Server Actions ("use server" в src/server/*)
  ↓ lib/* (чистые расчёты) + validation throw new Error
  ↓ Prisma Client (src/server/db.ts)
  ↓ PostgreSQL
```

API-роутов мало: health + cron IMAP. Основной write-path — **Server Actions**, не REST.

Денежный тип: Prisma `Decimal` + `decimal.js` в расчётах (`prisma/schema.prisma` L7; `src/lib/cost.ts`). НДС в модели **нет**.

---

## 2. Логическое дерево системы

Нет сущности **Order** (клиентский заказ). Коммерция: **Sale / Supply** (маркетплейсы). Закупки: **Batch / Deal**. Производство: pull с терминала.

```text
ADMIN  (группа маршрутов src/app/(admin), навигация src/lib/navigation.ts)
├─ Дашборд          /dashboard     dashboard.ts
├─ Закупки          /purchases     purchases.ts  → Batch, RailLot, SimplePurchase
├─ Сотрудники       /employees     employees.ts  → Employee
├─ Номенклатура     /nomenclature  nomenclature.ts, materials.ts
├─ Отчёты           /reports       reports.ts, cost.ts, payroll.ts
├─ Финансы          /finance       finance.ts    → Account, CashFlow, Deal, Statement…
├─ Производство     /production    production.ts → ProductionOperation (правка/удаление)
├─ Продажи          /sales         marketplace.ts → Sale, Supply, MpStock
├─ Склад            /warehouse     warehouse.ts  → *Stock, Inventory
├─ Цели             /goals         goals.ts      → Goal
└─ Настройки        /settings      settings.ts, audit.ts → Setting, ChangeLog, SystemLog

TERMINAL  /terminal  (proxy PUBLIC)
├─ PIN-вход         terminalLoginByPin
├─ Выбор операции   terminal-app.tsx / home-screen.tsx
├─ Торцовка         submitTorcovka
├─ Присадка         submitPrisadka
├─ Упаковка         submitUpakovka
└─ Рабочие часы     submitHours

SERVER  src/server
├─ auth / session / proxy
├─ terminal / production / payroll / cost
├─ purchases / nomenclature / materials / warehouse
├─ finance / marketplace / goals / dashboard / reports
├─ settings / notifications / audit / export
└─ внутренние (не "use server"): db, change-log, system-log, cost-queue, statement-mail

DATABASE  43 модели Prisma — см. 00-data-model.md
```

### Связи слоёв (важные процессы)

```text
Терминал UI
  → terminal.ts submit*
  → prisma.$transaction (остатки + ProductionOperation)
  → cost-queue.enqueueRecalcBatchCosts → cost.ts recalcBatchCosts
  → ChangeLog

Админ страница RSC
  → proxy.ts (JWT подпись)
  → (admin)/layout requireAdmin
  → getX() read

Админ форма
  → server action (часто БЕЗ requireAdmin внутри — A22, session.ts L39–44)
  → Prisma + writeChangeLog
```

---

## 3. Точки входа

### 3.1 Пользовательские

| Entry | Кто вызывает | Что делает | Данные | Auth |
| ----- | ------------ | ---------- | ------ | ---- |
| `src/app/layout.tsx` | Next, все маршруты | HTML, Toaster, `robots: noindex` | нет | нет |
| `src/app/page.tsx` `/` | браузер | `redirect("/dashboard")` | нет | proxy + admin layout |
| `src/app/login/page.tsx` | `/login` | если сессия → dashboard, иначе `LoginForm` | нет | публично |
| `src/app/terminal/page.tsx` | `/terminal` | `getTerminalData()` → `TerminalApp` | **чтение** справочников/остатков | **нет** (proxy public) |
| `(admin)/layout.tsx` `AdminLayout` L6 | все `/dashboard`…`/settings` | `requireAdmin()` + sidebar | нет | ADMIN |
| 11 admin `page.tsx` | RSC | loaders `get*` → views | чтение | layout |
| `src/proxy.ts` `proxy` L17 | Next 16 request gate | JWT cookie; редирект `/login` | нет | любая валидная admin-сессия (роль **не** проверяется) |
| `GET /api/health` | Docker/LB/deploy | `SELECT 1` | нет | **нет** |
| `POST /api/cron/fetch-statements` | host cron curl | IMAP → `runMailIntakeAndLog` | CashFlow/Statement/Account… | `Authorization: Bearer $CRON_SECRET` |

Страницы admin: dashboard, purchases, employees, nomenclature, reports, finance, production, sales, warehouse, goals, settings.

**`"use server"` модули** (19 файлов в `src/server/`):  
`auth`, `audit`, `cost`, `dashboard`, `employees`, `export`, `finance`, `goals`, `marketplace`, `materials`, `nomenclature`, `notifications`, `payroll`, `production`, `purchases`, `reports`, `settings`, `terminal`, `warehouse`.

**Модель Server Actions (Next.js 16):** экспорт из `"use server"` — **публичная server-facing поверхность**, не «внутренний импорт». Используемые в prod-бандле actions вызываются сетевым POST (`Next-Action`); неиспользуемые могут быть удалены tree-shaking'ом сборки. **ID action / secure ID — не авторизация.** Client Component может импортировать action напрямую, но POST возможен и без UI (см. этап 0.5). Полная таблица экспортов — `audit/00.5-security-boundaries.md`.

Не `"use server"` (импорт только с сервера): `session.ts`, `db.ts`, `change-log.ts`, `system-log.ts`, `cost-queue.ts`, `statement-mail.ts`.

### 3.2 Системные

| Entry | Кто вызывает | Что делает | Данные | Auth |
| ----- | ------------ | ---------- | ------ | ---- |
| `docker-entrypoint.sh` | container start | `prisma migrate deploy` + `npm start` | DDL | доступ к хосту |
| `prisma/migrations/*` (26) | migrate deploy / `db:migrate` | схема | DDL | ops |
| `prisma/seed.ts` | `npm run db:seed` | **wipe** + моки + admin user | вся БД | локально |
| `scripts/deploy.sh` / `ci-prod-remote.sh` | SSH / GHA | backup, checkout SHA, rebuild | app + migrate via entrypoint | SSH |
| `scripts/preflight-prod.sh` | перед деплоем | read-only проверки | нет | SSH |
| `scripts/backup-db.sh` / `restore-db.sh` | cron / вручную | pg_dump / restore | файлы / **overwrite БД** | host |
| `scripts/fetch-statements.ts` | вручную `tsx` | тот же IMAP intake | финансы | env `MAIL_*` |
| `scripts/run-mp-sync.ts` | CLI | `syncMarketplacesAsUser(admin.id)` | Sale/Supply/ProductStock | доступ к БД |
| `scripts/set-admin-password.ts` | CLI | upsert пароля User | `User` | CLI |
| `scripts/smoke-production-reversal.ts` | `npm run smoke:production` | smoke реверса производства | тестовая БД | локально |
| probe/check `scripts/probe-*`, `check-*`, `debug-*` | вручную | Ozon/WB/сечения | обычно нет | секреты |
| `scripts/vitest-run.mjs` | `npm test` | канонический cwd + vitest | нет | — |

---

## 4. Auth — карта (не security-аудит)

### Типы пользователей

| Тип | Где живёт | Как входит |
| --- | --------- | ---------- |
| Admin | `User` (`UserRole` = **только** `ADMIN`) | email+password → JWT `stell22_session` (`auth.ts:signIn` ~L44, `lib/session.ts:encryptSession`) |
| Сотрудник терминала | `Employee` (**не** User) | PIN 4 цифры → JWT `stell22_terminal` (`terminal.ts:terminalLoginByPin` ~L267) |
| Другие роли | **нет** | enum `UserRole` содержит только `ADMIN` (`schema.prisma` L24–26) |

PIN: plaintext в `Employee.pin` (комментарий схемы L117: «не хэшируется»). На клиент терминала PIN **не** отдаётся (`terminal.ts:serEmployee` L80–81, пустая строка).

### Создание / проверка сессии

| Шаг | Код |
| --- | --- |
| Admin cookie | `auth.ts:signIn` → `encryptSession` + `SESSION_COOKIE` |
| Admin decrypt | `lib/session.ts:decryptSession`; `proxy.ts`; `session.ts:getCurrentUser` |
| User из БД | `getCurrentUser` L23–33 (React `cache`) |
| Admin gate | `requireAdmin` L46–51: нет user или `role !== "ADMIN"` → `redirect("/login")` |
| Terminal cookie | `terminalLoginByPin` → `encryptTerminalSession` |
| Terminal gate | `requireTerminalEmployee` L65–82: cookie + ACTIVE + optional employeeId match; **throw**, не redirect |
| Logout | `auth.ts:signOut`; `terminal.ts:terminalLogout` |

Cookie: httpOnly, `sameSite: lax`, `secure` только в production (`lib/session.ts` L39–45, L81–87). TTL admin 7 дней, terminal 12 часов. Секрет: `SESSION_SECRET`.

### Что защищает слои

| Слой | Покрывает | Не покрывает |
| ---- | --------- | ------------ |
| `proxy.ts` | страницы кроме `/login`, `/terminal`; только подпись JWT | роль ADMIN; `/api/*`; **Server Actions** |
| `(admin)/layout` | RSC-рендер admin | POST server action (явно: `session.ts` L39–44 **A22**) |
| `requireAdmin` внутри action | settings (большинство) + `syncMarketplaces` | остальные admin-мутации |
| `requireTerminalEmployee` | `submit*` + `getEmployeeEntries` | `getTerminalData`, login/logout, `reverse*` |

### Все вызовы `requireAdmin`

- `src/app/(admin)/layout.tsx` — `AdminLayout`
- `src/server/settings.ts` — `verifyApiCredentialsPassword`, `getApiCredentials`, `saveApiCredentials`, `saveAppSettings`, `getMinStockRows`, `saveMinStock`
- `src/server/marketplace.ts` — `syncMarketplaces`

### Все вызовы `requireTerminalEmployee`

- `src/server/terminal.ts` — `submitTorcovka`, `submitPrisadka`, `submitUpakovka`, `submitHours`, `getEmployeeEntries`

### Server actions / API без явной проверки — детали в этапе 0.5

Задокументировано A22: layout **не** выполняется на Server Action POST; `proxy.ts` matcher **исключает** `/api/*`, но **не** исключает POST actions на страницы.

**Факт на HEAD:** из 125 экспортов `"use server"` только **8** вызывают `requireAdmin` (settings×6 + `syncMarketplaces`); **5** — `requireTerminalEmployee` (submit* + `getEmployeeEntries`). Остальные полагаются на layout/proxy (недостаточно для POST).

**Prod build (`server-reference-manifest.json`):** 127 записей (125 экспортов + 2 внутренних хелпера `applyPrisadkaPick` / `applyUpakovkaPick`). **78** actions имеют worker `app/terminal/page` (публичный маршрут `/terminal`).

См. `audit/00.5-security-boundaries.md`, findings `SEC-001`…

---

## 5. Домены (факт)

| Domain | UI | Server | Prisma | Главные функции |
| ------ | -- | ------ | ------ | --------------- |
| Auth | `login-form.tsx`, header | `auth.ts`, `session.ts`, `proxy.ts` | User | `signIn`, `requireAdmin` |
| Terminal | `terminal-app.tsx`, `*-screen.tsx` | `terminal.ts` | ProductionOperation, *Stock, RailLot | `submitTorcovka/Prisadka/Upakovka/Hours` |
| Production admin | `production-view.tsx` | `production.ts` | ProductionOperation, lines | `updateProductionLineQuantity`, `deleteProductionOperation` |
| Payroll | `report-salaries-tab.tsx` | `payroll.ts`, `lib/payroll.ts` | Payment, PaymentBatchItem | `markEmployeePaid`, `getSalaryReport` |
| Purchases | `purchases-view.tsx`, `batch-form-dialog.tsx` | `purchases.ts` | Batch, RailLot, SimplePurchase | `createBatch`, `writeOffBatchRemainder` |
| Nomenclature | `nomenclature-view.tsx`, form dialogs | `nomenclature.ts`, `materials.ts` | Detail, Product, NomenclatureItem, Material, BOM | CRUD + archive |
| Employees | `employees-view.tsx` | `employees.ts` | Employee | create/update/archive/restore/delete |
| Finance / ДДС | `finance-view.tsx` | `finance.ts` | Account, CashFlow, Deal, Statement, AutoRule, Article, Counterparty | createCashFlow, importStatement, createDeal |
| Warehouse | `warehouse-view.tsx` | `warehouse.ts` | Inventory, Blank/Detail/Product/NomenclatureStock | `conductInventory` |
| Marketplace / Sales | `sales-view.tsx` | `marketplace.ts`, `ozon-api.ts`, `wb-api.ts` | Sale, Supply, MpStock | `syncMarketplaces` |
| Cost | reports cost tab | `cost.ts`, `cost-queue.ts`, `lib/cost*.ts` | BatchCost, (ProductCost **без писателей**) | `recalcBatchCosts`, `maybeFreezeBatch`, `getCostReport` |
| Reports | `reports-view.tsx` | `reports.ts` | reads | purchase/waste/salary/cost |
| Goals | `goals-view.tsx` | `goals.ts` | Goal, CalendarDay (**не используется**) | `createGoal` |
| Settings / audit | settings tabs | `settings.ts`, `audit.ts`, `change-log.ts` | Setting, ChangeLog, SystemLog | credentials, logs |
| Notifications | header panel | `notifications.ts` | Notification | `notifyEvent` |
| Dashboard | `dashboard-view.tsx` | `dashboard.ts` | aggregates | `getDashboardData` |
| Export | toolbar | `export.ts` | — | `buildXlsx` |

**Отсутствуют как процессы:** клиентский заказ, запуск в производство, назначение задания сотруднику. См. `00-business-flows.md`.

---

## 6. Инфраструктура и интеграции

Реальный код (не «запланировано»):

| Интеграция | Код | Статус |
| ---------- | --- | ------ |
| Банк 1С ClientBankExchange | `src/lib/bank-statement-1c.ts`, `finance.ts:importStatement` | парсер + импорт файла/IMAP |
| IMAP (приём выписок) | `statement-mail.ts`, `imapflow`, cron route | приём; SMTP-отправки **нет** |
| Ozon Seller API | `src/lib/ozon-api.ts`, `marketplace-http.ts` | HTTP; fallback stub если нет ключей в `Setting` |
| Wildberries | `src/lib/wb-api.ts` | то же |
| Sentry | `sentry.server.config.ts`, `instrumentation*.ts` | если `SENTRY_DSN` |
| Cookies JWT | `jose` HS256 | кастом; OAuth/NextAuth **нет** |
| Excel export | `exceljs` `export.ts` | файл в браузер |
| Печать этикеток | `src/lib/print-labels.ts` | `window.open` + browser print, не драйвер принтера |
| Filesystem app I/O | — | нет S3; бэкапы — shell на хосте |
| GitHub | — | только CI, не из приложения |

Ключи МП хранятся в `Setting` (`apiCred:`), не в env (`settings.ts`, `lib/api-credentials.ts`).

In-memory (один инстанс): `RateLimiter` (`lib/rate-limit.ts` L1–4), `enqueueRecalcBatchCosts` (`cost-queue.ts` L3–8).

---

## 7. Тестовая архитектура (обзор)

| Метрика | Значение |
| ------- | -------- |
| Файлы `*.test.ts` | **38** (`src/**/*.test.ts`, vitest) |
| `describe` / `it\|test` | **~133** / **~330** |
| `*.test.tsx` / e2e | **0** |
| Prisma integration tests | **0** в Vitest |

Покрытие: чистые формулы (`lib/cost*`, payroll, waste, stock helpers, 1C parse, PIN, rate-limit).  
**Нет тестов** server mutations, UI, live HTTP, session crypto. Подробнее — раздел 17 в этом файле ниже и таблица в чат-отчёте.

---

## 8. Крупные файлы (топ)

| Строк | Файл | Смешение |
| ----: | ---- | -------- |
| 1642 | `src/server/finance.ts` | счета, статьи, ДДС, переводы, сделки, импорт выписок, автоправила |
| 1054 | `src/server/terminal.ts` | PIN, 4 типа операций, stock, reverse |
| 899 | `batch-form-dialog.tsx` | форма партии + пакеты |
| 802 | `nomenclature-view.tsx` | мультитаб CRUD |
| 796 | `finance-view.tsx` | оболочка финансов |
| 792 | `marketplace.ts` | sync + stub + списание ГП |
| 701 | `mocks/fixtures.ts` | сид-данные |
| 692 | `ui/sidebar.tsx` | shadcn |
| 680 | `prisma/seed.ts` | wipe + demo |
| 593 | `product-form-dialog.tsx` | BOM |
| 585 | `server/cost.ts` | снапшоты + отчёт + freeze |
| 565 | `lib/cost-report.ts` | периодная себестоимость |
| 519 | `production-view.tsx` | журнал операций |
| 505 | `nomenclature.ts` | справочники |
| 444 | `production.ts` | правки/реверс |
| 439 | `ozon-api.ts` | HTTP client |
| 426 | `purchases.ts` | партии |
| 417 | `warehouse-inventory-tab.tsx` | инвентаризация UI |
| 415 | `warehouse.ts` | склад |
| 400 | `purchases-view.tsx` | закупки UI |

---

## 9. Опасные конструкции — inventory

Не исправлялось. Важное в business/server:

| Конструкция | Где |
| ----------- | --- |
| `TODO`/`FIXME`/`HACK` в `src/` | не найдено |
| `eslint-disable` | `src/hooks/use-mobile.ts` (1) |
| `@ts-ignore` / `@ts-expect-error` | 0 |
| `as unknown as` | `db.ts` Prisma singleton; log `details` в marketplace/statement-mail |
| `$queryRaw` | только health `SELECT 1` |
| `$executeRaw` / Unsafe | нет |
| `upsert` | terminal, warehouse, marketplace, settings, notifications |
| `deleteMany` | nomenclature BOM, finance transfers/statements, production lines, cost PRELIMINARY, mpStock |
| `findFirst` | finance name lookups, importKey skip (`finance.ts` ~L1407) |
| `dangerouslySetInnerHTML` | нет |
| `process.env` | `SESSION_SECRET`, `DATABASE_URL`, Sentry, `CRON_SECRET`, `MAIL_IMAP_*`, `NODE_ENV` |
| `console.error` | terminal PIN collision (1) |

---

## 10. Связанные документы этапа 0

- `audit/00-data-model.md` — все Prisma-модели
- `audit/00-business-flows.md` — процессы и state machines
- `audit/00-invariants.md` — уже выраженные правила
- `audit/00-audit-backlog.md` — очередь глубокой проверки (не баги)
