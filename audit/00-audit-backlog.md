# Этап 0: очередь глубокого аудита

**Устав:** `audit/00-audit-principles.md` — старое ТЗ не абсолютный source of truth; drift ≠ баг.

Это **не список багов**. Приоритет = насколько рано проверять на следующих этапах (бизнес-логика, деньги, склад, ЗП, security, concurrency, тесты, production).

Уровни: `CRITICAL TO AUDIT` | `HIGH` | `MEDIUM` | `LOW`.

---

REVIEW-001  
Domain: Auth  
Priority to audit: CRITICAL TO AUDIT

Question:  
Можно ли вызвать admin Server Actions (`createEmployee`, `createBatch`, `markEmployeePaid`, `createCashFlow`, `conductInventory`, `deleteProductionOperation`, …) без сессии, потому что `requireAdmin` есть только в layout, а layout не выполняется на POST action?

Why review:  
Явно задокументировано A22 (`session.ts` L39–44). Next.js не требует cookie для `"use server"` экспортов. `proxy.ts` matcher исключает поведение actions. Внутри большинства мутаций проверки нет.

Relevant code:  
`src/server/session.ts` L35–44; `src/app/(admin)/layout.tsx`; любой `"use server"` модуль без `requireAdmin` (employees/purchases/finance/payroll/production/warehouse/nomenclature/cost…).

---

REVIEW-002  
Domain: Auth / Secrets  
Priority to audit: CRITICAL TO AUDIT

Question:  
Доступен ли `loadStoredApiCredentials` как Server Action и отдаёт ли Ozon/WB ключи без `requireAdmin`?

Why review:  
Файл `settings.ts` начинается с `"use server"`. `getApiCredentials` проверяет admin; `loadStoredApiCredentials` (L51–63) — комментарий «без проверки сессии (для серверной синхронизации)», но экспорт публичный.

Relevant code:  
`src/server/settings.ts:loadStoredApiCredentials`; `getApiCredentials` L70.

---

REVIEW-003  
Domain: Auth / Terminal  
Priority to audit: HIGH

Question:  
Что утекает через публичный `getTerminalData` на `/terminal` без cookie: ставки ЗП, себестоимость партий, остатки, BOM, ФИО, даты рождения?

Why review:  
`/terminal` в `PUBLIC_PATHS` (`proxy.ts` L8). `getTerminalData` ~L187 без auth. PIN обнулён (`serEmployee`), но rates и `purchaseCost`/`totalCost` сериализуются.

Relevant code:  
`src/server/terminal.ts:getTerminalData`, `serEmployee`, `serBatch`; `src/app/terminal/page.tsx`.

---

REVIEW-004  
Domain: Auth / Terminal  
Priority to audit: HIGH

Question:  
Являются ли `reversePrisadkaLine` / `reverseUpakovkaOperation` вызываемыми Server Actions без auth? Первый аргумент — `Prisma.TransactionClient` — сломает наивный вызов, но поверхность всё равно есть.

Why review:  
Экспорт из `"use server"` файла (`terminal.ts` L555, L840) без `requireTerminalEmployee` / `requireAdmin`. Используются из `production.ts`.

Relevant code:  
`src/server/terminal.ts`; `src/server/production.ts`.

---

REVIEW-005  
Domain: Cost  
Priority to audit: CRITICAL TO AUDIT

Question:  
Гоночны ли `recalcBatchCosts` (deleteMany PRELIMINARY + create без `$transaction`) и `enqueueRecalcBatchCosts` (in-memory Map) при двух инстансах / параллельных торцовках?

Why review:  
Пересчёт не в одной транзакции с операцией. Очередь процесс-локальная (`cost-queue.ts` L3–12). `recalcBatchCosts` сам экспортирован из `"use server"` `cost.ts`.

Relevant code:  
`src/server/cost.ts:recalcBatchCosts` ~L435; `src/server/cost-queue.ts`; `freezeBatch` vs recalc.

