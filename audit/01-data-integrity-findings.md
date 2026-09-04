# Этап 1: Data Integrity findings

HEAD `5479580bdb1a33f53dec8005a2354456537ec8d4`. Карта: `audit/01-data-integrity-map.md`. Инварианты: `audit/01-data-integrity-invariants.md`.

Только подтверждённые находки с evidence. Не баги: двойное списание реек/деталей на gte-путях; «торцовка не возвращает рейки»; sequential retry импорта/supply; payroll claim; freeze в той же TX что Payment.

Шкала: P0 массовая порча без восстановления; P1 реальный неверный склад/деньги/ЗП/с/с; P2 слабый invariant / редкий race; P3 долг без текущего нарушения.

---

## Сводка

| ID | Sev | Status | Domain | Title |
| --- | --- | --- | --- | --- |
| DI-001 | P1 | CONFIRMED BUG | Cost/Purchases | `updateBatch` меняет `purchaseCost`, не `totalCost` |
| DI-002 | P1 | CONFIRMED BUG | Finance/Cost | `setAccountConfirmed` не пересчитывает Deal/Batch totals |
| DI-003 | P1 | CONFIRMED RACE | Finance | `importKey` не UNIQUE — concurrent import дублирует CashFlow |
| DI-004 | P1 | CONFIRMED RACE | Marketplace | Два sync могут дважды списать ProductStock (в минус) |
| DI-005 | P2 | CONFIRMED RACE | Cost | `syncBatchTotalCost` может записать `totalCost` после freeze |
| DI-006 | P2 | CONFIRMED RACE | Cost | recalc без TX/lock: orphan PRELIMINARY рядом с FINAL |
| DI-007 | P2 | INVARIANT WEAKNESS | Production | Torcovka: decrement реек до unique insert; retry может вернуть ошибку |
| DI-008 | P2 | INVARIANT WEAKNESS | Production | `clientRequestId` nullable UNIQUE |
| DI-009 | P2 | DESIGN RISK | Inventory | `conductInventory` ставит qty=X, ломает reverse/provenance |
| DI-010 | P2 | DESIGN RISK | Marketplace | skuOzon/skuWb не unique |
| DI-011 | P2 | DESIGN RISK | Marketplace | SHIPPED→PENDING не возвращает ГП (кроме Ozon cancel) |
| DI-012 | P3 | DESIGN RISK | Cost | cost-queue in-memory; CLI recalc/sync в обход |
| DI-013 | P2 | DESIGN RISK | Finance | Deal/CF commit без derived `totalCost` в той же TX |
| DI-014 | P3 | INVARIANT WEAKNESS | Payroll | нет UNIQUE PaymentBatchItem.operationId |
| DI-015 | P3 | NEEDS BUSINESS DECISION | Payroll | ставки live, не snapshot на операции |
| DI-016 | P3 | INVARIANT WEAKNESS | Inventory | два DRAFT при concurrent create |
| DI-017 | P3 | INVARIANT WEAKNESS | Marketplace | MpStock без unique (marketplace,sku) |

---

## DI-001

```
ID: DI-001
Severity: P1
Status: CONFIRMED BUG
Domain: Cost / Purchases

Invariant:
Batch.totalCost = purchaseCost + доля доставки из подтверждённых ДДС сделок
(v2: C = закупка + доставка). createBatch выставляет totalCost = purchaseCost.

Evidence:
src/server/purchases.ts:createBatch L253 (init totalCost)
src/server/purchases.ts:updateBatch L301-324 — пишет purchaseCost, prices, section;
  НЕ пишет totalCost; НЕ вызывает syncBatchTotalCostInternal; нет проверки frozenAt.
src/lib/cost.ts distribute использует totalCost как C
src/lib/cost-report.ts:210
src/server/internal/finance-operations.ts:syncBatchTotalCostInternal L66-92

Current behavior:
Правка закупочной стоимости партии обновляет purchaseCost и ставит recalc.
Recalc/live report берут C из totalCost. Пока никто не вызовет sync сделки,
C остаётся старым. Если сделок нет — totalCost навсегда расходится с purchaseCost.

Failure scenario:
1. Создать партию purchaseCost=100 000 → totalCost=100 000.
2. Админ правит счёт: purchaseCost=120 000, сохранить.
3. Отчёт закупок / себестоимость распределяет 100 000.
4. Если позже привязать сделку — sync пересчитает от нового purchaseCost;
   до тех пор отчёты врут.

Concurrency:
Не нужна. Sequential intended path.

Business impact:
Неверная себестоимость материала (₽/м³, детали, изделия) и «Общая» в закупках.
Деньги в ДДС не трогаются.

Detection:
Сравнить Batch.purchaseCost и Batch.totalCost у партий без (и с) сделками;
mismatch vs P·V смотрит purchaseCost, distribute — totalCost.

Recovery:
Вызвать sync по сделкам партии или руками выставить totalCost.
Если сделок нет — totalCost должен стать равным purchaseCost.

Minimal fix direction:
В updateBatch: пересчитать totalCost тем же syncBatchTotalCostInternal
(и не менять финансы замороженной партии / или запретить правка C после freeze).

Confidence: HIGH
```

