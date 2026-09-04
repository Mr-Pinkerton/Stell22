# Этап 1: карта WRITE PATHS и транзакций

Аудит **Data Integrity / Prisma / Concurrency**. Read-only.

| | |
| --- | --- |
| HEAD | `9b5ed66da36543c3a58d7ab8e392fcd19e78b9c1` (P1 `199fe2f`; фаза 1 карта кроме freeze — `5479580`) |
| Freeze/recalc | `audit/01.2-cost-freeze-review.md` |
| Stack | Prisma **6.19.3**, PostgreSQL **17**, Next.js 16 |
| Prod topology | `docker-compose.prod.yml`: **один** контейнер `stell22-app` (не replicas) |
| Application code | не менялся |
| Prisma / tests | не менялись |

Графа Graphify нет (`graphify-out/graph.json` отсутствует) — карта собрана по `schema.prisma`, `prisma/migrations/**`, `src/server/**`, `scripts/**`.

Findings: `audit/01-data-integrity-findings.md`.
Инварианты A/B/C/D: `audit/01-data-integrity-invariants.md`.

---

## 0. Фактическая isolation / SQL semantics

Нигде в репозитории **не заданы** `isolationLevel` и `transactionOptions` (`src/server/db.ts` — голый `new PrismaClient()`; grep по коду пустой).

| Слой | Факт | Источник |
| --- | --- | --- |
| Prisma interactive `$transaction(async tx => …)` | isolation = **то, что настроено в БД** | Prisma 6 docs: default = database configured value |
| PostgreSQL 17 (образ `postgres:17-alpine`) | default isolation **READ COMMITTED** | PostgreSQL docs; Prisma docs явно: PG default ReadCommitted |
| Array `$transaction([…])` | тот же default isolation | Prisma sequential operations TX |
| Interactive timeout | Prisma default **timeout 5000 ms**, **maxWait 2000 ms** | Prisma Client; в Stell22 не переопределено |
| `SELECT FOR UPDATE` / advisory lock | **нет** | grep |
| CHECK `quantity >= 0` / `remainingQuantity >= 0` | **нет** ни в schema, ни в migrations | grep `CHECK` по `prisma/migrations` — 0 совпадений |

### Паттерн `updateMany` + `gte` + `decrement`

Типичный вызов:

```ts
await tx.railLot.updateMany({
  where: { id, remainingQuantity: { gte: n } },
  data: { remainingQuantity: { decrement: n } },
});
if (dec.count === 0) throw …;
```

Prisma генерирует один SQL:

```sql
UPDATE "RailLot"
SET "remainingQuantity" = "remainingQuantity" - $n
WHERE id = $id AND "remainingQuantity" >= $n;
```

Под **READ COMMITTED** второй concurrent `UPDATE` той же строки ждёт row lock, затем **перечитывает** WHERE. Если после первого коммита остаток `< n`, второй UPDATE затрагивает 0 строк → `count === 0` → throw → rollback interactive TX.

Это **атомарно на уровне одной строки** и достаточно, чтобы не уйти в минус на production decrement-путях. Это **не** `SERIALIZABLE` и **не** `SELECT FOR UPDATE` на связанных строках (BlankStock upsert рядом защищён тем, что живёт в той же TX: exception откатывает и decrement реек).

`productStock.update({ decrement })` **без** `gte` (marketplace) — обычный `SET quantity = quantity - n WHERE productId = …` — **может уйти в минус**.

### PostgreSQL UNIQUE + NULL

`UNIQUE` индекс допускает **много NULL**. `ProductionOperation.clientRequestId` и `Sale.externalId` — nullable unique: несколько строк с NULL не конфликтуют.

---

## 1. Сводная таблица write paths

Колонка TX: `I` = interactive `$transaction(async)`, `A` = array `$transaction([…])`, `nested` = один nested `create` (атомарен для детей), `none` = отдельные statements.

Колонка **RCW без TX** = read → compute → write не в одной `$transaction` с источником.

### 1.1 Склад / производство