---

REVIEW-006  
Domain: Cost  
Priority to audit: CRITICAL TO AUDIT

Question:  
Совпадает ли живой `getCostReport` (WAC по материалу, overhead из ДДС) с замороженным `BatchCost FINAL` и с правилами «МОДЕЛЬ СЕБЕСТОИМОСТИ» в `Описание проекта v2.txt`? Не magnифицирует ли `blendedCostPerMeterByMaterial` ошибки после обезличивания BlankStock?

Why review:  
ProductCost не пишется (A17). Изделие за период — средневзвешенное по породе (cost-integrity). Overhead = cashflows `isOverhead` — риск двойного счёта с ЗП, если статья настроена неправильно.

Relevant code:  
`src/lib/cost.ts`, `src/lib/cost-report.ts`, `src/server/cost.ts:getPeriodOverhead`; schema ProductCost L718–723; BlankStock L406–408.

---

REVIEW-007  
Domain: Inventory / Terminal  
Priority to audit: CRITICAL TO AUDIT

Question:  
Достаточно ли `updateMany`+`gte` против lost update / двойного списания при двух терминалах на одном пакете? Покрывает ли это Prisma isolation default?

Why review:  
Инвариант INV-007 реализован паттерном gte, без `SELECT FOR UPDATE`. Тестов Prisma/concurrency нет.

Relevant code:  
`terminal.ts` submit*; `production.ts` reverse; отсутствие `BEGIN; LOCK`.

---

REVIEW-008  
Domain: Payroll  
Priority to audit: CRITICAL TO AUDIT

Question:  
Нельзя ли обойти claim выплаты (`markEmployeePaid`) или выплатить дважды при изменении ставок между чтением ops и create Payment? Корректна ли сумма `amount` vs позже пересчитанный отчёт?

Why review:  
Сумма считается до tx из текущего Employee rates (`payroll.ts` L185–191), claim внутри tx. Ставки сотрудника можно сменить параллельно. Нет void/storno Payment.

Relevant code:  
`src/server/payroll.ts:markEmployeePaid`; `src/lib/payroll.ts`; `employees.ts:updateEmployee`.

---

REVIEW-009  
Domain: Marketplace / Warehouse  
Priority to audit: CRITICAL TO AUDIT

Question:  
Идемпотентны ли списание/возврат `ProductStock` по `Supply.deductedQty`/`shortfallQty` при повторном sync, смене статуса PENDING↔SHIPPED, нехватке ГП, ручной инвентаризации между синкам?

Why review:  
Один большой `$transaction` на `syncMarketplacesAsUser`. MpStock deleteMany+create. SKU изделия не unique в БД — неверный матчинг спишет чужой остаток.

Relevant code:  
`src/server/marketplace.ts` ~L581–726; schema Supply L773–781; Product sku L281–282.

---

REVIEW-010  
Domain: Finance / Cost  
Priority to audit: HIGH

Question:  
Может ли изменение Deal / CashFlow / Statement после списания реек изменить `Batch.totalCost` и PRELIMINARY снапшоты так, что история отхода/с/с разъедется? Что происходит после `frozenAt`?

Why review:  
`createDeal` nested create, затем `syncDeal` / `syncBatchTotalCost` **вне** одной tx с Deal (`00-project-map` / transactions inventory). Recalc после sync. Freeze отсекает recalc — но не отсекает ли запись `Batch.totalCost`?

Relevant code:  
`finance.ts:syncBatchTotalCost` ~L1109; `syncDeal`; `cost.ts` skip frozen; `createCashFlow` after-commit sync.

---

REVIEW-011  
Domain: Finance  
Priority to audit: HIGH

Question:  
Защищён ли импорт выписки от гонки двух одинаковых `importKey` (findFirst, индекс не unique)? Корректно ли восстанавливается якорь Account при `deleteStatement`?