---

## DI-002

```
ID: DI-002
Severity: P1
Status: CONFIRMED BUG
Domain: Finance / Cost

Invariant:
После подтверждения карантинного счёта его ДДС участвуют в Deal.total и
Batch.totalCost. Комментарий setAccountConfirmed finance.ts:365-368 это обещает
для «себестоимости сделок».

Evidence:
src/server/finance.ts:setAccountConfirmed L370-376 — только account.confirmed.
Нет syncDealInternal / syncBatchTotalCostInternal.
Import: statement-import.ts создаёт confirmed:false, затем после TX
syncDealInternal по auto-assigned deals — в этот момент sumConfirmedExpense
ещё отсекает неподтверждённый счёт (deal-cost.ts / finance-operations.ts:63-64).
getFinanceData / getPeriodOverhead фильтруют confirmed=true — live ДДС ок,
derived Batch.totalCost нет.

Current behavior:
Типовой поток: импорт → автоправило привязало CF к сделке → sync посчитал
доставку = 0 (карантин) → админ подтверждает счёт в Настройках → totals
остаются без доставки до следующей мутации Deal/CF.

Failure scenario:
1. Импорт выписки, новый счёт, автоправило dealId.
2. syncDeal после импорта: extras=0.
3. Подтвердить счёт.
4. Себестоимость партий сделки без доставки; KPI ДДС уже показывает расход.

Concurrency:
Не нужна.

Business impact:
Заниженный Batch.totalCost / Deal.total; заниженная с/с. Обратное снятие
подтверждения оставляет завышенный C до следующего sync.

Detection:
Счёт confirmed, у CF есть dealId, сумма confirmed expenses ≠ доля в totalCost.

Recovery:
Любая последующая assign/create/delete CF по сделке или updateDeal вызовет sync.
Или ручной re-sync.

Minimal fix direction:
После setAccountConfirmed собрать dealId по CF этого счёта и вызвать
syncDealInternal.

Confidence: HIGH
```

---

## DI-003

```
ID: DI-003
Severity: P1
Status: CONFIRMED RACE
Domain: Finance

Invariant:
Одна банковская операция (тот же importKey на счёте) = одна строка CashFlow.
Комментарий lib/statement-import.ts:13-16 и INV-035.

Evidence:
prisma/schema.prisma CashFlow L643-648 @@index([accountId, importKey]) — не @unique.
prisma/migrations/20260630164144_cashflow_import_key/migration.sql:
  CREATE INDEX ... (не UNIQUE).
src/server/internal/statement-import.ts:256-299 findFirst then create внутри I TX.
Два входа: importStatement (admin) и POST /api/cron/fetch-statements +
scripts/fetch-statements.ts.

Current behavior:
Последовательный повтор того же файла: findFirst видит ключ → skip. Безопасно.
Два одновременных import (IMAP cron + ручная загрузка, или два cron overlap
пока первый TX ещё открыт): оба findFirst не видят незакоммиченный insert
(READ COMMITTED) → два CF с одним importKey, разными id.

Failure scenario:
1. Host cron начинает import большой выписки (TX открыт на все документы).
2. Админ загружает тот же файл.
3. Оба TX создают Statement + полный набор CF.
4. ДДС, баланс, deal extras / Batch.totalCost (если confirmed + auto-deal)
   удваиваются.

Concurrency:
Нужны параллельные импорты одного содержимого. Окно = длительность TX импорта
(может быть секунды). Sequential retry после rollback безопасен.

Business impact:
Двойные деньги в ДДС/KPI/балансе; возможна двойная доставка в с/с.
Восстановление: удалить дубли по (accountId, importKey) или откатитить лишнюю
выписку (две Statement на один файл).

Detection:
GROUP BY accountId, importKey HAVING count>1; две Statement с одним fileUrl/датой.

Recovery:
Да, если найти дубли. deleteStatement откатывает одну пачку CF.

Minimal fix direction:
UNIQUE (accountId, importKey) где importKey NOT NULL; ловить unique violation
как skip. Не полагаться на findFirst.

Confidence: HIGH
```

