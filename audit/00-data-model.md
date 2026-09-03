# Этап 0: модель данных Prisma

Источник: `prisma/schema.prisma` (825 строк) + writers в `src/server/**` и `prisma/seed.ts`.  
**FK:** в `schema.prisma` нигде не заданы `onDelete` / `onUpdate` → дефолты **Prisma 6** (не «везде Restrict»):

| Тип связи | onDelete | onUpdate |
| --------- | -------- | -------- |
| **required** (поле FK обязательное) | `Restrict` | `Cascade` |
| **optional** (поле FK nullable) | `SetNull` | `Cascade` |

Примеры optional→SetNull: `ProductionOperation.batchId?`, `ChangeLog.userId?`, `DealItem.batchId?`, `CashFlow.counterpartyId?` и др. Удаление родителя обнуляет nullable FK, а не блокирует delete. Явных `onDelete: Cascade` в схеме нет — каскады только ручные в коде приложения.

Деньги: `Decimal(14,2)`, ₽, без НДС (шапка схемы L7). Длины `Decimal(12,4)`, объём `Decimal(14,6)`, сечение мм `Decimal(8,2)`.

**43 модели, 15 enum.**

Нет модели Order / Invoice / Shipment в классическом смысле. «Отгрузка» = `Supply` (МП). «Сделка» = `Deal` (закупки + ДДС).

---

## Enums

| Enum | Значения | Где |
| ---- | -------- | --- |
| `UserRole` | `ADMIN` | User.role |
| `EmployeeStatus` | `ACTIVE`, `ARCHIVED` | Employee |
| `RailType` | `POLKA`, `KANAVKA` | RailLot, Detail, BlankStock, OperationDetailLine |
| `Sort` | `SORT1`, `SORT2` | RailLot, Detail, Product, BlankStock, lines |
| `BatchStatus` | `IN_WORK`, `ARCHIVED` | Batch |
| `NomenclatureType` | `FASTENER`, `PACKAGING`, `OTHER` | NomenclatureItem |
| `ProductStatus` | `ACTIVE`, `ARCHIVED` | Material, Detail, Product, NomenclatureItem |
| `OperationType` | `TORCOVKA`, `PRISADKA`, `UPAKOVKA`, `HOURS` | ProductionOperation |
| `FlowType` | `INCOME`, `EXPENSE` | Article, CashFlow, AutoRule |
| `DealStatus` | `OPEN`, `ARCHIVED` (комментарий: «полностью оплачена») | Deal |
| `InventoryStatus` | `DRAFT`, `CONDUCTED`, `CLOSED` | Inventory; **CLOSED без writer в server** |
| `GoalStatus` | `ACTIVE`, `ARCHIVED` | Goal; **ARCHIVED без writer** |
| `CostStatus` | `PRELIMINARY`, `FINAL` | BatchCost, ProductCost |
| `NotificationTone` | `ERROR`, `SUCCESS`, `INFO` | Notification |
| `SystemLogLevel` | `INFO`, `WARN`, `ERROR` | SystemLog |

Строковые «статусы» (не enum): `MpStock.marketplace`, `Sale.marketplace`, `Supply.marketplace` (`OZON`/`WB`); `Supply.status` (`PENDING`/`SHIPPED`/`ACCEPTED`); `InventoryLine.refType` (`DETAIL`/`PRODUCT`/`NOMENCLATURE`); `AutoRule.logicOperator` (`AND`/`OR`).

---

## Сводная таблица моделей