Why review:  
INV-035: skip через findFirst. IMAP cron + ручный upload могут пересечься. `deleteStatement` меняет Account openingBalance.

Relevant code:  
`finance.ts` ~L1406–1414, `deleteStatement` ~L1603; schema CashFlow indexes.

---

REVIEW-012  
Domain: Finance  
Priority to audit: HIGH

Question:  
Попадают ли операции неподтверждённых счетов в KPI, себестоимость overhead, баланс? Совпадает ли кэш `Account.balance` с `computeAccountBalance` во всех экранах?

Why review:  
Схема обещает карантин (`confirmed`). Нужно проследить каждый read-path (dashboard, finance, cost overhead).

Relevant code:  
schema Account L546–550; `lib/account-balance.ts`; `finance.ts`; `dashboard.ts`; `cost.ts:getPeriodOverhead`.

---

REVIEW-013  
Domain: Production  
Priority to audit: HIGH

Question:  
Согласована ли семантика удаления TORCOVKA (рейки не возвращаются, отход растёт) с отчётом отхода и с/с партии? Можно ли удалением «стереть» факт расхода реек, оставив remainingQuantity заниженным навсегда?

Why review:  
Явное поведение `production.ts` L419–420. Партия может закрыться write-off/торцовкой; удаление ops меняет produced lines → recalc.

Relevant code:  
`production.ts:deleteProductionOperation`; `lib/waste.ts`; `recalcBatchCosts`.

---

REVIEW-014  
Domain: Inventory  
Priority to audit: HIGH

Question:  
Проведение инвентаризации ставит *Stock := actual без движения партий/провенанса. Ломает ли это последующий reverse упаковки/присадки (gte) и списание Supply?

Why review:  
`conductInventory` в tx выставляет qty. CLOSED не используется — документ можно ли править после CONDUCTED? (server говорит нет для actual, но нет delete).

Relevant code:  
`warehouse.ts:conductInventory` ~L307; InventoryStatus CLOSED unused.

---

REVIEW-015  
Domain: Purchases  
Priority to audit: HIGH

Question:  
Можно ли `updateBatch` (цены сорта, purchaseCost, сечение) после того как рейки уже торцуются, и как это бьёт PRELIMINARY vs уже выплаченные ops на незакрытой партии?

Why review:  
`updateBatch` не заворачивает freeze-check. `enqueueRecalcBatchCosts` после update.

Relevant code:  
`purchases.ts:updateBatch` ~L288; `cost.ts` freeze predicate только closedAt+paid.

---

REVIEW-016  
Domain: Auth / PIN  
Priority to audit: HIGH

Question:  
Достаточна ли уникальность PIN только на сервере при concurrent createEmployee? PIN plaintext в БД — угроза при утечке дампа?

Why review:  
Нет DB unique. INV-001. Rate limiter in-memory не шарится между репликами (`rate-limit.ts` L1–4).

Relevant code:  
`employees.ts:assertActivePin`; schema Employee.pin; `lib/rate-limit.ts`.

---

REVIEW-017  
Domain: ChangeLog  
Priority to audit: MEDIUM

Question:  
Можно ли восстановить «кто сделал» для производства/финансов, если `userId` почти никогда не пишется (только settings)? Терминал не пишет employeeId в ChangeLog.

Why review:  
`writeChangeLog` optional userId; grep показал userId только в `settings.ts`. ~79 вызовов.

Relevant code:  
`change-log.ts`; settings L98/L143/L206 vs terminal/finance/payroll.

---

REVIEW-018  
Domain: Payroll / Cost  
Priority to audit: HIGH

Question:  
Замораживается ли партия, у которой есть невыплаченные PRISADKA/UPAKOVKA/HOURS, но все TORCOVKA уже paid? Это намеренно (с/с материала от торцовки) или дыра в «все операции выплачены»?

