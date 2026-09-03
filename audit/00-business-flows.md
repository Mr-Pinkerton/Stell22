# Этап 0: бизнес-процессы и state machines

Цепочки UI → server action → validation → Prisma. Корректность формул **не** оценивалась.

**Базовый факт:** клиентского заказа нет. Производство — **pull с терминала** (сотрудник сам сабмитит операцию). Админ правит/удаляет **невыплаченные** операции.

---

## Домены → процессы

См. таблицу доменов в `00-project-map.md` §5.

---

## Процессы

### 1. Создание / изменение клиентского заказа — **НЕТ**

Ближайший аналог — **сделка закупки (Deal)**, не production order.

```text
Deal create/update
UI: src/components/finance/deal-form-dialog.tsx → finance-view.tsx
→ createDeal / updateDeal  src/server/finance.ts ~L1168 / ~L1192
→ validation: name; ≥1 batch name
→ Prisma: Deal.create { status: OPEN } + DealItem; или DealItem.deleteMany + Deal.update
→ related: syncDeal → Deal.total, Batch.totalCost; writeChangeLog(Deal)
```

### 2. Запуск заказа/позиций в производство — **НЕТ**

Нет queue / launch API. Работа начинается с `submitTorcovka` / `submitPrisadka` / `submitUpakovka` / `submitHours`.

### 3. Производственное задание / назначение — **НЕТ**

Админ: журнал `production-view.tsx` → `updateProductionLineQuantity` / `deleteProductionOperation` (`production.ts`). Это коррекция факта, не задание.

### 4. Начало работы (торцовка)

```text
UI: src/components/terminal/torcovka-screen.tsx
→ submitTorcovka  terminal.ts ~L332
→ requireTerminalEmployee(employeeId)
→ railsTaken>0; picks; lot.batchId; isOverRailLength; remainingQuantity gte decrement
→ tx: RailLot.remainingQuantity--; ProductionOperation TORCOVKA + OperationDetailLine;
      BlankStock.upsert++; archiveBatchIfDepleted; writeChangeLog
→ after: enqueueRecalcBatchCosts
```

### 5. Присадка

```text
UI: prisadka-screen.tsx
→ submitPrisadka  terminal.ts ~L647
→ requireTerminalEmployee; picks>0; applyPrisadkaPick gte stock
→ tx: ProductionOperation PRISADKA; DetailStock/BlankStock; OperationDetailLine; ChangeLog
```

### 6. Завершение работы / упаковка

Операции создаются **сразу завершёнными** (нет IN_PROGRESS).

```text
UI: upakovka-screen.tsx
→ submitUpakovka  terminal.ts ~L924
→ requireTerminalEmployee; applyUpakovkaPick
→ tx: ProductionOperation UPAKOVKA; ProductStock++; Detail/Blank/NomenclatureStock--; lines; ChangeLog
```

Реверс: `reversePrisadkaLine` ~L555, `reverseUpakovkaOperation` ~L840 — из `production.ts` правок/удалений.

### 7. Начисление сдельной ЗП

Начисление **не отдельный документ**: ставка × операция при создании (`lib/payroll.ts:operationEarning`).  
Выплата:

```text
UI: report-salaries-tab.tsx → markEmployeePaid
→ payroll.ts:markEmployeePaid ~L183
→ unpaid ops exist; tx updateMany isPaid false→true count match (A19)
→ Payment.create; PaymentBatchItem.createMany; maybeFreezeBatch; notifyEvent; ChangeLog(Payment)
```

### 8. Почасовая работа

```text
UI: hours-screen.tsx
→ submitHours  terminal.ts ~L971
→ requireTerminalEmployee; hours>0; clientRequestId идемпотентность
→ ProductionOperation { type: HOURS, hours }; ChangeLog
→ earning = hours × Employee.hourlyRate (отчёт, не колонка)
```

### 9. Закупка рейки (партия)

```text
UI: batch-form-dialog.tsx / purchases-view.tsx
→ createBatch  purchases.ts ~L234; updateBatch ~L288
→ validateBatch; assertUniqueBatchName; сечение материала
→ Batch.create { IN_WORK, totalCost=purchaseCost } + RailLot[] (remainingQuantity=quantity)
→ ChangeLog; update → enqueueRecalcBatchCosts
```

### 10. Поступление материала