---

## DI-004

```
ID: DI-004
Severity: P1
Status: CONFIRMED RACE
Domain: Marketplace / Warehouse

Invariant:
Отгрузка поставки списывает ProductStock один раз на (delta). Нельзя уйти в минус
(computeSupplyDeduction + комментарий marketplace-sync.ts:535).

Evidence:
src/lib/supply-stock.ts:computeSupplyDeduction — cap по переданному available.
src/server/internal/marketplace-sync.ts:504-567:
  READ existing deductedQty/shortfallQty
  READ productStock.quantity
  compute in memory
  productStock.update({ decrement: toRemove })  // без gte, без updateMany count
  supply.update deductedQty
Нет advisory lock / sync mutex.
Входы: syncMarketplaces (admin) и scripts/run-mp-sync.ts (тот же internal).
Prod: один app-контейнер, но два запроса = две PG TX.

Current behavior:
Последовательный повтор: alreadyDeducted+short ≥ target → delta<=0, не списывает.
Два overlapping sync: оба читают alreadyDeducted=0 и available=N, оба decrement
toRemove. Stock может стать отрицательным. Оба пишут deductedQty≈toRemove
(не сумму) → счётчик «факта» меньше реального списания. Cancel restore вернёт
только deductedQty.

Failure scenario:
1. ProductStock=10, supply SHIPPED qty=8.
2. Админ жмёт «Синхронизация», параллельно `npx tsx scripts/run-mp-sync.ts`
   (или двойной клик, пока первый TX не закоммитился).
3. Stock: 10-8-8 = -6. deductedQty=8.
4. Отмена Ozon вернёт 8 → stock=2. Потеряны 8 единиц учёта vs физика.

Concurrency:
Нужны параллельные sync. Sequential безопасен.

Business impact:
Отрицательный / заниженный ГП; shortfall/restore врут; упаковка/reverse
дальше расходятся с МП.

Detection:
ProductStock.quantity < 0; SUM(Supply.deductedQty) по SKU vs падение GP
за период; два SystemLog sync с перекрывающимся временем.

Recovery:
Инвентаризация ГП; поправить deductedQty вручную сложно (нет UI).

Minimal fix direction:
Как production: updateMany WHERE quantity >= toRemove; условный update
Supply WHERE deductedQty = alreadyDeducted; либо advisory lock на sync.
Не decrement без CAS.

Confidence: HIGH
```

---

## DI-005

```
ID: DI-005
Severity: P2
Status: CONFIRMED RACE
Domain: Cost / Finance

Invariant:
После freeze Batch.totalCost и FINAL snapshot не меняются
(finance-operations.ts:64 «Замороженные партии не трогаем»).

Evidence:
syncBatchTotalCostInternal L67-68: if (!batch || batch.frozenAt) return;
L91: prisma.batch.update({ data: { totalCost } }) — без where frozenAt: null.
recalc пропускает frozenAt != null на стартовом findMany (cost.ts:344-346)
и не переписывает FINAL.
freezeBatch в payroll TX ставит frozenAt + FINAL.

Current behavior:
Sequential: frozen партия, sync сразу выходит — OK.
Race: process A прочитал frozenAt=null; process B freeze commit; A пишет
новый totalCost. FINAL в BatchCost прежний. Live cost report для frozen
берёт FINAL (loadCostContext L181, L234). Purchases/reports KPI читают
Batch.totalCost — расходится с FINAL.

Concurrency:
Нужны параллельные sync сделки и выплата, закрывающая freeze.
Реже, чем DI-001.

Business impact:
У frozen партии «Общая» в закупках может уехать от замороженного распределения.
Отчёт с/с изделия по FINAL скорее цел.

Detection:
frozenAt IS NOT NULL AND Batch.totalCost != costSort1+costSort2 FINAL
(с учётом округления).

Recovery:
Вернуть totalCost к сумме FINAL или пересчитать только отображение из FINAL.

Minimal fix direction:
update с where: { id, frozenAt: null } и проверка count; либо sync внутри
того же lock/tx что freeze.

Confidence: HIGH
```