Why review:  
`maybeFreezeBatch` считает только `type: TORCOVKA` unpaid (`cost.ts` L517–519). Комментарий freezeBatch L464–466 говорит «все её операции торцовки выплачены».

Relevant code:  
`cost.ts:maybeFreezeBatch`; `payroll.ts` loop torcovkaBatchIds.

---

REVIEW-019  
Domain: Data model  
Priority to audit: MEDIUM

Question:  
Какие потоки сломаются на `CalendarDay`, `ProductCost`, `Batch.customFields`, Goal.ARCHIVED, Inventory.CLOSED — мёртвые куски схемы vs недоделанный UI?

Why review:  
Схема обещает closeMonth / календарь целей / закрытие инвентаризации. Код writers отсутствует.

Relevant code:  
schema L686–695, L718–744, L76–79, L180, L822–825; `goals.ts` create-only.

---

REVIEW-020  
Domain: Marketplace  
Priority to audit: MEDIUM

Question:  
Когда используются stub vs live Ozon/WB? Может ли stub в production записать фиктивные Sale/Supply и списать ГП?

Why review:  
`marketplace.ts` fallback если нет credentials. Нужно условие + env/Setting.

Relevant code:  
`src/server/marketplace.ts`; `ozon-api.ts`; `wb-api.ts`; `settings` API creds.

---

REVIEW-021  
Domain: Transactions  
Priority to audit: HIGH

Question:  
Список write-paths без `$transaction` (REVIEW LATER из карты транзакций): createBatch nested+log; createDeal+syncDeal; CashFlow+syncBatchTotalCost; recalcBatchCosts; submitHours; большинство CRUD+ChangeLog. Где реально нарушается атомарность?

Why review:  
Nested create Prisma атомарно для детей; последующий sync/log/recalc — нет.

Relevant code:  
см. таблицу транзакций ниже; `purchases.ts:createBatch`; `finance.ts:createDeal` ~L1174.

---

REVIEW-022  
Domain: Tests  
Priority to audit: HIGH

Question:  
Какие инварианты склада/ЗП/с/с существуют только в `throw` и не покрыты Vitest (нет Prisma harness)? Что обязательно тестировать на этапе test-audit?

Why review:  
38 файлов / ~330 unit на чистые функции. 0 integration/e2e/UI.

Relevant code:  
`vitest.config.ts`; `src/lib/*.test.ts`; отсутствие `src/server/*.test.ts` кроме export.

---

REVIEW-023  
Domain: Production / SimplePurchase  
Priority to audit: MEDIUM

Question:  
SimplePurchase и Payment нельзя отменить/исправить. Как исправляют ошибочный приход крепежа или ошибочную выплату? Только inventory / новая выплата?

Why review:  
Нет update/delete/void в app.

Relevant code:  
`purchases.ts:createSimplePurchase`; `payroll.ts:markEmployeePaid`.

---

REVIEW-024  
Domain: Nomenclature  
Priority to audit: MEDIUM

Question:  
Замена BOM на `updateProduct` (deleteMany children + create) при уже произведённой упаковке: старые `OperationNomenclatureLine` хранят факт списания, новые изделия спишут новый BOM. Согласовано ли это с отчётом с/с изделия?

Why review:  
Провенанс упаковки зафиксирован в lines (схема L423–425). Отчёт может читать текущий BOM vs lines.

Relevant code:  
`nomenclature.ts:updateProduct` ~L414; `lib/cost-report.ts`; terminal upakovka consume.

---

REVIEW-025  
Domain: Notifications / Settings  
Priority to audit: LOW

Question:  
`getAppSettings` без requireAdmin — утечка порога отхода? `syncSystemNotifications` deleteMany — гонки с UI?

Why review:  
Низкая чувствительность данных vs шум.

Relevant code:  
`settings.ts:getAppSettings` L114; `notifications.ts`.

---

REVIEW-026  
Domain: Infra / Production  
Priority to audit: HIGH