| Канал | Функция | Эффект |
| ------ | -------- | ------ |
| Рейка | `createBatch` | RailLot.remainingQuantity = quantity |
| Крепёж/упаковка | `createSimplePurchase` ~L397 | SimplePurchase + NomenclatureStock.upsert++ |
| Заготовки | `submitTorcovka` | BlankStock++ |
| ГП | `submitUpakovka` | ProductStock++ |
| Инвентаризация | `conductInventory` | qty := actual |

### 11. Списание материала

```text
Остаток партии → отход
UI: purchases-view.tsx
→ writeOffBatchRemainder  purchases.ts ~L327
→ remaining>0
→ tx: RailLot.remainingQuantity=0; archiveBatchIfDepleted
```

Также: торцовка (рейки), присадка/упаковка (склады), inventory actual, Supply deduct ProductStock.

### 12. Отгрузка (маркетплейс Supply)

```text
UI: sales-view.tsx → syncMarketplaces
→ marketplace.ts:syncMarketplaces ~L498 → requireAdmin → syncMarketplacesAsUser ~L504
→ Supply.upsert; SHIPPED/ACCEPTED → ProductStock.decrement (computeSupplyDeduction)
→ cancel Ozon → restore deductedQty, status PENDING
→ Sale.upsert; MpStock replace; ChangeLog shortfall/restore
```

### 13. Оплата клиента — **отдельного процесса нет**

Доход = `CashFlow` INCOME (ручной / выписка / автоправила), опционально `dealId`.  
«Оплачена сделка» = ручной `setDealStatus(..., ARCHIVED)`, не авто из платежей.

```text
UI: cashflow-form-dialog.tsx
→ createCashFlow  finance.ts ~L809; assignCashFlow ~L936; importStatement ~L1319
→ amount>0; account; 1C format
```

### 14. Расход денег / перевод

```text
UI: cashflow-form-dialog / transfer-form-dialog
→ createCashFlow EXPENSE; createTransfer  finance.ts ~L870
→ amount>0; счета различны
→ CashFlow ×2 isTransfer=true, общий transferId
→ syncDeal если dealId
```

### 15. Создание сотрудника

```text
UI: employee-form-dialog.tsx
→ createEmployee  employees.ts ~L104
→ fullName; assertActivePin (4 цифры, unique среди ACTIVE)
→ Employee.create ACTIVE + rates; ChangeLog
```

### 16. Архив / restore / hard delete

| Сущность | Archive | Restore | Hard delete |
| -------- | ------- | ------- | ----------- |
| Employee | `archiveEmployee` | `restoreEmployee` + PIN re-check | `deleteEmployee` если 0 ops |
| Detail/Item/Product | `archive*` nomenclature.ts | `restore*` | delete с guards + child cleanup |
| Material | `archiveMaterial` | `restoreMaterial` | delete если unused |
| Deal | `setDealStatus(ARCHIVED)` | `setDealStatus(OPEN)` | `deleteDeal` unlink cashflows |
| Batch | auto `archiveBatchIfDepleted` | **restore IN_WORK не найден** | `deleteBatch` если нет ops/deals |
| Goal | enum есть | — | нет API |

### 17. Terminal login

```text
UI: login-screen.tsx (не выбирает ФИО — только PIN, lib/employee-pin.ts L1–4)
→ terminalLoginByPin  terminal.ts ~L267
→ RateLimiter; resolvePinLookup; только ACTIVE; коллизия → reject
→ cookie stell22_terminal
Idle 30s на клиенте → terminalLogout  terminal-app.tsx
```

### 18. Admin login

```text
UI: login-form.tsx /login
→ signIn  auth.ts ~L44
→ RateLimiter 5/15min; verifyPassword; User.findUnique
→ cookie stell22_session; redirect /dashboard
proxy.ts: без cookie → /login; с cookie на /login → /dashboard
```

### 19. Справочники

```text
UI: nomenclature-view + form dialogs; materials
→ nomenclature.ts create/update/archive/restore/delete Detail|Product|NomenclatureItem
→ materials.ts то же для Material
→ validation: номера деталей, BOM material match, сечение, unique names
→ ChangeLog
```

### 20. ChangeLog / audit

```text
writeChangeLog  change-log.ts ~L24 → ChangeLog.create
Вызывается из terminal, purchases, production, payroll, finance, warehouse,
nomenclature, materials, employees, marketplace, goals, cost, settings (~79 call sites)
UI: settings → getSettingsLogs  audit.ts → SettingsLogsTab
SystemLog отдельно (МП/IMAP ошибки)
```