| Model | Назначение (по коду) | Основные связи | Status/State | Кто создаёт | Кто меняет | Кто удаляет/архивирует |
| ----- | -------------------- | -------------- | ------------ | ----------- | ---------- | ---------------------- |
| **User** | Админ-аккаунт email/password | ChangeLog, SystemLog | `role` ADMIN | seed `prisma/seed.ts` | нет update в app | seed wipe; app не удаляет |
| **Employee** | Работник цеха, PIN, ставки | ProductionOperation | `status` ACTIVE/ARCHIVED | `employees.ts:createEmployee` ~L104 | `updateEmployee` ~L120 | archive/restore; hard delete если нет ops `deleteEmployee` ~L179 |
| **Material** | Порода + сечение мм | Batch, Detail, BlankStock, Product | ProductStatus | `materials.ts:createMaterial` ~L55 | update/setStatus | archive; delete если unused ~L130 |
| **Batch** | Партия рейки, истина стоимости материала | Material, RailLot, ops, BatchCost, DealItem | BatchStatus; `closedAt`; `frozenAt` | `purchases.ts:createBatch` ~L242 | `updateBatch`; `finance.ts:syncBatchTotalCost`; freeze/archive в `cost.ts` | `deleteBatch` если нет ops/deals; auto archive deplete |
| **RailLot** | Пакет/поштучная группа, живой остаток реек | Batch, ops | `remainingQuantity` | nested createBatch | torcovka decrement; write-off → 0 | с партией |
| **SimplePurchase** | Приход крепежа/упаковки/разного | NomenclatureItem | — | `createSimplePurchase` ~L404 | нет | нет в app (seed wipe) |
| **NomenclatureItem** | Справочник FASTENER/PACKAGING/OTHER | stock, BOM, SimplePurchase | ProductStatus; `minStock` | `nomenclature.ts:createNomenclatureItem` | update/status/minStock | delete если unused; archive |
| **Detail** | Чертёж детали (длина/тип/сорт/флаги присадки) | Material, ProductDetail, DetailStock | ProductStatus | `createDetail` | update/status/minStock | delete + DetailStock; archive |
| **Product** | Изделие + BOM + skuOzon/skuWb | Material, packaging, BOM, Goal, ProductCost, ProductStock | ProductStatus | `createProduct` | `updateProduct` tx | delete если нет goals/ops/costs; archive |
| **ProductDetail** | BOM деталь×qty | Product, Detail | — | nested product | replace on update | deleteMany |
| **ProductFastener** | BOM крепёж | Product, NomenclatureItem | — | nested | replace | deleteMany |
| **ProductExtra** | BOM «разное» | Product, NomenclatureItem | — | nested | replace | deleteMany |
| **ProductionOperation** | Событие терминала/админки | Employee; Batch/RailLot opt; lines; PaymentBatchItem | `type`; `isPaid`/`paidAt`; `clientRequestId` | `terminal.ts` submit* | qty `production.ts`; pay `payroll.ts` | `deleteProductionOperation` + reverse |
| **OperationDetailLine** | Провенанс заготовок/деталей | ProductionOperation | prisadka flags, source* | terminal | qty update | с операцией |
| **BlankStock** | Пул заготовок до присадки | Material | `quantity` | upsert terminal/warehouse | decrement/increment | qty→0; seed wipe |
| **OperationNomenclatureLine** | Списание крепежа/упаковки упаковкой | ProductionOperation | — | upakovka | — | с операцией |
| **ChangeLog** | Аудит JSON old/new | User? | — | `writeChangeLog` | — | seed wipe |
| **SystemLog** | Лог интеграций | User? | level | `writeSystemLog` | — | нет delete |
| **DetailStock** | Остаток детали по комбинации присадок | Detail | `torcevayaDone`, `ploskostDone`, qty | upsert | terminal/inventory | с Detail |
| **ProductStock** | ГП на заводе | Product | qty | upakovka / inventory | MP deduct; reverse | seed |
| **NomenclatureStock** | Остаток крепежа/упаковки | NomenclatureItem | qty | SimplePurchase | consume/inventory | seed |
| **MpStock** | Снимок остатков МП | sku string, **нет FK на Product** | `syncedAt` | sync createMany | replace | deleteMany per MP |
| **Inventory** | Документ инвентаризации | lines | DRAFT/CONDUCTED/(CLOSED) | `createInventoryDraft` | `conductInventory` | нет delete API |
| **InventoryLine** | Строка подсчёта | Inventory | accounted/actual/deviation | nested | `updateInventoryLineActual`; conduct | — |
| **Account** | Расчётный/касса; кэш баланса | CashFlow, Statement | `confirmed`, `isPrimary`, `balanceMismatch` | `createAccount`; import auto | update/confirm/primary | `deleteAccount` (+ statements) |
| **ArticleCategory** | Группа статей; флаг накладных | Article | `isOverhead` | `createArticleCategory` | update | delete если нет статей |
| **Article** | Статья ДДС, дерево parent | Category, CashFlow, AutoRule | flowType | create tx | update | delete с guards |
| **Counterparty** | Контрагент ДДС | CashFlow, AutoRule | — | create; import | update | delete если unused |
| **Deal** | Сделка закупки (партии + ДДС) | DealItem, CashFlow | OPEN/ARCHIVED; `total` | `createDeal` | `syncDeal`, `updateDeal`, `setDealStatus` | `deleteDeal` |
| **DealItem** | Deal ↔ Batch | Deal, Batch? | — | nested | replace | deleteMany |
| **Statement** | Заголовок выписки | Account?, CashFlow | `mismatch` | create/import | mismatch flags | `deleteStatement` + flows |
| **CashFlow** | Одна проводка / нога перевода | Account, CP?, Article?, Deal?, Statement? | autoAssigned, isTransfer, importKey | create/transfer/import | assign/convert | delete / unlink |
| **AutoRule** | Авторазнесение импорта | CP?, Article? | logicOperator | CRUD finance | update | delete |
| **Payment** | Факт выплаты ЗП | PaymentBatchItem | — | `markEmployeePaid` | — | нет reverse в app |
| **PaymentBatchItem** | Payment ↔ Operation | Payment, ProductionOperation | — | createMany при выплате | — | seed |
| **Goal** | План выпуска изделия/месяц | Product | GoalStatus | `createGoal` | **нет update/archive** | seed; блокирует delete Product |
| **BatchCost** | Снапшот распределения стоимости партии | Batch | PRELIMINARY/FINAL | `recalcBatchCosts`; `freezeBatch` | replace delete+create | deleteMany на recalc/freeze/batch delete |
| **ProductCost** | **Резерв A17** месячная полная с/с | Product | CostStatus | **нет writers** | — | seed; count на delete Product |
| **Sale** | Продажа/возврат МП | sku, productId? | `isReturn` | upsert sync | upsert | seed |
| **Supply** | Поставка на склад МП (= отгрузка ГП) | sku, productId? | status string; deductedQty; shortfallQty | upsert | deduct/restore | нет delete |
| **Notification** | Колокольчик | — | isRead, isSystem, tone | notifyEvent; syncSystem | mark read | deleteMany stale system |
| **Setting** | KV JSON | — | — | upsert settings | upsert | нет delete |
| **CalendarDay** | Произв. календарь | — | isWorkingDay | **нет CRUD в app/seed** | — | — |