Question:  
`migrate deploy` на каждый старт контейнера; health публичный; SESSION_SECRET/CRON_SECRET; один Postgres без публикации порта в prod. Что проверить в production-аудите (бэкапы, rollback, Sentry, Caddy)?

Why review:  
`docker-entrypoint.sh`; `docker-compose.prod.yml`; GHA deploy manual only.

Relevant code:  
Dockerfile, entrypoint, `deploy-production.yml`, `scripts/backup-db.sh`.

---

REVIEW-027  
Domain: Seed / Ops  
Priority to audit: MEDIUM

Question:  
Случайный `db:seed` на не-local БД уничтожит данные (wipe). Есть ли защита?

Why review:  
`prisma/seed.ts` deleteMany cascade. Script `db:reset`.

Relevant code:  
`prisma/seed.ts`; package.json `db:seed` / `db:reset`.

---

REVIEW-028  
Domain: Cost / Hours  
Priority to audit: MEDIUM

Question:  
Входит ли HOURS в себестоимость изделия / только в ЗП отчёт? Согласовано ли с v2?

Why review:  
OperationType HOURS без productId. `lib/payroll.ts` vs `lib/cost-report.ts` labor.

Relevant code:  
`terminal.ts:submitHours`; cost-report labor aggregations.

---

REVIEW-029  
Domain: Sales vs Finance  
Priority to audit: MEDIUM

Question:  
Связаны ли Sale.revenue с CashFlow INCOME, или это два независимых контура (МП vs банк)? Может ли «оплата клиента» никогда не согласоваться с продажей?

Why review:  
Нет FK Sale↔CashFlow. Процесс 13 = только ДДС.

Relevant code:  
schema Sale; finance CashFlow; marketplace upsert sales.

---

REVIEW-030  
Domain: Concurrency / Rate limit  
Priority to audit: MEDIUM

Question:  
При горизонтальном масштабе: PIN/login limiter и cost-queue теряют эффект. Планируется ли один инстанс навсегда?

Why review:  
Комментарии в коде прямо говорят «один инстанс».

Relevant code:  
`lib/rate-limit.ts` L1–4; `cost-queue.ts` L3–8; docker-compose.prod app replicas?

---

## Карта транзакций (кратко)

Интерактивные `$transaction(async tx)`: writeOffBatchRemainder; submitTorcovka/Prisadka/Upakovka; production qty/delete; markEmployeePaid; conductInventory; updateProduct; finance deleteAccount/articles/deal/importStatement/deleteStatement; syncMarketplacesAsUser; saveApiCredentials; saveMinStock; freeze/archive batch (внутри caller tx).

Array `$transaction([...])`: deleteBatch; deleteDetail; deleteProduct; createTransfer; convertCashFlowToTransfer; unlinkTransfer; syncSystemNotifications.

Raw SQL: только `GET /api/health` `$queryRaw SELECT 1`.

Без tx (REVIEW-021): createBatch+log; updateBatch+recalc; createDeal+syncDeal; CashFlow mutate+sync; recalcBatchCosts; submitHours; CRUD+ChangeLog.

---

## Delete / archive (кратко)

Soft: Employee, Material, Detail, Product, NomenclatureItem, Batch (auto deplete), Deal.  
Hard: при отсутствии ссылок (batch/employee/material/nomenclature) + ручная очистка детей (BOM, RailLot, BatchCost, DetailStock, DealItem, Statement cashflows).  
Cascade schema: **нет**.  
Не удаляются в app: SimplePurchase, Payment, Sale, Supply, ChangeLog, User, conducted Inventory.

---

## Derived values — указатель для финансового аудита