---

## DI-006

```
ID: DI-006
Severity: P2
Status: CONFIRMED RACE
Domain: Cost

Invariant:
Пока партия не frozen — один актуальный PRELIMINARY; после freeze — только FINAL.
recalc не должен писать после freeze.

Evidence:
internal/cost.ts:recalcBatchCosts L340-361: нет $transaction, нет lock.
deleteMany PRELIMINARY затем create PRELIMINARY отдельными await.
Schema BatchCost @@index(batchId) без unique (status).
cost-queue.ts:11-39 in-process Map — не шарится с прямым recalc и не с CLI.
freeze между deleteMany и create: FINAL уже есть, late create добавляет
PRELIMINARY. Отчёт читает только FINAL L181.

Current behavior:
Очередь на одном app-процессе коалесцирует enqueue. Два recalc в обход
очереди / freeze vs recalc → несколько PRELIMINARY или PRELIMINARY+FINAL.
Содержимое PRELIMINARY может lost-update. На cost UI почти не влияет.

Concurrency:
Параллельный recalc или freeze vs recalc.

Business impact:
Сейчас низкий (PRELIMINARY write-mostly). Риск если кто-то начнёт читать
PRELIMINARY как SoT. Мусорные строки в BatchCost.

Detection:
COUNT(*) FROM BatchCost GROUP BY batchId, status HAVING count>1;
PRELIMINARY при frozenAt IS NOT NULL.

Recovery:
delete лишних PRELIMINARY у frozen; для открытых — один enqueue.

Minimal fix direction:
Обернуть delete+create в TX; where frozenAt null на write;
UNIQUE (batchId) WHERE status='PRELIMINARY' или upsert; не писать если
frozenAt уже не null.

Confidence: HIGH
```

---

## DI-007

```
ID: DI-007
Severity: P2
Status: INVARIANT WEAKNESS
Domain: Production

Invariant:
Повтор того же clientRequestId после успеха = success, без побочных эффектов
(комментарий terminal.ts:59-62, A21).

Evidence:
submitTorcovka L367 decrement реек, L373 create с clientRequestId.
.catch isDuplicateClientRequest только на P2002.
Если TX уже закоммичена, retry: remaining может не пройти gte → throw
«Недостаточно реек», это не P2002 → клиент видит ошибку, хотя первая
операция есть. Prisadka/Upakovka создают Op сначала — P2002 до списания.

Current behavior:
Данные не двоятся (неуспешный retry откатывается). Идемпотентный контракт
для торцовки нарушен при depleted lot.

Concurrency:
Retry после успеха (сеть/двойной тап) на том же id. Не нужны два терминала.

Business impact:
Оператор думает, что торцовка не прошла, открывает новую вкладку (новый id)
и пытается ещё раз — если реек уже 0, вторая не пройдёт. Путаница, не
silent double stock.

Detection:
Op существует, клиент получил 500 на retry.

Recovery:
Не требуется для qty.

Minimal fix direction:
Как prisadka: create+unique сначала, затем decrement; или на gte-fail
проверить существующую Op с этим clientRequestId → success.

Confidence: HIGH
```

---

## DI-008