| ENTRY | Auth | TX | Reads | Checks | Writes | After TX | RCW без TX? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `submitTorcovka` `terminal.ts:342` | `requireTerminalEmployee` | I | lot, batch | over-length; `updateMany` gte count | RailLot−−; Op+lines; BlankStock upsert++; changelog; `archiveBatchIfDepleted` | `enqueueRecalcBatchCosts`; revalidate | нет (stock); recalc после commit |
| `submitPrisadka` `terminal.ts:661` | terminal | I | via `applyPrisadkaPick` | gte | Op create **сначала**; stock; changelog | revalidate | нет |
| `submitUpakovka` `terminal.ts:942` | terminal | I | via `applyUpakovkaPick` | gte | per product: Op (`clientRequestId:id:productId`); consume; ProductStock++; changelog | revalidate | нет |
| `submitHours` `terminal.ts:987` | terminal | **none** | — | hours>0 | Op create | changelog **после** create; revalidate | да (changelog) |
| `applyPrisadkaPick` `production-reversal.ts:5` | caller TX | inherit | detail, stocks | gte | Detail/Blank −−/++; line | — | нет |
| `reversePrisadkaLine` `:93` | caller TX | inherit | — | dest gte | dest−−; source upsert++ | — | нет |
| `applyUpakovkaPick` `:183` | caller TX | inherit | product+BOM, stocks | gte; allocate | detail/blank/nom−−; GP++; lines | — | нет |
| `reverseUpakovkaOperation` `:306` | caller TX | inherit | — | ProductStock gte | GP−−; restore provenance | — | нет |
| `updateProductionLineQuantity` `production.ts:202` | admin | I (кроме HOURS) | op+lines | isPaid; gte | reverse+reapply / blank delta | recalc если TORCOVKA | HOURS: да |
| `deleteProductionOperation` `production.ts:388` | admin | I | op+lines | isPaid; blank gte | reverse / blank−−; **RailLot не трогает**; delete op | recalc | нет |
| `writeOffBatchRemainder` `purchases.ts:332` | admin | I | lots remaining | remaining>0 | `remainingQuantity = 0` where gt 0; archive | revalidate | нет |
| `createSimplePurchase` `purchases.ts:404` | admin | I | — | qty/price | SimplePurchase; NomStock upsert++ | changelog | changelog after |
| `createInventoryDraft` `warehouse.ts:228` | admin | none | live stock | one DRAFT (findFirst) | Inventory+lines snapshot | changelog | да (снимок qty) |
| `updateInventoryLineActual` `:285` | admin | none | line | DRAFT; qty≥0 | actualQty=X | changelog | да |
| `conductInventory` `:313` | admin | I | doc+lines; valuation **вне** TX | DRAFT (вне TX) | *Stock **set quantity=actualQty**; CONDUCTED | revalidate | valuation вне TX |
| `deleteDetail` `nomenclature.ts` | admin | A | usage | not in product | DetailStock.deleteMany; Detail | changelog | changelog after |

### 1.2 Закупки / партии

| ENTRY | Auth | TX | Writes | After | RCW? |
| --- | --- | --- | --- | --- | --- |
| `createBatch` `purchases.ts:237` | admin | nested create | Batch (`totalCost=purchaseCost`) + RailLots | changelog | changelog after |
| `updateBatch` `:292` | admin | I + Deal→Batch FOR UPDATE (P1) | scalars; money запрещён если `frozenAt` уже set; sync C в той же TX | changelog; `enqueueRecalc` | C в TX; freeze compute всё ещё без lock (DI-005) |
| `deleteBatch` `:369` | admin | A | BatchCost, RailLots, Batch | changelog | guards вне TX (count ops/deals) |

### 1.3 Cost / freeze / archive

Актуальная детальная карта: `audit/01.2-cost-freeze-review.md`. `recalcBatchCostsInternal` нет.

| ENTRY | Auth | TX | Reads | Locks | Writes | After | RCW? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `enqueueRecalcBatchCosts` `cost-queue.ts:19` | n/a | process Map | — | in-memory key | вызывает `recalcBatchCosts` | — | in-memory only |
| `recalcBatchCosts` `internal/cost.ts:340` | queue only (prod) | **none** | batches `frozenAt:null`; TORCOVKA ops | нет | per batch: `deleteMany PRELIMINARY` затем `create PRELIMINARY` | — | **да** |
| `freezeBatch` `:364` | via maybeFreeze | **caller I** | TORCOVKA ops; in-memory Batch (C/prices/section) | первая блокировка Batch = `UPDATE frozenAt` **после** compute | `frozenAt`; `deleteMany` all BatchCost; `create FINAL` | notify (в TX) | compute до lock |
| `maybeFreezeBatch` `:396` | payroll / archive | caller I | batch findUnique; unpaid TORCOVKA count | нет FOR UPDATE | freezeBatch | — | нет |
| `archiveBatchIfDepleted` `:412` | terminal / write-off | caller I | lots remaining | нет | ARCHIVED+closedAt; maybe freeze | notify | нет |