### Дополнительно

**Инвентаризация**

```text
UI: warehouse-inventory-tab.tsx
→ createInventoryDraft  warehouse.ts ~L224  (один DRAFT)
→ updateInventoryLineActual ~L280
→ conductInventory ~L307  DRAFT→CONDUCTED; *Stock := actual; deviationSum
```

**Заморозка себестоимости**

```text
markEmployeePaid / archiveBatchIfDepleted
→ maybeFreezeBatch  cost.ts ~L510
→ freezeBatch: Batch.frozenAt; BatchCost FINAL; recalc пропускает frozen
```

**Импорт выписки**

```text
UI upload / IMAP cron
→ importStatement  finance.ts ~L1319
→ 1CClientBankExchange; РасчСчет; importKey findFirst skip
→ Account (quarantine confirmed=false если auto-created); CashFlow; Counterparty; AutoRule
```

**Идемпотентность терминала (A21)**

`ProductionOperation.clientRequestId` unique; дубль P2002 → успех без второй операции (`terminal.ts` L59–71).

---

## State machines

### Employee

```text
(create) → ACTIVE ⇄ ARCHIVED
```

| From | To | Function | Validation |
| ---- | -- | -------- | ---------- |
| — | ACTIVE | `createEmployee` | PIN unique ACTIVE |
| ACTIVE | ARCHIVED | `archiveEmployee` → `setStatus` | exists |
| ARCHIVED | ACTIVE | `restoreEmployee` | PIN re-validate |

### Batch

```text
(create) → IN_WORK → ARCHIVED (closedAt)
           └── freeze: frozenAt + BatchCost FINAL  (после closedAt ∧ unpaid TORCOVKA=0)
Нет перехода ARCHIVED → IN_WORK.
```

| From | To | Function | Validation |
| ---- | -- | -------- | ---------- |
| — | IN_WORK | `createBatch` | validateBatch |
| IN_WORK | ARCHIVED + closedAt | `archiveBatchIfDepleted` | Σ remainingQuantity=0 |
| unfrozen | frozenAt | `freezeBatch` via `maybeFreezeBatch` | closedAt + unpaid TORCOVKA=0 |

Write-off и последняя торцовка — два пути в `archiveBatchIfDepleted`.

### BatchCost

| From | To | Function |
| ---- | -- | -------- |
| — | PRELIMINARY | `recalcBatchCosts` (deleteMany PRELIMINARY + create) |
| PRELIMINARY | FINAL | `freezeBatch` (delete all BatchCost + create FINAL) |

### Deal

```text
OPEN ⇄ ARCHIVED   setDealStatus  (без доп. валидации оплаты)
```

### Справочники Material / Detail / Product / NomenclatureItem

```text
ACTIVE ⇄ ARCHIVED   archive*/restore*
```

Hard delete — отдельная ветка с «нельзя если используется».

### Inventory

```text
DRAFT → CONDUCTED    conductInventory
CLOSED — enum, writer не найден
```

Один DRAFT глобально (`createInventoryDraft`).

### ProductionOperation (флаги, не enum status)

```text
isPaid=false → true   markEmployeePaid (atomic claim)
isPaid=true  → edit/delete запрещены  production.ts ~L212 / ~L391
type фиксируется при create (TORCOVKA|PRISADKA|UPAKOVKA|HOURS)
```

### Supply (string)

```text
upsert API → PENDING | SHIPPED | ACCEPTED
SHIPPED/ACCEPTED → deduct ProductStock
Ozon cancel → PENDING + restore deductedQty
```

### Goal

```text
(create) → ACTIVE
ARCHIVED — нет функции
```

### Account / CashFlow / Notification

| Entity | Переход | Function |
| ------ | ------- | -------- |
| Account.confirmed | bool | `setAccountConfirmed` finance.ts ~L354 |
| Account.isPrimary | bool | set primary |
| CashFlow | unassigned → article/deal | `assignCashFlow` |
| CashFlow | ordinary → transfer | `convertCashFlowToTransfer` |
| Notification | unread → read | `markNotificationRead` / `markAll` |

### DetailStock (бакеты, не workflow документа)

Комбинации `(torcevayaDone, ploskostDone)`. «Готово» когда выполнены требуемые присадки детали (`lib/detail-stock.ts:isReady`). Движения: `applyPrisadkaPick` / упаковка.

### ProductCost / CalendarDay

Переходов в коде нет.