```
ID: DI-008
Severity: P2
Status: INVARIANT WEAKNESS
Domain: Production

Invariant:
Дубль терминальной попытки не создаёт две ProductionOperation.

Evidence:
schema ProductionOperation.clientRequestId String? @unique
migration 20260713161800 UNIQUE INDEX.
PostgreSQL UNIQUE позволяет много NULL.
submit* принимают optional clientRequestId.
Hours: create без TX.

Current behavior:
UI шлёт id. Вызов без id (скрипт, старый клиент, забытый аргумент) —
каждый create проходит. Две вкладки с разными id — две реальные операции
если хватает остатка (это ключ на попытку, не на «физическое действие»).

Concurrency:
Без id — даже sequential double submit.

Business impact:
Двойные ops → двойная ЗП и двойной расход склада, если остаток позволяет.

Detection:
Ops без clientRequestId в одно время/схожим qty.

Recovery:
Админ delete до выплаты (если gte reverse проходит).

Minimal fix direction:
Требовать clientRequestId на всех submit; NOT NULL для новых строк.

Confidence: HIGH
```

---

## DI-009

```
ID: DI-009
Severity: P2
Status: DESIGN RISK
Domain: Inventory / Production

Invariant:
Остаток *Stock согласован с историей ProductionOperation / SimplePurchase /
Supply. Reverse должен вернуть исходные пулы.

Evidence:
warehouse.ts:conductInventory L331-391 upsert update: { quantity: line.actualQty }
(абсолют, не delta). Valuation читается вне TX L322.
InventoryStatus.CLOSED без writer. Нет связи document ↔ movement lines.

Current behavior:
Проведение ставит учётный остаток в факт. Ops/provenance не меняются.
Если факт < того, что reverse хочет вернуть — delete/edit упаковки падает на gte
(защита от минуса). Если факт > учёта, reverse старой упаковки может
«вернуть» детали, которые инвентаризация уже зачла → раздувание пула.

Concurrency:
Не обязательна. Concurrent packing во время conduct: lost update qty.

Business impact:
Склад расходится с журналом производства; возможные «лишние» детали после
цепочки submit → inventory up → reverse → submit.

Detection:
Сумма движений vs *Stock; gte-ошибки при удалении ops.

Recovery:
Повторная инвентаризация; не удалять ops после ручной коррекции без сверки.

Minimal fix direction:
Проводить delta-движения с документом; или запретить reverse ops,
пересекающихся с проведённой инвентаризацией. Не set qty=X без движения.

Confidence: HIGH
```

NEEDS BUSINESS DECISION: инвентаризация как «обнулить учёт под факт» — осознанный инструмент первичного ввода (`includeAllActive`). Тогда это EXPECTED с оговоркой «не reverse после». Решение: нужна ли блокировка unpaid ops.

---

## DI-010

```
ID: DI-010
Severity: P2
Status: DESIGN RISK
Domain: Marketplace / Nomenclature

Invariant:
Один skuOzon / skuWb соответствует одному Product (матчинг продаж и списания ГП).

Evidence:
schema Product L281-282 String NOT NULL, без @unique.
nomenclature.ts:371-372 только non-empty trim.
marketplace-sync.ts:424-425 Map sku→id, last-wins при дублях.
marketplace.ts:buildNameBySku last-wins для UI имён.

Current behavior:
Два изделия с одним Ozon offer_id: sync привяжет продажи/поставки к
последнему в findMany; списание ProductStock может пойти не на тот GP.

Concurrency:
Не нужна (данные справочника).

Business impact:
Чужой остаток ГП, неверные Sale.productId, путаница в отчёте продаж.

Detection:
GROUP BY skuOzon/skuWb HAVING count>1.

Recovery:
Развести артикулы; поправить productId на Sale/Supply.

Minimal fix direction:
UNIQUE skuOzon, UNIQUE skuWb (или уникальность среди ACTIVE) + server clash check.

Confidence: HIGH
```

---

## DI-011