`ProductCost`: writers **нет** (A17) — не в remediation freeze.

CLI recalc нет. IMAP: `statement-mail.ts` enqueue после `importStatementInternal` (тот же `recalcBatchCosts` через очередь).

### 1.4 Finance

| ENTRY | Auth | TX | Writes | Derived after | RCW? |
| --- | --- | --- | --- | --- | --- |
| `createCashFlow` `finance.ts:812` | admin | none | CashFlow.create | `syncDealInternal` если dealId | **да** |
| `assignCashFlow` `:941` | admin | none | CF patch | sync old+new deal | **да** |
| `deleteCashFlow` `:974` | admin | none (deleteMany legs) | CF delete | sync deal | **да** |
| `createTransfer` `:876` | admin | **A** two creates | EXPENSE+INCOME `isTransfer` shared `transferId` | changelog | нет (ноги) |
| `convertCashFlowToTransfer` `:1003` | admin | **A** | update source + create opposite | `syncDealInternal` old deal | derived after |
| `unlinkTransfer` `:1069` | admin | **A** | keep one; delete other; clear flags | — | нет |
| `createDeal` `:1127` | admin | nested create | Deal+items total=0 | `syncDealInternal` | **да** |
| `updateDeal` `:1152` | admin | I items replace | Deal+items | `syncDealInternal` + unlinked batches | **да** |
| `deleteDeal` `:1193` | admin | I | null CF.dealId; delete items+deal | `syncBatchTotalCostInternal` per batch | **да** |
| `setDealStatus` `:1185` | admin | none | status only | **нет** sync | n/a |
| `syncDealInternal` `finance-operations.ts:96` | internal | **none** | Deal.total; loop `syncBatchTotalCostInternal` | revalidate | **да** |
| `syncBatchTotalCostInternal` `:153` | internal | inherit caller | skip if `frozenAt` после FOR UPDATE; `updateMany where frozenAt:null` | enqueue в caller after commit | **нет WHERE-дыры после P1**; stale FINAL — [DI-005](01.2-cost-freeze-review.md) |
| `importStatementInternal` `statement-import.ts:170` | admin / IMAP | **I** | Account find/create (`confirmed:false` если новый); Statement; CF create if `findFirst(importKey)` miss; maybe advance openingBalance | changelog; **`syncDealInternal` after TX** | derived after; idempotency check-then-insert **внутри** TX, но **без UNIQUE** |
| `deleteStatement` `finance.ts:1282` | admin | I | delete CFs+stmt; maybe restore account anchor | sync deals | derived after |
| `setAccountConfirmed` `:370` | admin | none | `confirmed` | **нет** syncDeal / syncBatch | **да — derived не пишется** |
| `createAccount` / `updateAccount` / `deleteAccount` | admin | delete: I | Account; delete пустых stmts | — | — |
| `reapplyAutoRules` `:762` | admin | **none** (loop updates) | CF article/deal | sync deals | **да** |

IMAP: `POST /api/cron/fetch-statements` → `runMailIntakeAndLog` → тот же `importStatementInternal`. CLI: `scripts/fetch-statements.ts`.

### 1.5 Payroll

| ENTRY | Auth | TX | Flow |
| --- | --- | --- | --- |
| `markEmployeePaid` `payroll.ts:185` | admin | **I** | claim isPaid; Payment; `maybeFreezeBatch` per torcovka batch (**без** Batch FOR UPDATE). Freeze throw откатывает Payment. After: revalidate, **нет** recalc. DI-005/018. |
| `updateEmployee` `employees.ts:123` | admin | none | rates live; **не** трогает ops/Payment |

### 1.6 Marketplace

| ENTRY | Auth | TX | Flow |
| --- | --- | --- | --- |
| `syncMarketplaces` `marketplace.ts:139` | admin | → internal | |
| `syncMarketplacesAsUserInternal` `marketplace-sync.ts:395` | admin / CLI `scripts/run-mp-sync.ts` | fetch **вне** TX; затем **один I** на все Sale upsert + Supply upsert + ProductStock decrement + Ozon cancel restore + MpStock replace | **нет** mutex / advisory lock |
| Stock deduct `:536-567` | in TX | read Supply deducted/short; `computeSupplyDeduction`; `productStock.update({ decrement })` **без gte**; write deductedQty | sequential retry идемпотентен; concurrent — нет |