| Показатель | Где | DB vs live |
| ---------- | --- | ---------- |
| Распределение партии по сортам, ₽/м³ с отходом | `lib/cost.ts:distributeBatchCost`; persist `cost.ts:recalcBatchCosts`/`freezeBatch` | DB BatchCost |
| WAC ₽/м по сорту / по материалу | `lib/cost-report.ts:blendedCostPerMeter*` | live |
| Материал детали/заготовки | cost-report `detailMaterialCost` / `blankMaterialCost` | live |
| Работа детали/изделия | payroll rates × ops / avg | live |
| Прямая / накладные / полная с/с изделия | `fullProductCost`; `getCostReport` | live; ProductCost unused |
| Overhead периода | `getPeriodOverhead` из ДДС isOverhead + confirmed accounts | live |
| Batch.totalCost | purchase + deal delivery share `deal-cost.ts` / `syncBatchTotalCost` | DB |
| Остатки | *Stock.quantity, RailLot.remainingQuantity | DB live |
| Отход % | `lib/waste.ts` | live report |
| ЗП piece/hourly | `lib/payroll.ts`; Payment.amount при выплате | live / DB на выплате |
| Баланс счёта | `account-balance.ts` | live (+ кэш Account.balance) |
| Отклонение инвентаризации ₽ | conductInventory unit cost snapshot | DB InventoryLine |
| НДС | нет | — |
| Маржа Sale vs cost | не найдено как единый расчёт | REVIEW |

---

## ChangeLog — указатель

Writer: `writeChangeLog` → entity/entityId/oldValues/newValues/userId/changedAt.  
Actor admin: почти только settings. Employee actor: нет поля.  
Не логируется: churn *Stock, PRELIMINARY recalc, silent Deal.total/Batch.totalCost, login, per-sale upserts, notification read, секреты API (только имена полей).

---

## Security hotfix — non-blocking observations (не чинить в этом pass)

Зафиксировано independent pre-commit review. Не являются blocker текущего security hotfix.

SEC-NB-001  
Domain: Maintainability / Terminal  
Priority to audit: LOW

Question:  
В `src/server/terminal.ts` осталось ~409 строк закомментированного дубля `applyPrisadkaPick` / `reversePrisadkaLine` / `applyUpakovkaPick` / `reverseUpakovkaOperation` после выноса в `src/server/internal/production-reversal.ts`. Удалить мёртвый комментарий отдельным chore, не смешивая с security.

Relevant code:  
`src/server/terminal.ts` блоки `Implementation moved to server/internal/production-reversal.ts`.

---

SEC-NB-002  
Domain: Maintainability  
Priority to audit: LOW

Question:  
После remediation часть поясняющих комментариев у внутренних хелперов не восстановлена. Не чинить в security pass.

---

SEC-NB-003  
Domain: Auth / Terminal  
Priority to audit: MEDIUM

Question:  
Гоночен ли `terminalLogout()` (cookie delete без синхронизации с in-flight `submit*` / `getTerminalData` на той же сессии)? Не blocker текущего security hotfix: logout не расширяет поверхность admin actions.

Relevant code:  
`src/server/terminal.ts:terminalLogout`; cookie `TERMINAL_COOKIE`.

---

SEC-NB-004  
Domain: Payroll / Cost / Inventory  
Priority to audit: CRITICAL TO AUDIT

Question:  
Семантика payroll freeze, cost snapshots и inventory не входила в security hotfix. Смотреть существующие REVIEW по cost/payroll/inventory; не смешивать с auth-границами.

---

SEC-NB-005  
Domain: Architecture  
Priority to audit: LOW

Question:  
Архитектурная чистка internal split (дубли имён, commented leftovers, единый слой server/internal) — отдельный этап, не security blocker.

---

## Data Integrity phase 1 — confirmed (не чинить в этом pass)

Этап закрыт как **audit-only**. Полные карточки: `audit/01-data-integrity-findings.md`. Карта TX: `audit/01-data-integrity-map.md`. Таблица A/B/C/D: `audit/01-data-integrity-invariants.md`. HEAD `5479580`.