```
ID: DI-011
Severity: P2
Status: DESIGN RISK
Domain: Marketplace

Invariant:
Списание ГП следует статусу поставки: отгрузка списывает, отмена возвращает
ровно deductedQty (комментарий schema Supply L773-775).

Evidence:
marketplace-sync.ts:536-538 shipped → target=qty else target=0.
Ветка deduct только если target > alreadyDeducted+alreadyShort.
При target=0 (PENDING) ветка не выполняется — deductedQty не обнуляется,
GP не возвращается.
Restore только цикл ozonCancelledExternalIds L575-604.

Current behavior:
PENDING→SHIPPED списывает delta. SHIPPED→PENDING в следующем sync:
target=0, already>0, условие ложно, stock и счётчики как при отгрузке.
WB/прочий cancel без списка Ozon cancel — ГП так и списан.

Concurrency:
Не нужна.

Business impact:
Заниженный заводской ГП при отмене поставки не через Ozon cancel API.

Detection:
Supply status PENDING/не shipped при deductedQty>0 (не из cancel-handler).

Recovery:
Ручная инвентаризация или повторный cancel-path.

Minimal fix direction:
Если !shipped && deductedQty>0 — restore как в cancel loop (не только Ozon).

Confidence: HIGH
```

---

## DI-012

```
ID: DI-012
Severity: P3
Status: DESIGN RISK
Domain: Cost / Infra

Invariant:
Пересчёт одной партии не идёт параллельно (комментарий cost-queue.ts:3-8).

Evidence:
cost-queue.ts Map/Set в модуле Node.
docker-compose.prod.yml: один service app, container_name stell22-app.
recalcBatchCosts экспортируется из internal/cost и вызывается очередью;
прямого server-action recalc в cost.ts больше нет (только getCostReport).
CLI MP sync не использует cost-queue, но и не recalc.

Current behavior:
На текущем prod (1 процесс) enqueue работает. Рестарт теряет dirty flag
(следующий enqueue починит). Горизонтальный scale сломает коалесцинг (DI-006).

Concurrency:
Второй инстанс / будущие replicas.

Business impact:
Сейчас низкий. Не портит FINAL. См. DI-006 если появится 2 app.

Detection:
Два контейнера app в compose/swarm.

Recovery:
n/a

Minimal fix direction:
Не масштабировать app без DB lock на recalc; или вынести очередь в Postgres.

Confidence: HIGH
```

---

## DI-013

```
ID: DI-013
Severity: P2
Status: DESIGN RISK
Domain: Finance / Cost

Invariant:
Источник (Deal/CashFlow) и derived (Deal.total, Batch.totalCost) согласованы
после успешной мутации.

Evidence:
createCashFlow L846-864: create затем syncDealInternal.
createDeal L1134-1147: nested create затем sync.
deleteDeal L1198-1205: TX unlink+delete затем sync batches.
updateDeal: TX items затем sync.
import: TX затем sync deals.
Нет общей TX источник+derived.

Current behavior:
Full recompute не двойнит C при повторном sync. Crash/kill после commit CF
и до sync → stale totals до следующей мутации той же сделки.
То же, что REVIEW-010/021, но подтверждено по HEAD после split internal.

Concurrency:
Не обязательна (crash). Параллельные sync двух сделок с общей партией —
last write wins на totalCost (оба recompute, обычно сходятся если оба
увидели одни CF).

Business impact:
Временный неверный C. Хуже вместе с DI-002 (никто не sync'ает).

Detection:
Deal.total vs sumConfirmedExpense; Batch.totalCost vs formula.

Recovery:
Повторный assign/updateDeal.

Minimal fix direction:
sync внутри той же TX что CF/Deal (передать tx в sync*Internal).

Confidence: HIGH
```

---

## DI-014

```
ID: DI-014
Severity: P3
Status: INVARIANT WEAKNESS
Domain: Payroll

Invariant:
Одна ProductionOperation входит не более чем в один Payment.

Evidence:
init PaymentBatchItem: PK id, FK operationId Restrict, без UNIQUE operationId.
Защита только claim isPaid в markEmployeePaid L211-217.

Current behavior:
Текущий path двойную выплату не создаёт. Нет DB-запрета на ручной/будущий
второй insert PaymentBatchItem с тем же operationId, если isPaid обойти.

Concurrency:
Claim делает race безопасным для markEmployeePaid.

Business impact:
Сейчас нет. Страховка схемы отсутствует.

Detection:
GROUP BY operationId HAVING count>1 на PaymentBatchItem.

Recovery:
n/a пока claim держится.

Minimal fix direction:
UNIQUE(operationId) на PaymentBatchItem.

Confidence: HIGH
```

---

## DI-015