### 1.7 Прочие writers (не деньги/остатки напрямую)

| ENTRY | Notes |
| --- | --- |
| employees/materials/nomenclature CRUD | admin; archive/delete guards; `updateProduct` I: deleteMany BOM + create |
| `createGoal` | admin; нет archive writer |
| settings/credentials/minStock | admin; Setting upsert |
| notifications mark read / `syncSystemNotifications` array TX | |
| `writeChangeLog` / `writeSystemLog` / `notifyEvent` | side effect; часто внутри caller TX |
| `prisma/seed.ts` | wipe + mocks; не prod path |
| `scripts/set-admin-password.ts` | CLI User password |

---

## 2. Критические цепочки (детально)

### 2.1 Торцовка (RailLot → BlankStock)

```
ENTRY submitTorcovka
→ requireTerminalEmployee
→ $transaction I  (isolation: RC, timeout 5s default)
   READ railLot, batch
   CHECK length; lot.batchId
   WRITE railLot.updateMany decrement WHERE remainingQuantity >= railsTaken
   WRITE productionOperation.create (clientRequestId) + lines
   WRITE blankStock.upsert increment (unique materialId+lengthM+type+sort)
   WRITE changelog; archiveBatchIfDepleted
→ catch P2002 clientRequestId → treat as success (TX already rolled back if conflict in THIS attempt)
→ AFTER COMMIT enqueueRecalcBatchCosts
→ revalidate
```

Порядок: **списание реек до insert** с unique `clientRequestId`. Присадка/упаковка — **create сначала**.

### 2.2 Присадка / упаковка

Обе стороны перехода (списание источника + приход приёмника + строка провенанса) в **одной** interactive TX. Exception → полный rollback. Одна сторона без другой при exception **не** коммитится.

Упаковка одного submit с несколькими изделиями: один TX на все picks; `clientRequestId` уточняется `${id}:${productId}`. Дубль всего submit откатывает **все** picks этого запроса.

### 2.3 Удаление TORCOVKA

```
deleteProductionOperation
→ TX: blankStock.updateMany decrement gte (produced qty)
     НЕТ railLot.increment
     delete lines+op
→ enqueueRecalc
```

Документировано в JSDoc `production.ts:372-381` и v2 §торцовка: рейки израсходованы физически; разница → отход. Smoke `scripts/smoke-production-reversal.ts` это утверждает.

### 2.4 Deal → Batch.totalCost

После P1 source+derived в одной TX с Account/Deal/Batch FOR UPDATE (не пересобиралось в 01.2). Recalc — **после** commit. Freeze не в этой TX.

Риск 01.2: sync может закоммитить новый `totalCost` пока `freezeBatch` уже посчитал FINAL из старого in-memory Batch (ещё не `UPDATE frozenAt`). См. `01.2` Race F1 / DI-005. Запись C **после committed freeze** P1 закрыл.

### 2.5 Выплата + freeze

```
markEmployeePaid
→ compute amount from CURRENT rates (вне TX)
→ TX:
     claim updateMany isPaid false
     Payment + PaymentBatchItem
     maybeFreezeBatch (тот же tx):
       findUnique Batch           // нет FOR UPDATE
       count unpaid TORCOVKA
       compute FINAL from in-memory Batch
       UPDATE frozenAt            // первый lock Batch
       deleteMany BatchCost; create FINAL
→ after: revalidate; нет enqueueRecalc
```

Нет отдельного «freeze after commit». Throw freeze откатывает Payment — SAFE.
Два параллельных last TORCOVKA payment — DI-018 (freeze может не произойти).

### 2.7 Recalc vs freeze (01.2)

```
enqueueRecalc (after writer commit)
→ in-memory coalesce per key
→ recalcBatchCosts: findMany frozenAt null
     deleteMany PRELIMINARY
     create PRELIMINARY          // без recheck frozenAt
```

Параллельный freeze между delete и create → PRELIMINARY+FINAL (DI-006). UI читает только FINAL.

### 2.6 Marketplace deduct

```
sync (fetch APIs)
→ TX:
     for supply:
       READ existing.deductedQty/shortfallQty
       upsert supply metadata
       if shipped and target > already+short:
         READ productStock.quantity
         computeSupplyDeduction (in-memory, caps to available)
         productStock.update decrement toRemove   // no gte
         supply.update deducted/short
     ozon cancelled: increment GP by deductedQty, zero counters
     MpStock deleteMany+createMany per marketplace
```