---

## Детали ограничений (сжато)

### PK / unique / indexes

| Model | PK | Unique | Indexes |
| ----- | -- | ------ | ------- |
| User | cuid | `email` | — |
| Employee | cuid | **pin не unique** | — |
| Material | cuid | `[name, sectionWidthMm, sectionHeightMm]` | — |
| Batch | cuid | `name` | — |
| RailLot | cuid | `code` (nullable, пакеты) | — |
| Detail | cuid | — | `[materialId, detailNumber]` **не unique** |
| Product | cuid | skuOzon/skuWb **не unique в БД** | — |
| ProductDetail | cuid | `[productId, detailId]` | — |
| ProductionOperation | cuid | `clientRequestId` | `workDate`; `[employeeId, workDate]` |
| BlankStock | cuid | `[materialId, lengthM, detailType, sort]` | — |
| DetailStock | cuid | `[detailId, torcevayaDone, ploskostDone]` | — |
| ProductStock | cuid | `productId` | — |
| NomenclatureStock | cuid | `nomenclatureId` | — |
| ChangeLog | cuid | — | `[entity, entityId]` |
| SystemLog | cuid | — | `createdAt Desc`, `level` |
| CashFlow | cuid | importKey **не unique** — только `@@index([accountId, importKey])` | date; transferId |
| Sale | cuid | `[marketplace, externalId]` | date |
| Supply | cuid | `[marketplace, externalId, sku]` | createdAt |
| Notification | cuid | `key` | isRead |
| Setting | `key` string | PK=key | — |
| CalendarDay | `date` | PK=date | — |
| BatchCost | cuid | — | batchId |
| ProductCost | cuid | — | `[productId, periodStart, periodEnd]` не unique |

### Nullable / JSON / Decimal money (важное)

- **Employee:** `birthDate`, все rate `Decimal?` — null = нет этой сдельной/почасовой.
- **Material.section*:** nullable «на время миграции» (схема L143–144).
- **Batch:** `note`, `customFields` Json (**писателей в src/server нет**), `closedAt`, `frozenAt`.
- **Product.packagingId** optional.
- **ProductionOperation:** batch/railLot/railsTaken/hours/product* / clientRequestId / paidAt optional по типу операции.
- **Account:** `accountNumber`, `bik`, `balanceAsOf`; `balance` — кэш, пересчитывается при чтении (`account-balance.ts` + комментарий схемы L537).
- **ChangeLog / SystemLog:** JSON old/new / details; `userId` optional.
- **Setting.value:** Json.
- **DealItem.batchId** optional.

