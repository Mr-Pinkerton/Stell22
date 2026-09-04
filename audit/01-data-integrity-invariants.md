# Этап 1: инварианты Data Integrity (A/B/C/D)

HEAD `9b5ed66`. Freeze/recalc pass: `audit/01.2-cost-freeze-review.md` (DI-005/006/018). Строки P1 (totalCost writers, importKey, SKU) ниже могут отставать от `199fe2f` — не переоценивались в 01.2, кроме freeze-adjacent.

Классификация **как гарантируется сейчас**, не как хотелось бы в v2.

| Код | Значение |
| --- | --- |
| **A** | Гарантируется БД (UNIQUE / PK / FK / NOT NULL). CHECK-ограничений в migrations **нет**. |
| **B** | Гарантируется атомарной `$transaction` (вместе с A или C). |
| **C** | Только application check (`throw`, `updateMany`+`count`, `findFirst`). |
| **D** | Не гарантируется. |

**Race-safe:** выдерживает два одновременных запроса на одном Postgres (READ COMMITTED, без явного isolation). Prod = один app-процесс, но два HTTP/CLI запроса всё равно два PG transaction.

**Verdict:** `SAFE` / `WEAK` / `UNSAFE` / `EXPECTED`.

Evidence: schema + named migration или `file:function`. Findings — `audit/01-data-integrity-findings.md`.

---