```
ID: DI-015
Severity: P3
Status: NEEDS BUSINESS DECISION
Domain: Payroll / Cost

Invariant:
(не зафиксирован в коде как snapshot). v2: сдельщина по расценкам работника.

Evidence:
Нет полей rate на ProductionOperation / Payment кроме Payment.amount.
payroll.ts:185-194 amount из buildRefMaps() = текущие Employee.*Rate.
getSalaryReport: unpaid — live rates; paid — p.amount.
loadCostContext L198-226: labor в с/с изделия тоже текущие ставки,
включая оплаченные ops. FINAL BatchCost — только материал партии.

Current behavior:
Смена ставки после работы:
- невыплаченное начисление в отчёте ЗП меняется;
- уже созданный Payment.amount нет;
- вклад работы в live cost report меняется даже для прошлого.

Concurrency:
Не нужна.

Business impact:
Историческая «начисленная, но не выплаченная» сумма нестабильна.
Полная с/с изделия за период не замораживается вместе с партией.

Detection:
Сравнить Payment.amount с пересчётом тех же ops текущими ставками.

Recovery:
n/a — это семантика.

Minimal fix direction:
Только после решения: snapshot ставки на Op в момент submit, или на Payment
для отчёта; ProductCost closeMonth (A17) если нужна заморозка labor.

Confidence: HIGH
```

---

## DI-016

```
ID: DI-016
Severity: P3
Status: INVARIANT WEAKNESS
Domain: Inventory

Invariant:
Только один Inventory в статусе DRAFT (warehouse.ts:230-231).

Evidence:
Нет unique/partial unique на status. createInventoryDraft: findFirst DRAFT
затем create — не в TX с conduct.

Current behavior:
Sequential второй create бросает. Два параллельных create → два DRAFT.
conduct каждого выставит qty=actual дважды (обычно тот же actual).

Concurrency:
Два параллельных «создать черновик».

Business impact:
Путаница UI; двойное проведение одних actualQty относительно безопасно
(идемпотентный set). Низкий.

Detection:
COUNT(*) WHERE status=DRAFT > 1.

Recovery:
Удалить лишний черновик (delete API нет — через SQL/studio).

Minimal fix direction:
Partial UNIQUE WHERE status='DRAFT' или create в TX с lock.

Confidence: HIGH
```

---

## DI-017

```
ID: DI-017
Severity: P3
Status: INVARIANT WEAKNESS
Domain: Marketplace

Invariant:
MpStock — снимок: одна строка на (marketplace, sku) после sync.

Evidence:
schema MpStock: нет @@unique. sync L613-624 deleteMany + createMany в TX.
Две overlapping sync TX: оба deleteMany (видят committed rows), оба createMany
→ дубли после commit. UI/отчёты могут суммировать или брать произвольную строку.

Current behavior:
Sequential replace корректен. Concurrent — дубли snapshot (не ProductStock).

Concurrency:
Те же два sync, что DI-004.

Business impact:
Неверные остатки МП на экране. Производственный GP — отдельно (DI-004).

Detection:
GROUP BY marketplace, sku HAVING count>1.

Recovery:
Следующий успешный одиночный sync (deleteMany+create) если нет второго concurrent.

Minimal fix direction:
UNIQUE (marketplace, sku); тот же mutex что DI-004.

Confidence: HIGH
```

---

## Явно не баги (для ревью)

| Тема | Почему |
| --- | --- |
| Двойное списание RailLot/Blank/Detail/Nom/GP на terminal+reverse | `updateMany`+`gte` под RC; оба 8 из 10 не проходят |
| TORCOVKA delete не возвращает remainingQuantity | v2:242-245; production.ts:372-381; smoke |
| Sequential retry импорта / supply | findFirst / deductedQty |
| markEmployeePaid двойной клик | claim count mismatch rollback |
| Payment+freeze | один interactive TX |
| PRELIMINARY лагает после torcovka | отчёт live; PRELIMINARY не SoT |
| Freeze только unpaid TORCOVKA | v2:700-702 |
| Unconfirmed в балансе счёта, не в KPI | finance.ts:223-245 намеренно |
| Две вкладки терминала = два id | ключ попытки, не дедуп действия |
| ProductCost пустой | A17 отложено |