Идемпотентность **последовательного** retry: `alreadyDeducted+alreadyShort`. Идемпотентность **параллельного** sync: нет.

---

## 3. Writers derived-полей (источник истины)

| Поле | Writers | SoT для UI сейчас |
| --- | --- | --- |
| `RailLot.remainingQuantity` | createBatch; submitTorcovka −−; writeOff =0 | live DB |
| `*Stock.quantity` | terminal apply/reverse; simple purchase; conductInventory **absolute**; MP deduct/restore | live DB (пулы, не слои партий) |
| `Batch.purchaseCost` | createBatch, updateBatch | purchases UI / mismatch vs P·V |
| `Batch.totalCost` | createBatch init; **только** `syncBatchTotalCostInternal` дальше | **C для distribute** (`lib/cost.ts`, live report); purchases «Общая» |
| `BatchCost PRELIMINARY` | recalc delete+create | **нет читателя** (cache; не SoT) |
| `BatchCost FINAL` | freezeBatch | `loadCostContext` frozen map → cost report вместо live distribute |
| `ProductCost` | нет | — |
| `Deal.total` | syncDealInternal | finance deals |
| `Account.openingBalance` / `balanceAsOf` | create/update account; import advance; deleteStatement restore | live `computeAccountBalance` на чтении |
| `Account.balance` (кэш колонка) | import пишет closing; UI **пересчитывает** | не SoT |
| `Payment.amount` | markEmployeePaid once | paid rows в ЗП отчёте |
| `Supply.deductedQty` / `shortfallQty` | marketplace sync | идемпотентный счётчик списания ГП |
| `ProductionOperation.isPaid` | markEmployeePaid claim | freeze + edit guards |

Live `getCostReport` / `buildCostReport`: ops + `Batch.totalCost` (или FINAL snapshot) + **текущие** Employee rates + overhead ДДС `account.confirmed=true`. PRELIMINARY BatchCost **не читается**.

---

## 4. Идемпотентность: что реально ловит дубль

| Операция | Ключ | DB UNIQUE? | App |
| --- | --- | --- | --- |
| Terminal submit* | `clientRequestId` | да, nullable | P2002 → success |
| Hours | тот же | да | тот же |
| Statement CF | `importKey` = `doc\|date\|amount\|payer\|payee` | **нет**, только `@@index(accountId, importKey)` migration `20260630164144` | `findFirst` skip |
| Sale | `(marketplace, externalId)` | да, externalId nullable | upsert |
| Supply | `(marketplace, externalId, sku)` | да | upsert + deductedQty |
| Payment | нет idempotency key | нет unique на operationId в PaymentBatchItem | atomic claim isPaid |
| Transfer | UUID `transferId` per call | нет | double click = two pairs |
| SimplePurchase | нет | нет | double submit = double stock |
| MP sync whole run | нет lock | — | sequential: deductedQty; concurrent: нет |
| Recalc | in-memory Map per process | нет | 1 app container в prod |

UI терминала: `clientRequestId` крутится только после success → retry той же вкладки = тот же id. Две вкладки = два id.

---

## 5. Скрипты, которые пишут те же сущности

| Script | Path | Сущности |
| --- | --- | --- |
| `scripts/run-mp-sync.ts` | CLI, без cookie | тот же `syncMarketplacesAsUserInternal` → ProductStock/Sale/Supply |
| `scripts/fetch-statements.ts` | CLI IMAP | `importStatementInternal` |
| `POST /api/cron/fetch-statements` | host cron + CRON_SECRET | тот же import |
| `scripts/smoke-production-reversal.ts` | локальный smoke | production reverse semantics |
| `prisma/seed.ts` | wipe | всё |
| `scripts/set-admin-password.ts` | User | не склад/деньги учёта |

Параллельный admin UI sync + CLI `run-mp-sync` — два writer'а одного deduct path на одном Postgres.

---

## 6. Что **не** является write path склада/денег

- `CalendarDay`, `ProductCost`, `Batch.customFields`, `InventoryStatus.CLOSED`, `Goal.ARCHIVED` — нет app writers (см. этап 0).
- `GET /api/health` — `$queryRaw SELECT 1`.
- Cost report, waste report, dashboard — read + live compute.