### Soft delete

Нет колонок `deletedAt` / `isArchived`. Архив = enum status (`Employee`, `ProductStatus` справочники, `BatchStatus`, `DealStatus`, `GoalStatus`).

Batch дополнительно: `closedAt` (выработка), `frozenAt` (заморозка с/с). Это ортогонально статусу ARCHIVED: архив при остатке 0, freeze когда closed + все TORCOVKA выплачены (`cost.ts:maybeFreezeBatch` ~L510).

### Derived / cache в БД

| Поле | Как заполняется |
| ---- | ---------------- |
| `RailLot.remainingQuantity` | live, decrement торцовка / write-off |
| `Batch.totalCost` | purchaseCost + доля доставки сделки (`syncBatchTotalCost`) |
| `BatchCost.*` | recalc / freeze |
| `Deal.total` | `syncDeal` |
| `Account.balance` | кэш; источник истины — openingBalance + flows (`lib/account-balance.ts`) |
| `InventoryLine.deviation*` | при проведении |
| `Supply.deductedQty` / `shortfallQty` | идемпотентность списания ГП |
| `*Stock.quantity` | live остатки |
| `Payment.amount` | сумма начисленных операций на момент выплаты |

`ProductCost` — зарезервировано, отчёт `getCostReport` считается **живым** (`schema` L718–723).

`BlankStock` **без** `batchId`: заготовки обезличиваются по (material, length, type, sort). Изделие за период — WAC по породе (`blendedCostPerMeterByMaterial`). Это зафиксировано в cost-integrity / схеме L406–408.

---

## Граф сущностей (факт Stell22)

```text
User ──writes──> ChangeLog / SystemLog     Setting / Notification / CalendarDay(unused)

Employee ──<── ProductionOperation
                   │
                   ├── OperationDetailLine ──moves──> BlankStock / DetailStock
                   ├── OperationNomenclatureLine ──moves──> NomenclatureStock
                   └── PaymentBatchItem ──> Payment

Material ──<── Batch ──<── RailLot ──depleted by── TORCOVKA
     │            │
     │            ├── BatchCost (PRELIMINARY → FINAL + Batch.frozenAt)
     │            └── DealItem ──> Deal <── CashFlow ──> Account
     │                                  │                 └── Statement
     │                            Article <── ArticleCategory (isOverhead)
     │                            Counterparty / AutoRule
     │
     ├── Detail ──<── ProductDetail ──> Product ──> ProductStock
     │      └── DetailStock                 ├── ProductFastener/Extra ──> NomenclatureItem
     │                                      │         └── NomenclatureStock <── SimplePurchase
     │                                      ├── Goal
     │                                      ├── ProductCost (no writers)
     │                                      └── sku match ──> Sale / Supply / MpStock
     └── BlankStock <── TORCOVKA out / PRISADKA in / inventory

Inventory ── InventoryLine ──sets qty──> ProductStock | DetailStock/BlankStock | NomenclatureStock
```

Связующие узлы между доменами:

| Стык | Мост |
| ---- | ---- |
| Закупка ↔ производство | `Batch` / `RailLot` ↔ `ProductionOperation.batchId` |
| Производство ↔ склад | ops ↔ Blank/Detail/Product/NomenclatureStock |
| Производство ↔ ЗП | `ProductionOperation.isPaid` ↔ `Payment` |
| Закупка ↔ деньги | `DealItem` Batch ↔ `CashFlow.dealId`; `Batch.totalCost` |
| Склад ГП ↔ отгрузка | `Supply` deduct `ProductStock` |
| Материал ↔ изделие | `Product.materialId`; детали того же материала |
| Аудит | `writeChangeLog` почти на все мутации |

---

## Схема vs код (не баги — факты)

1. **ProductCost** — таблица есть, writers нет (A17).
2. **CalendarDay** — нет чтения/записи в `src/server` и seed.
3. **Batch.customFields** — схема, writers не найдены.
4. **InventoryStatus.CLOSED** — enum + UI-лейблы; server: DRAFT → CONDUCTED.
5. **Goal** — только create ACTIVE.
6. **SimplePurchase / Payment** — create-only в app.
7. **User** — создаётся сидом / `set-admin-password.ts`; app только логинит.
8. **Нет Order.**