| Invariant | DB | Transaction | App check | Race-safe | Verdict |
| --- | --- | --- | --- | --- | --- |
| Остаток RailLot не уходит в минус при торцовке | — (нет CHECK) | B: submitTorcovka I | C: `updateMany` `remainingQuantity.gte` + `count===0` `terminal.ts:367-371` | **да** (один UPDATE) | SAFE |
| Остаток BlankStock/DetailStock/NomenclatureStock не уходит в минус на terminal apply/reverse | — | B: caller I | C: gte+count `production-reversal.ts` | **да** на decrement | SAFE |
| ProductStock не уходит в минус при reverse упаковки | — | B | C: gte `reverseUpakovkaOperation:323` | **да** | SAFE |
| ProductStock не уходит в минус при MP deduct | — | B: sync I, но decrement **без** gte `:547-550` | C: in-memory `computeSupplyDeduction` cap по **прочитанному** available | **нет** при двух sync | UNSAFE — [DI-004](01-data-integrity-findings.md#di-004) |
| Два терминала не спишут 8+8 из remaining=10 | — | B | C: gte UPDATE | **да** для qty; история дублируется только с **разными** clientRequestId и достаточным остатком | SAFE (qty) / EXPECTED (два разных id = две операции) |
| RailLot→BlankStock атомарны | — | B: один I | C | **да**; upsert unique `BlankStock_materialId_lengthM_detailType_sort_key` migration `20260711120000` | SAFE |
| Blank→Detail и Detail+Nom→Product атомарны | — | B | C gte | **да** | SAFE |
| Повтор submit с тем же `clientRequestId` не создаёт вторую Op | A: `ProductionOperation_clientRequestId_key` `20260713161800` | B (кроме Hours) | C: P2002 swallow | **да** если id задан; **нет** для NULL | WEAK — [DI-007](01-data-integrity-findings.md#di-007) [DI-008](01-data-integrity-findings.md#di-008) |
| Несколько Op с `clientRequestId=NULL` | UNIQUE допускает много NULL | — | C: UI шлёт id; API может не слать | **нет** | WEAK — DI-008 |
| Удаление TORCOVKA не возвращает рейки | — | B: просто нет write | C: явный комментарий | n/a | EXPECTED (v2 + JSDoc + smoke) |
| Удаление/правка PRISADKA/UPAKOVKA возвращает provenance stock | — | B | C: reverse helpers | да, если gte проходит | EXPECTED / WEAK после inventory — [DI-009](01-data-integrity-findings.md#di-009) |
| Выплаченную Op нельзя **удалить** (TORCOVKA) | A: `PaymentBatchItem.operationId` RESTRICT init | B: delete Op в TX | C: isPaid **вне** TX | после committed Payment delete Op fail → rollback | SAFE (FK), не app-check |
| Выплаченную TORCOVKA нельзя **править qty** | — | update lines **без** lock Op | C: isPaid только pre-TX | claim/freeze коммитится, затем line UPDATE | UNSAFE — [DI-019](01-data-integrity-findings.md#di-019) |
| Выплата не дублирует ops в два Payment | нет UNIQUE `PaymentBatchItem.operationId` (init FK only) | B: claim+Payment | C: `updateMany isPaid:false` count match `payroll.ts:211-217` | **да** для этого path | SAFE (app) / WEAK schema — [DI-014](01-data-integrity-findings.md#di-014) |
| Freeze откатывается вместе с Payment если freeze throw | — | B: тот же I | C: maybeFreeze внутри | да | SAFE |
| Сумма выплаты = ставки на операциях | нет snapshot rate на Op | — | C: current Employee rates до TX | ставки могут смениться между read и claim (окно) | WEAK / EXPECTED — [DI-015](01-data-integrity-findings.md#di-015) |
| Unpaid ЗП пересчитывается live-ставками | — | — | C | sequential: смена ставки меняет начисление задним числом | EXPECTED / NEEDS DECISION — DI-015 |
| Freeze только если closedAt и unpaid TORCOVKA=0 | — | B: maybeFreeze в caller TX | C: `canFreezeBatch`; count unpaid **без** Batch FOR UPDATE | два last TORCOVKA payment оба видят чужой unpaid → freeze skip навсегда | WEAK — [DI-018](01-data-integrity-findings.md#di-018); TORCOVKA-only vs v2 — EXPECTED |
| FINAL BatchCost не перезаписывается recalc | — | recalc не в TX | C: recalc пишет только PRELIMINARY; skip `frozenAt` на **стартовом** findMany | late recalc может **добавить** PRELIMINARY рядом с FINAL | WEAK — [DI-006](01-data-integrity-findings.md#di-006) |
| Один PRELIMINARY на batch | нет unique (batchId, status) `@@index(batchId)` only | **нет** TX на delete+create | C: UI **не** читает PRELIMINARY (`loadCostContext` только FINAL) | **нет** (не SoT) | WEAK cache — DI-006; не автобаг пока cache |
| FINAL считается под тем же lock, что `frozenAt` | нет | freeze I, но `findUnique` до `UPDATE frozenAt` | C | concurrent sync FOR UPDATE пишет C=B, FINAL из A | WEAK — [DI-005](01-data-integrity-findings.md#di-005) |
| `Batch.totalCost` не пишется после committed `frozenAt` | — | B у finance writers после P1 | C: FOR UPDATE + `updateMany frozenAt:null` `finance-operations.ts:157-186` | да против write-after-freeze; нет против stale FINAL (DI-005) | SAFE sequential after freeze / WEAK during freeze compute |
| `updateBatch(purchaseCost)` обновляет `totalCost` | — | — | **нет** | sequential stale C | UNSAFE — DI-001 |
| Подтверждение счёта пересчитывает Deal/Batch totals | — | — | **нет** (`setAccountConfirmed` только flag) | sequential stale C | UNSAFE — [DI-002](01-data-integrity-findings.md#di-002) |
| Unconfirmed CF не в ДДС/KPI/overhead/deal extras | — | — | C: `account.confirmed:true` в getFinanceData, getPeriodOverhead, sumConfirmedExpense | да для этих read path | SAFE |
| Unconfirmed CF не в балансе счёта | — | — | **намеренно нет**: `getFinanceData` считает баланс по всем CF | n/a | EXPECTED |
| Импорт выписки не создаёт дубль CF с тем же importKey | index **не UNIQUE** `20260630164144` | B: весь файл в одном I | C: findFirst then create | **нет** (два TX) | UNSAFE — [DI-003](01-data-integrity-findings.md#di-003) |
| Retry импорта после rollback TX безопасен | — | B: all-or-nothing | C: findFirst | sequential: да | SAFE sequential |
| Ноги перевода создаются атомарно | — | B: array TX | C: accounts differ, amount>0 | double click = два перевода | SAFE legs / WEAK idempotency |
| Удаление перевода удаляет обе ноги | — | deleteMany by transferId (не I с read) | C | второй delete no-op | EXPECTED |
| SKU изделия уникален | skuOzon/skuWb NOT NULL, **не unique** | — | C: required string only `nomenclature.ts:371` | два Product → Map last-wins в sync | WEAK — [DI-010](01-data-integrity-findings.md#di-010) |
| Supply не списывает ГП дважды при sequential retry | A: unique (marketplace,externalId,sku) `20260701155446` | B: sync I | C: deductedQty+shortfallQty | sequential **да**; concurrent **нет** | WEAK — DI-004 |
| SHIPPED→PENDING возвращает ГП | — | B | C: ветка `target=0` **пропускает** deduct; restore только Ozon cancel list | нет общего revert | WEAK — [DI-011](01-data-integrity-findings.md#di-011) |
| Inventory не ломает provenance | — | B: set qty | C: DRAFT only | абсолютный set; нет связи с ops | WEAK — DI-009 |
| Один DRAFT инвентаризации | нет partial unique status=DRAFT | — | C: findFirst | два concurrent create | WEAK — [DI-016](01-data-integrity-findings.md#di-016) |
| Batch.name уникален | A: `Batch_name_key` `20260630190300` | — | C: assertUniqueBatchName | да (P2002) | SAFE |
| RailLot.code уникален если задан | A: `RailLot_code_key` init (NULL ok) | — | C: allocatePackageCode in-memory set | concurrent createBatch theoretically collide | WEAK rare |
| BlankStock / DetailStock / ProductStock / NomenclatureStock unique keys | A: migrations init / nomenclature_stock / material | upsert ON CONFLICT | — | да для upsert | SAFE |
| Employee.pin уникален среди ACTIVE | — | — | C: assertActivePin | concurrent create | WEAK (не деньги) |
| ArticleCategory.name уникален | — | — | C: findFirst | concurrent | WEAK |
| Account.accountNumber уникален | — | — | нет | import findFirst — неверный матч | WEAK |
| Sale upsert идемпотентен | A: unique marketplace+externalId | B: sync I | upsert | sequential да; NULL externalId — много строк | WEAK if null |
| MpStock один ряд на (marketplace,sku) | **нет unique** | B: deleteMany+createMany | — | concurrent sync → дубли snapshot | WEAK — [DI-017](01-data-integrity-findings.md#di-017) |
| FK required Restrict / optional SetNull | A: Prisma 6 defaults; init SQL `ON DELETE RESTRICT` на required | — | C: extra guards deleteBatch/Employee | n/a | SAFE |
| Qty ≥ 0 на любом *Stock | **D: нет CHECK** | B+C на production gte paths | marketplace/inventory обходят gte | mixed | WEAK |
| Cost-queue не параллелит два recalc одной партии | — | — | C: in-memory Map | только внутри одного процесса; CLI не использует очередь | WEAK — [DI-012](01-data-integrity-findings.md#di-012) |
| PRELIMINARY лагает после commit ops | — | enqueue **после** commit | — | окно stale PRELIMINARY | EXPECTED (отчёт live) |

---

## DB evidence (constraints)

### Unique (migrations)

| Constraint | Migration |
| --- | --- |
| User.email | init |
| RailLot.code | init |
| ProductDetail (productId, detailId) | init |
| DetailStock (detailId, torcevayaDone, ploskostDone) | init |
| ProductStock.productId | init |
| NomenclatureStock.nomenclatureId | `20260629163909` |
| Batch.name | `20260630190300` |
| Notification.key | `20260701120400` |
| Supply (marketplace, externalId, sku) | `20260701155446` |
| Sale (marketplace, externalId) | `20260701155446` |
| ProductionOperation.clientRequestId | `20260713161800` |
| Material (name, sectionWidthMm, sectionHeightMm) | `20260724170000` (сменил старый Material.name unique) |
| BlankStock (materialId, lengthM, detailType, sort) | `20260711120000` |

Снято: `Detail (materialId, detailNumber, sort)` unique — `20260713190000` (номер не ключ потока).

### Index но не unique

| Index | Migration | Следствие |
| --- | --- | --- |
| CashFlow (accountId, importKey) | `20260630164144` | дедуп только app |
| BatchCost.batchId | schema / init | несколько PRELIMINARY/FINAL; нет unique status |
| ProductCost (productId, periodStart, periodEnd) | schema | не unique; writers нет |
| Detail (materialId, detailNumber) | `20260713190000` | не unique |

### Нет в БД

- CHECK на неотрицательные qty
- UNIQUE (BatchCost.batchId) / partial unique FINAL / PRELIMINARY
- UNIQUE PaymentBatchItem.operationId
- UNIQUE Product.skuOzon / skuWb
- UNIQUE Account.accountNumber
- UNIQUE Employee.pin
- UNIQUE MpStock (marketplace, sku)
- Partial unique Inventory.status=DRAFT
- Version / xmin optimistic lock на Batch, Supply, *Stock

### Referential actions

В `schema.prisma` нет явных `onDelete`/`onUpdate`. Prisma 6: required FK → Restrict + onUpdate Cascade; optional → SetNull + Cascade. Init SQL подтверждает Restrict на PaymentBatchItem → Payment/Operation. Каскадного удаления склада при delete Op **нет** — приложение удаляет lines вручную в той же TX.