Связь с очередью этапа 0 (только то, что **подтверждено** evidence):

| REVIEW | Finding | Итог аудита |
| --- | --- | --- |
| REVIEW-005 / REVIEW-018 | [DI-006](01-data-integrity-findings.md#di-006), [DI-012](01-data-integrity-findings.md#di-012) | Recalc без TX/lock; PRELIMINARY не SoT. Freeze = unpaid TORCOVKA — EXPECTED vs v2. |
| REVIEW-007 | — | gte+updateMany на terminal/reverse **race-safe** для qty (не P0/P1). |
| REVIEW-008 | [DI-014](01-data-integrity-findings.md#di-014), [DI-015](01-data-integrity-findings.md#di-015) | Double pay через markEmployeePaid **не** подтверждён (claim). Ставки live — decision. |
| REVIEW-009 | [DI-004](01-data-integrity-findings.md#di-004), [DI-010](01-data-integrity-findings.md#di-010), [DI-011](01-data-integrity-findings.md#di-011) | Sequential supply идемпотентен; concurrent sync — нет; SKU не unique. |
| REVIEW-010 / REVIEW-015 / REVIEW-021 | [DI-001](01-data-integrity-findings.md#di-001), [DI-005](01-data-integrity-findings.md#di-005), [DI-013](01-data-integrity-findings.md#di-013) | updateBatch не синхронизирует totalCost; freeze race на totalCost; derived вне TX источника. |
| REVIEW-011 | [DI-003](01-data-integrity-findings.md#di-003) | importKey index-only; concurrent IMAP+UI дублирует CF. |
| REVIEW-012 | [DI-002](01-data-integrity-findings.md#di-002) | Unconfirmed отфильтрованы в ДДС/overhead. Confirm **без** resync totals. |
| REVIEW-013 | — | TORCOVKA не возвращает рейки — **EXPECTED** (v2 + JSDoc + smoke). |
| REVIEW-014 | [DI-009](01-data-integrity-findings.md#di-009), [DI-016](01-data-integrity-findings.md#di-016) | Absolute qty set; DRAFT не unique в БД. |

P1 к следующему fix-pass (порядок): DI-001, DI-002, DI-003, DI-004. Application/Prisma/tests в этом этапе не менялись.

---

## Data Integrity phase 1.2 — freeze/recalc (audit-only)

HEAD `9b5ed66` (код freeze/recalc тот же, что на фазе 1; P1 `199fe2f` закрыл write `totalCost` после committed `frozenAt`, но не `maybeFreezeBatch` / `recalcBatchCosts`).

Полный отчёт: `audit/01.2-cost-freeze-review.md`. Код не менялся.

| ID | Verdict 01.2 |
| --- | --- |
| DI-005 | **CONFIRMED RACE остаётся.** Механизм: FINAL из stale A до Batch lock; concurrent sync пишет C=B; затем frozenAt. Write-after-freeze P1 закрыл. |
| DI-006 | **CONFIRMED RACE остаётся.** Recalc без TX/recheck. PRELIMINARY не SoT UI — несколько PRELIMINARY у открытой партии не автобаг. Orphan PRELIMINARY+FINAL после freeze — да. |
| DI-018 | **новый CONFIRMED RACE.** Два last TORCOVKA `markEmployeePaid` → freeze skip навсегда. |
| DI-019 | **новый CONFIRMED RACE.** UPDATE TORCOVKA qty после/во время pay+freeze → FINAL stale. DELETE после Payment **не** проходит (PBI RESTRICT). |
| ProductCost | writers нет — не в remediation. |
| `recalcBatchCostsInternal` | не существует. |

Owner BD-1..4 зафиксированы в `01.2` §7 (cache / no auto-fix mismatch / section frozen / freeze must happen).

REVIEW-005 / REVIEW-010 / REVIEW-018: см. 01.2, не закрыты кодом.

Не commit/push этого pass.

