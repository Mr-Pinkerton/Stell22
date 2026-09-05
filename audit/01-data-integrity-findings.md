# Этап 1: Data Integrity findings

HEAD `9b5ed66da36543c3a58d7ab8e392fcd19e78b9c1` (после P1 `199fe2f`). Карта: `audit/01-data-integrity-map.md`. Инварианты: `audit/01-data-integrity-invariants.md`. Freeze/recalc: `audit/01.2-cost-freeze-review.md`.

Только подтверждённые находки с evidence. Не баги: двойное списание реек/деталей на gte-путях; «торцовка не возвращает рейки»; sequential retry импорта/supply; payroll claim; freeze в той же TX что Payment.

**Remediation in progress (code not yet shipped):** DI-005 / DI-006 / DI-018 / DI-019 + BD-3 frozen section/`materialId` + partial UNIQUE FINAL. Historical FINAL vs `totalCost` is **not** auto-rewritten (BD-2). See `audit/01.3-cost-freeze-remediation-plan.md`.

Шкала: P0 массовая порча без восстановления; P1 реальный неверный склад/деньги/ЗП/с/с; P2 слабый invariant / редкий race; P3 долг без текущего нарушения.

**Pass 01.2 (этот файл):** пересмотрены DI-005 / DI-006 (+ DI-018, DI-019). Карточки DI-001/002/003/004/010/013 ниже — снимок фазы 1 на `5479580`; production P1 их закрывал, здесь не переоценивались.

**Pass 01.4:** добавлен DI-020. Production SELECT read-only 2026-09-04. Карточка в этом файле; разбор `audit/01.4-torcovka-input-safety-review.md`.

**Pass 01.6:** переоценен DI-009 (HEAD `931efe8`, production SELECT read-only 2026-09-04). Разбор `audit/01.6-inventory-provenance-review.md`. Гипотеза «ломает provenance» **не подтверждена**.

**Pass 01.6 owner lock (2026-09-04):** BD-9.1=C, BD-9.2 граница, BD-9.5 immutable CONDUCTED, BD-9.6 freeze deviationSum. Не CONFIRMED RACE штатного concurrent conduct. Plan: `audit/01.7-inventory-integrity-remediation-plan.md` (не реализован). Код/schema/tests не менялись.

---

## Сводка

| ID | Sev | Status | Domain | Title |
| --- | --- | --- | --- | --- |
| DI-001 | P1 | CONFIRMED BUG | Cost/Purchases | `updateBatch` меняет `purchaseCost`, не `totalCost` |
| DI-002 | P1 | CONFIRMED BUG | Finance/Cost | `setAccountConfirmed` не пересчитывает Deal/Batch totals |
| DI-003 | P1 | CONFIRMED RACE | Finance | `importKey` не UNIQUE — concurrent import дублирует CashFlow |
| DI-004 | P1 | CONFIRMED RACE | Marketplace | Два sync могут дважды списать ProductStock (в минус) |
| DI-005 | P2 | REMEDIATING | Cost | freeze считает FINAL без Batch lock; concurrent sync пишет C=B |
| DI-006 | P2 | REMEDIATING | Cost | recalc без TX/lock: orphan PRELIMINARY рядом с FINAL |
| DI-007 | P2 | IMPLEMENTED (working tree) | Production | Torcovka: decrement реек до unique insert; retry может вернуть ошибку |
| DI-008 | P2 | IMPLEMENTED (working tree) | Production | `clientRequestId` nullable UNIQUE |
| DI-009 | P1 | CONFIRMED BUG | Inventory | устаревший DRAFT: deviation vs live; historical deviationSum не frozen |
| DI-010 | P2 | DESIGN RISK | Marketplace | skuOzon/skuWb не unique |
| DI-011 | P2 | DESIGN RISK | Marketplace | SHIPPED→PENDING не возвращает ГП (кроме Ozon cancel) |
| DI-012 | P3 | DESIGN RISK | Cost | cost-queue in-memory; CLI recalc/sync в обход |
| DI-013 | P2 | DESIGN RISK | Finance | Deal/CF commit без derived `totalCost` в той же TX |
| DI-014 | P3 | INVARIANT WEAKNESS | Payroll | нет UNIQUE PaymentBatchItem.operationId |
| DI-015 | P3 | NEEDS BUSINESS DECISION | Payroll | ставки live, не snapshot на операции |
| DI-016 | P3 | INVARIANT WEAKNESS | Inventory | два DRAFT при concurrent create |
| DI-017 | P3 | INVARIANT WEAKNESS | Marketplace | MpStock без unique (marketplace,sku) |
| DI-018 | P2 | REMEDIATING | Cost/Payroll | два last TORCOVKA payment → freeze не ставится |
| DI-019 | P2 | REMEDIATING | Cost/Production | update TORCOVKA qty после pay/freeze; FINAL stale |
| DI-020 | P1 | INVARIANT WEAKNESS | Production/Terminal | TORCOVKA принимает неправдоподобный расход без guard |

Pass 01.4: `audit/01.4-torcovka-input-safety-review.md`. DI-021 (per-rail bin-packing) **не открывать**.

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
Reviewed: 01.2 @ HEAD 9b5ed66 (после P1 199fe2f)

Invariant:
После freeze Batch.totalCost и FINAL — одна замороженная C
(finance-operations.ts:151 «Замороженные партии не трогаем»; P1:
money-поля updateBatch запрещены если frozenAt уже set).

Evidence:
P1 закрыл запись C ПОСЛЕ committed frozenAt:
  syncBatchTotalCostInternal L157 FOR UPDATE Batch;
  L159 skip if frozenAt; L182-186 updateMany where { id, frozenAt: null }.
P1 НЕ менял freeze path (internal/cost.ts, payroll.ts нет в 199fe2f):
  maybeFreezeBatch L400 findUnique БЕЗ FOR UPDATE;
  freezeBatch L370 computeBatchSnapshot(in-memory batch) ДО
  L371 batch.update frozenAt.
Тест p1-review-concurrency «freeze || updateBatch» сам делает
SELECT Batch FOR UPDATE — это не maybeFreezeBatch.

Current behavior:
Sequential: sync/updateBatch после freeze не меняют C / money — OK.
Race F1 (01.2): TX F считает FINAL из A до lock строки; TX S (sync /
updateBatch / confirm / import) держит FOR UPDATE, пишет totalCost=B,
коммитит; F ставит frozenAt и FINAL(A). Recalc skip frozen.
Отчёт с/с: FINAL. Закупки «Общая»: B.

Concurrency:
Параллельные: выплата, закрывающая freeze, И мутация C/цен закрытой
партии. Окно = findUnique → UPDATE frozenAt.

Business impact:
У frozen партии «Общая» расходится с замороженным распределением.
B больше не попадает в cost.

Detection:
frozenAt IS NOT NULL AND Batch.totalCost != costSort1+costSort2 FINAL
(с учётом округления distribute).

Recovery:
Сверить, что истина (BD-2 в 01.2): вернуть totalCost к сумме FINAL
или один раз пересчитать FINAL (ломает «заморозка»).

Minimal fix direction:
В maybeFreezeBatch: SELECT Batch FOR UPDATE, затем перечитать C/prices
и ops, затем compute FINAL, затем frozenAt. Не считать из объекта
до lock. Починить тест P1, чтобы звал реальный freeze.

Confidence: HIGH
```

---

## DI-006

```
ID: DI-006
Severity: P2
Status: CONFIRMED RACE
Domain: Cost
Reviewed: 01.2 @ HEAD 9b5ed66

Invariant (намерение freezeBatch, не UI SoT):
После freeze в BatchCost остаётся FINAL; recalc не пишет.
PRELIMINARY — cache, не SoT текущего отчёта.

Evidence:
recalcBatchCosts L340-361: нет $transaction, нет lock, нет recheck
frozenAt на create. deleteMany PRELIMINARY затем create — два statement.
Schema: @@index(batchId) only; unique (batchId,status) нет; FK RESTRICT.
loadCostContext L181: findMany { status: FINAL } only.
Бейдж отчёта: batch.frozenAt, не BatchCost.status (cost-report.ts:385).
Ни один reader не find PRELIMINARY.
cost-queue in-memory; recalcBatchCostsInternal нет; CLI recalc нет.
P1 cost.ts не трогал.

Current behavior:
Несколько PRELIMINARY у открытой партии: queue 1 процесса коалесцирует
один ключ. Не автобаг — UI cache не читает.
Race F2: freeze между findMany/deleteMany и create → PRELIMINARY рядом
с FINAL при frozenAt set. Содержимое PRELIMINARY может быть stale vs
FINAL; отчёт берёт FINAL.

Concurrency:
freeze (payroll/archive TX) vs after-commit enqueue с finance/torcovka.
Два recalc одной партии: 2 процесса или вызов в обход очереди.

Business impact:
Текущий cost UI не врёт из-за orphan PRELIMINARY. Мусор в BatchCost;
сломанный инвариант freeze deleteMany-all; риск будущего reader.

Detection:
PRELIMINARY при Batch.frozenAt IS NOT NULL;
COUNT(*) GROUP BY batchId, status HAVING count>1.

Recovery:
DELETE PRELIMINARY у frozen партий. Для открытых — не обязательно
схлопывать, пока cache не SoT (BD-1).

Minimal fix direction:
delete+create в TX с Batch FOR UPDATE или where frozenAt null на write;
не create если уже frozen. UNIQUE FINAL. UNIQUE PRELIMINARY — только
после BD-1.

Confidence: HIGH
```

---

## DI-007

**Pass 01.10 (2026-09-05):** переоценен на HEAD `16015d5` (после DI-020).
Разбор и полное воспроизведение: `audit/01.10-terminal-idempotency-review.md`.
Production SELECT read-only 2026-09-05. **НЕ fixed, НЕ stale** — DI-020
порядок decrement→create не менял и добавил второй канал нарушения.

**Pass 01.13 (2026-09-05):** owner lock. План `audit/01.13-terminal-idempotency-remediation-plan.md`.
Простой `findUnique` до `lockRailLots` **отклонён** как недостаточный под
concurrent same-id при `remaining === railsTaken`.

**Implementation (working tree, 2026-09-05):** алгоритм 01.13 в `submitTorcovka`
(fast `findUnique` → `lockRailLots` → post-lock `findUnique` → физика;
replay = `IDEMPOTENT_REPLAY`, без enqueue). **Не CLOSED в production:**
миграции на прод не применялись, commit/push/deploy нет.

```
ID: DI-007
Severity: P2
Status: IMPLEMENTED (working tree, not shipped)
Domain: Production / Terminal
Reviewed: 01.10 @ HEAD 16015d5; plan 01.13

Invariant:
Повтор того же clientRequestId после закоммиченного успеха = success, без
побочных эффектов и без повторного запроса подтверждения
(JSDoc terminal.ts:67-71, :339, A21).

Evidence (код, HEAD 16015d5, submitTorcovka terminal.ts:353-479):
Порядок внутри TX:
  :364 lockRailLots FOR UPDATE
  :370-374 длина заготовки <= длины рейки
  :376-379 INV-008 producedM <= takenM
  :381-386 DI-020 decideTorcovkaSubmit → ACK_REQUIRED = ранний return из TX
  :388-392 railLot.updateMany gte → throw «Недостаточно реек в пакете»
  :394-416 productionOperation.create ← ЕДИНСТВЕННОЕ место, где сработает UNIQUE
  :434-451 blankStock.upsert; :454-461 writeChangeLog; :463 archiveBatchIfDepleted
  :465-468 .catch isDuplicateClientRequest (только P2002) → {status:"CREATED"}
Дубль детектируется ПОСЛЕ отказа по остатку (шаг 6) и ПОСЛЕ ack-гейта (шаг 5).
Prisadka :710 / Upakovka :992 создают Op ПЕРВЫМ → P2002 до списания.

Current behavior (воспроизведено локально, PG 17, prod-код без правок):
S1a лот исчерпан: A={status:CREATED} remaining 10→0 ops=1;
    B (тот же id) = ОШИБКА «Недостаточно реек в пакете», ops=1.
S1b лот не исчерпан: A CREATED, B CREATED, ops=1, remaining=20
    (decrement откатан) — идемпотентно.
S1c SUSPICIOUS + валидный ack, лот исчерпан: та же ошибка. Ack не помогает.
S1d НОВЫЙ КАНАЛ (от DI-020): после успеха с ack тот же id БЕЗ ack →
    {status:"ACK_REQUIRED"}, не success. Возврат до шагов 6-7.
S7 истинная гонка одного id (остаток есть): [CREATED, CREATED], ops=1,
    remaining=20, blankQty=19, logs=1 — контракт держится.
Порчи данных нет НИ В ОДНОМ пути: ops/lines/BlankStock/ChangeLog по одному разу.
Двойной ChangeLog НЕТ (writeChangeLog в TX, откат).
Двойной enqueue себестоимости ДА на идемпотентном пути (:472 выполняется) —
  безвреден, cost-queue коалесцирует по ключу партии, FINAL не трогается.
Двойной close/freeze НЕТ: archiveBatchIfDepleted в TX + идемпотентен
  (internal/cost.ts:436 if (preBatch.closedAt) return false).

Concurrency:
Не нужна. Sequential retry после committed success на том же id.

Business impact:
Оператор видит «Недостаточно реек» для успешно записанной операции. Реакция —
новая вкладка (новый id) и повтор: либо снова отказ, либо лишняя операция по
другому лоту. Тот же класс путаницы, что инцидент DI-020. Silent double stock
НЕТ.

Production exposure:
0 живых ProductionOperation. Но лот ПАК-40-1280-01-7 remainingQuantity=0 при
quantity=1280 — ровно конфигурация S1a, т.е. путь реально достижим.

Detection:
Op с этим clientRequestId существует, клиент получил ошибку остатка или
повторный ACK_REQUIRED.

Recovery:
Не требуется (qty и деньги корректны).

Implemented fix (working tree, not shipped):
В TX: fast findUnique(clientRequestId) → lockRailLots (канон) →
findUnique ЕЩЁ РАЗ под локом → только потом физика / INV-008 / DI-020 /
stock / create. Replay → IDEMPOTENT_REPLAY: без склада, ChangeLog,
archive, enqueue. Публичный UI-контракт остаётся {status:"CREATED"}.
UNIQUE — финальная страховка. Пороги DI-020 и порядок RailLot-лока не менять.

Confidence: HIGH
```

---

## DI-008

**Pass 01.10 (2026-09-05):** переоценен на HEAD `16015d5`. Разбор:
`audit/01.10-terminal-idempotency-review.md`. Production SELECT read-only
2026-09-05. **НЕ fixed, НЕ stale.** Достижимо прямым вызовом Server Action и
internal-вызовами; штатным терминальным UI — НЕТ (трассировка всех 4 экранов).

**Pass 01.13 (2026-09-05):** owner = **C** (app required + DB NOT NULL + UNIQUE).
План `audit/01.13-terminal-idempotency-remediation-plan.md`. Backfill запрещён.
NULL перед migrate → STOP.

**Implementation (working tree, 2026-09-05):** app `requireClientRequestId` на
четырёх submit; schema `String @unique` (NOT NULL); миграция
`20260905170000_production_operation_client_request_id_not_null` (LOCK +
recheck + SET NOT NULL, без backfill). **Не CLOSED в production.**

```
ID: DI-008
Severity: P2
Status: IMPLEMENTED (working tree, not shipped)
Domain: Production / Terminal
Reviewed: 01.10 @ HEAD 16015d5; plan 01.13 owner C

Invariant:
Дубль терминальной попытки не создаёт две ProductionOperation.

Evidence (HEAD 16015d5):
schema.prisma:355 clientRequestId String? @unique — nullable.
migration 20260713161800: ALTER TABLE ADD COLUMN TEXT + CREATE UNIQUE INDEX.
Production (SELECT 2026-09-05): pg_attribute.attnotnull = 'f';
  индекс ProductionOperation_clientRequestId_key = полный btree UNIQUE,
  НЕ partial, БЕЗ NULLS NOT DISTINCT → любое число NULL допустимо.
Обязательности нет НИ НА ОДНОМ слое:
  TS-вход: TorcovkaInput:340, PrisadkaInput:486, UpakovkaInput:742 — optional;
    submitHours:1030 — optional позиционный;
  validation: схемы нет вообще — ни одной проверки clientRequestId
    в :355-361, :699-702, :984-987, :1033-1034;
  Prisma: String? @unique;
  прямой вызов Server Action: payload контролируется вызывающим.
Все 4 создателя ProductionOperation — только terminal.ts (:394, :710, :992,
  :1038). Admin/internal действия операции НЕ создают (production.ts —
  только update/delete/correct). Публичных HTTP-путей записи нет
  (src/app/api = cron/fetch-statements + health).
Hours: create без TX (:1038), writeChangeLog после (:1045).

Достижимость (01.10 §4.2):
A. штатный терминальный UI без ключа — НЕТ. Все 4 экрана: useRef(newRequestId())
   при монтировании и передача в каждом вызове (torcovka-screen:76/:151/:190,
   prisadka-screen:81/:93, upakovka-screen:58/:71, hours-screen:21/:29).
   Ротация id только при success → ключ = попытка.
B. прямой вызов Server Action — ДА (нужна валидная терминальная cookie).
C. старый/устаревший клиент — практически нет: в деплое HEAD такого пути нет,
   Server Action ID в Next 16 привязан к билду. Гипотетический канал.
D. скрипты/тесты/internal — ДА, уже опускают: prisma/seed.ts:319,354,429,493
   (dev seed, на prod не запускается); di-009.integrity.test.ts:371,392,436,
   497,842,879.
E. иного публичного/терминального API записи НЕТ.

Current behavior (воспроизведено локально, PG 17, prod-код без правок):
S4a TORCOVKA 2× без id  → ops=2, remaining 30→20→10, blankQty 19→38, logs=2
S4b PRISADKA 2× без id  → ops=2, blank 10→6→2, detail 0→4→8, logs=2
S4c UPAKOVKA 2× без id  → ops=2, blank 10→6→2, ГП 0→2→4, logs=2
S4d HOURS 2× без id     → ops=2; затем 2× с одним id → +1 (идемпотентно)
S5a TORCOVKA конкурентно без id → ops=2, blankQty=38
S5b HOURS конкурентно: без id ops=2; с одним id +1
Реальные последствия по типам:
  дубль Op         — TORCOVKA/PRISADKA/UPAKOVKA/HOURS: ДА
  дубль склада     — TORCOVKA/PRISADKA/UPAKOVKA: ДА; HOURS: n/a
  дубль ЗП         — все четыре: ДА
  дубль Batch state— TORCOVKA косвенно (второй decrement → archiveBatchIfDepleted)
  безвредный no-op — нигде
В минус не уходит: везде updateMany … gte; двойное списание только когда
остатка физически хватает.

Побочно (карточка НЕ открывается, закрывается в 01.13 вместе с DI-008):
submitUpakovka с ключом и ДВУМЯ picks одного productId → success, но ops=0
и склад не изменён. Из UI недостижимо. План: валидация уникальных productId
до TX, не UNIQUE `${id}:${productId}`.

Concurrency:
Не нужна. Без id достаточно sequential double submit.

Business impact:
Двойные ops → двойная ЗП и двойной расход склада при достаточном остатке.
Для штатного UI недостижимо; контракт «дубль попытки не создаёт две операции»
не обеспечен для любого не-UI вызова.

Production exposure: 0.
0 живых ProductionOperation; NULL clientRequestId = 0; дублей non-null = 0;
UNIQUE-индекс здоров. Исторические 3 TORCOVKA (2026-09-01/02/04) удалены
физически; наличие ключа по ChangeLog не восстанавливается (ключ там не
пишется), но все три созданы штатным UI много позже миграции 2026-07-13.
Исторические NULL как corruption НЕ утверждать — таких строк нет.

Detection:
SELECT ... WHERE "clientRequestId" IS NULL — сейчас 0;
ops без ключа в одно время со схожим qty.

Recovery:
Админ delete до выплаты (если gte reverse проходит).

Implemented fix (working tree, not shipped):
Приложение: requireClientRequestId после auth на всех 4 submit
(string, trim не пустой, ≤128). БД: ALTER COLUMN SET NOT NULL, UNIQUE
индекс ProductionOperation_clientRequestId_key не пересоздавать.
Миграция: LOCK TABLE + recheck NULL + RAISE (печать id/type/employeeId/
workDate/createdAt). NO UPDATE, NO backfill, NO delete.
Preflight: NULL count > 0 → STOP.
Seed/integrity callers получают детерминированные seed:/test: id.
UPakovka dup productId — отдельная валидация до TX.

Owner decision: C. Открытых нет.

Confidence: HIGH
```

---

## DI-009

**Pass 01.6 evidence:** `audit/01.6-inventory-provenance-review.md`. **Owner lock 2026-09-04.** Plan (не код): `audit/01.7-inventory-integrity-remediation-plan.md`.

```
ID: DI-009
Severity: P1
Status: CONFIRMED BUG
Domain: Inventory / Production

MAIN INVARIANT:
После успешного conductInventory:
  live quantity каждой покрытой позиции == accountedQty на момент guard
    (иначе TX abort, ноль writes);
  stock.quantity = actualQty (абсолютный SET);
  InventoryLine.deviation = actualQty - accountedQty;
  InventoryLine.deviationSum заморожен (Decimal);
  Inventory.date = время проведения;
  документ CONDUCTED immutable;
  reverse/delete операции с createdAt < Inventory.date
    не меняет stock, если CONDUCTED InventoryLine покрывала этот ref.

НЕ штатный процесс: conduct || production/purchase/marketplace.
Не классифицировать как CONFIRMED RACE этого потока.
Приложение обязано защищать snapshot guard'ом.

CONFIRMED BUG:
- deviation/deviationSum считаются от accountedQty черновика без сверки live
  (warehouse.ts:326 vs абсолютный SET :335/341/364/390).
- serializeDoc не отдаёт сохранённый deviationSum; UI истории считает
  live unitCost текущего месяца (warehouse-inventory-tab.tsx:320-323).

INVARIANT WEAKNESS:
- нет live == accountedQty внутри TX;
- устаревший DRAFT проводится;
- status DRAFT проверяется вне TX; update by id без status (warehouse.ts:317, :402);
- reverse старой операции может пересечь CONDUCTED boundary (75+20=95);
- Inventory.date = создание DRAFT, не conduct.

EXPECTED / INTENTIONAL:
- absolute SET к физическому факту;
- depersonalized ProductStock / NomenclatureStock / DetailStock / BlankStock;
- нет lot/FIFO provenance;
- RailLot вне инвентаризации.

SPEC DRIFT:
- Math.round(deviation * unitCost * 100) / 100 вместо Decimal.

DEFERRED:
- DI-016 два DRAFT (не в scope);
- BD-9.3 НЗП/заготовки;
- BD-9.7 CashFlow «Потеря ГП»;
- explicit counted-line UX (prefill actual=accounted).

OWNER:
- BD-9.1 = C (abort если live != accountedQty);
- BD-9.2 = граница, точечный блок reverse по покрытому ref;
- BD-9.5 = CONDUCTED не undo;
- BD-9.6 = freeze deviationSum, Decimal;
- date at conduct = now(); historical prod не переписывать.

Evidence (код, HEAD 931efe8):
warehouse.ts:228-283 createInventoryDraft accountedQty = live at t0
warehouse.ts:313-422 conduct: valuation и status вне TX; SET actualQty;
  ChangeLog только {status, lines:N}
production-reversal.ts reverse: gte вниз, increment вверх, без inventory
schema: нет UNIQUE DRAFT; нет applied* колонок; InventoryLine.refId без FK

Production (SELECT 2026-09-04): 1 Inventory CONDUCTED, 0 InventoryLine.
Exposure = 0. Историческую corruption НЕ утверждать.

Minimal fix: 01.7 — без schema/migration.

Confidence: HIGH
```

Не открывать ledger/FIFO/event sourcing. Не реализовывать, пока нет «implement».

Смежное, карточка не открыта (01.6 §9.5): `InventoryLine.refId` без FK + `deleteDetail`.

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
Severity: P2  (повышено с P3 — audit/01.8, 2026-09-05)
Status: CONFIRMED RACE + INVARIANT WEAKNESS + CONFIRMED BUG (узкий)
Domain: Inventory

Полный разбор: audit/01.8-inventory-draft-uniqueness-review.md
План ремедиации: audit/01.9-inventory-draft-uniqueness-remediation-plan.md
Базовый commit: 1f411e5e0f8018069e9f91d69439ff306fdc2572 (DI-009 deployed)

Invariant:
INV-068 — одновременно существует максимум один Inventory со status=DRAFT.
Scope: GLOBAL (в модели Inventory нет ни одного scope-поля).
Подтверждён как намеренный: явный отказ createInventoryDraft:246-247,
UI рендерит ровно один DRAFT (find/filter, warehouse-inventory-tab.tsx:74,76),
решение владельца «инвентаризация = единая физическая сверка склада».

Evidence:
DB-гарантии нет. createInventoryDraft (warehouse.ts:244-299):
findFirst({status:"DRAFT"}) :246 и inventory.create :275 — два запроса
в РАЗНЫХ транзакциях, без lock, без advisory lock, без DB-unique.
Окно гонки = время getWarehouseStock() :249 (десятки–сотни мс).
Production (SELECT read-only 2026-09-05): индексы только Inventory_pkey /
InventoryLine_pkey — partial UNIQUE отсутствует.

Локальное воспроизведение (PostgreSQL 17, stell22_integrity, фикстура удалена):
  A) обычный Promise.all двух createInventoryDraft → DRAFT count = 2,
     обе TX success, ошибок PostgreSQL нет. Барьер НЕ требуется.
  B) два PrismaClient + барьер: оба видят NONE, оба INSERT → 2 DRAFT.
  C) conduct A с отклонением (100→95), затем conduct B → STALE_SNAPSHOT,
     zero writes, склад 95, B остаётся DRAFT. DI-009 остаток защищает.
  D) conduct A БЕЗ отклонения (100→100), затем conduct B (actual 60) →
     B ПРОВОДИТСЯ, склад 60. DI-009 этот путь НЕ перекрывает.
  E) после C: createInventoryDraft → «Черновик инвентаризации уже
     существует». Итог CONDUCTED 1 / DRAFT 1 — lockout.
  F,G) partial UNIQUE ON "Inventory" (status) WHERE status='DRAFT'
     создаётся; второй INSERT → P2002 target=status; под индексом
     конкурентная вставка с двух соединений → ровно 1 DRAFT.

Current behavior:
Sequential второй create бросает. Два параллельных create → два DRAFT.
Второй DRAFT после проведения первого почти всегда непроводим
(STALE_SNAPSHOT), и исправить его нельзя: accountedQty пишется только
в createInventoryDraft:283; updateInventoryLineActual меняет только
actualQty; writer'ов delete/cancel/close/refresh DRAFT НЕ существует.

Concurrency:
createInventoryDraft || createInventoryDraft. Достижимо штатным UI:
два входа (warehouse-view.tsx:181, warehouse-inventory-tab.tsx:122)
защищены только клиентским pending, т.е. в пределах одной вкладки.

Business impact:
ПЕРЕСМОТРЕНО. Не «низкий» и не идемпотентный повтор.
1) Основное — denial of function: застрявший DRAFT навсегда блокирует
   создание новых инвентаризаций, выхода из UI нет (SQL на проде).
2) Узкая порча: при нулевом отклонении первого документа второй делает
   независимый абсолютный SET того же физического факта (опыт D).
3) Потеря черновика из UI: второй DRAFT не попадает ни в один список.
НЕ затронуто: inventory boundary DI-009 (фильтрует status='CONDUCTED'),
отрицательные остатки, freeze deviationSum.

Production exposure: 0.
1 Inventory всего (CONDUCTED, 0 строк), 0 DRAFT, 0 InventoryLine.
ChangeLog: 1 create-event DRAFT, 1 conduct, 1 distinct entityId.
Дубликатов DRAFT не существовало никогда. Историческую порчу не утверждать.

Detection:
SELECT count(*) FROM "Inventory" WHERE status = 'DRAFT';  -- > 1

Recovery:
Ручной SQL/Studio: сначала InventoryLine (FK onDelete не задан →
Restrict), затем Inventory. Application-пути нет.

Owner decisions — ФИНАЛЬНЫ (2026-09-05):
  BD-16.1  Максимум одна ГЛОБАЛЬНАЯ Inventory со status=DRAFT.
  BD-16.2  Инвариант — на уровне БД (partial UNIQUE). findFirst остаётся
           только дружелюбной предпроверкой. Проигравший в гонке получает
           существующее доменное сообщение, не сырой P2002.
  BD-16.3  Админ может УДАЛИТЬ DRAFT. Удаление трогает только Inventory +
           её InventoryLine. НЕ мутирует ProductStock / DetailStock /
           BlankStock / NomenclatureStock / RailLot, НЕ создаёт корректировку,
           НЕ трогает production-операции и исторические CONDUCTED.
  BD-16.4  CONDUCTED immutable: нельзя удалить/отменить/переоткрыть/
           обновить/превратить в DRAFT.
  BD-16.5  STALE_SNAPSHOT DRAFT НЕ обновляется. accountedQty не
           перезаписывается. Пользователь удаляет устаревший DRAFT и
           создаёт новую инвентаризацию.
           Вариант «refresh accountedQty» ОТКЛОНЁН.
  Owner decisions открытых НЕТ.

Minimal fix direction (утверждено, план — audit/01.9):
1) Миграция: partial UNIQUE
     CREATE UNIQUE INDEX "Inventory_status_draft_key"
       ON "Inventory" ("status") WHERE "status" = 'DRAFT';
   в стиле DI-003/DI-005/DI-010: BEGIN + LOCK TABLE "Inventory" IN ACCESS
   EXCLUSIVE MODE + DO/RAISE при count(DRAFT)>1 (печать id/status/createdAt/
   date/line count) + CREATE INDEX + COMMIT. Без CONCURRENTLY, без
   auto-delete, без auto-conduct, без выбора «победителя».
   Prisma @@unique НЕ добавляется (частичное условие не выражается) —
   только комментарий в schema.prisma, как у Account.accountNumber.
   PostgreSQL нормализует предикат до
     WHERE (status = 'DRAFT'::"InventoryStatus")   [проверено, PG 17]
2) createInventoryDraft: findFirst-предпроверку оставить; try/catch ровно
   вокруг ОДНОЙ вставки inventory.create; матчер
     code==="P2002" && meta.modelName==="Inventory"
       && Array.isArray(meta.target) && meta.target.includes("status")
   [проверено: meta = {"modelName":"Inventory","target":["status"]};
    посторонний P2002 DI-010 = {"modelName":"Product","target":["skuOzon"]}
    → не совпадает] → бросить существующее
   «Черновик инвентаризации уже существует» (константа DRAFT_ALREADY_EXISTS
   в inventory-integrity.ts, аддитивно).
3) deleteInventoryDraft (новое ADMIN_ACTION): requireAdmin первым
   statement → $transaction → lockInventoryForUpdate (тот же мьютекс, что у
   conduct/updateActual) → not found «Инвентаризация не найдена» →
   status!==DRAFT → ALREADY_CONDUCTED → inventoryLine.deleteMany →
   inventory.delete → writeChangeLog в TX → commit → revalidatePath.
   Явный deleteMany ОБЯЗАТЕЛЕН: FK ON DELETE RESTRICT
   [pg_constraint.confdeltype='r' проверено; inventory.delete при живых
   строках даёт P2003 InventoryLine_inventoryId_fkey]. Stock-локи не нужны.
   ChangeLog: entity Inventory, oldValues {status:"DRAFT", lines:N},
   newValues отсутствует (=null) — конвенция deleteBatch. Без per-line логов,
   без фиктивной записи корректировки склада.
4) Preflight scripts/preflight-prod.sh: count DRAFT > 1 → STOP,
   печать id/status/createdAt/date/line count. NO auto delete/conduct.
   0 или 1 → PASS.
5) Security: +1 в ADMIN_ACTION (102→103) и обязательная правка захардкоженного
   export freeze в check-server-action-source.mjs (126→127) — иначе
   npm run security:actions падает. Terminal/public доступа нет.

Отклонены: app-level TX/lock (без LOCK TABLE некорректно — конфликтующей
строки не существует, SERIALIZABLE не даёт predicate-конфликта),
advisory/sentinel lock (новый примитив, риск deadlock с conduct),
DB-unique без обработки P2002 (сырая техническая ошибка в UI).

Конкурентные исходы (доказаны, audit/01.9 §6):
  create||create      → ровно один DRAFT, проигравший — доменное сообщение
  delete||conduct     → один мьютекс Inventory; либо CONDUCTED + delete
                        ALREADY_CONDUCTED, либо документа нет + conduct
                        «не найдена». Частичных записей в stock нет
  delete||updateActual→ либо update, затем полное удаление; либо delete,
                        затем reject. Осиротевших InventoryLine нет
  delete||create      → INSERT ждёт xid удаляющей TX; deleter commit →
                        insert успешен; deleter rollback → insert P2002 →
                        доменное сообщение. В обоих случаях DRAFT <= 1
                        [проверено на PG 17]

Остаётся вне DI-016 (отдельная возможная карточка, fix не проектируется):
getWarehouseStock() в createInventoryDraft читает вне TX → conduct,
закоммиченный посреди этого чтения, даёт порванный snapshot →
гарантированный STALE_SNAPSHOT. Partial UNIQUE это не закрывает, НО
BD-16.3/16.5 устраняют последствие: такой черновик удаляется из UI и
создаётся заново. Тупик «нет выхода из UI» закрыт.

Security: проблем нет. requireAdmin первым statement во всех четырёх
существующих inventory-действиях; все в ADMIN_ACTION; terminal/public write
paths нет. Новое deleteInventoryDraft — тоже ADMIN_ACTION с requireAdmin
первым statement (ADMIN_ACTION 102→103, export freeze 126→127).

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

## DI-018

```
ID: DI-018
Severity: P2
Status: CONFIRMED RACE
Domain: Cost / Payroll
Reviewed: 01.2 @ HEAD 9b5ed66

Invariant:
Закрытая партия (closedAt) с unpaid TORCOVKA = 0 должна получить
frozenAt + FINAL (canFreezeBatch; payroll.ts:234-237).

Evidence:
maybeFreezeBatch L402-404: count isPaid:false TORCOVKA без lock всех
ops партии и без Batch FOR UPDATE.
markEmployeePaid вызывает maybeFreeze только для batchId TORCOVKA
этой выплаты.
archiveBatchIfDepleted L417: если closedAt уже set → return, freeze нет.
Других callers maybeFreezeBatch нет.

Current behavior:
Sequential: последняя выплата TORCOVKA видит count=0 → freeze. OK.
Race F3: две параллельные выплаты последних T1 и T2. Каждая claim
свои ops; каждая count ещё видит чужие unpaid (RC) → обе skip freeze.
После commit: все TORCOVKA paid, frozenAt=null, FINAL нет. Повторного
прохода нет.

Concurrency:
Два markEmployeePaid разных сотрудников по последним TORCOVKA одной
уже закрытой партии.

Business impact:
Партия навсегда «предварительная»: C/цены ещё редактируются; отчёт
live, не FINAL. Редко.

Detection:
closedAt IS NOT NULL AND frozenAt IS NULL AND unpaid TORCOVKA count=0.

Recovery:
Ручной повтор maybeFreeze (сейчас нет UI) или SQL frozenAt+FINAL.

Minimal fix direction:
Тот же Batch FOR UPDATE до count unpaid (сериализация выплат по партии).

Confidence: HIGH
```

---

## DI-019

```
ID: DI-019
Severity: P2
Status: CONFIRMED RACE
Domain: Cost / Production
Reviewed: 01.2b @ HEAD 9b5ed66

Invariant:
После выплаты TORCOVKA (и freeze FINAL) факт lines не меняется.
FINAL считается из TORCOVKA lines (freezeBatch / distribute).

Evidence:
updateProductionLineQuantity L210-215 isPaid check ВНЕ TX.
TORCOVKA TX L306-362: BlankStock ±; operationDetailLine.update qty.
Нет lock ProductionOperation. Нет where isPaid=false.
deleteProductionOperation L390-395 isPaid вне TX; L436 delete({ id })
без isPaid. PaymentBatchItem.operationId ON DELETE RESTRICT (init L609).
OperationDetailLine.operationId ON DELETE RESTRICT (init L555) —
lines удаляют до Op, это не про Payment.
Parent UPDATE isPaid не блокирует child quantity UPDATE.

Current behavior:
UPDATE: sequential isPaid=true → throw до TX. Concurrent pay+freeze
затем (или во время) update qty → COMMIT. Recalc skip frozen.
DELETE: после committed Payment delete Op → P2003 RESTRICT → rollback
stock. Заявленный «delete after freeze» end-state не достигается.

Concurrency:
markEmployeePaid (последние TORCOVKA закрытой партии) || admin
правка qty той же TORCOVKA.

Business impact:
FINAL и склад/lines расходятся. Отчёт с/с заморожен; факт производства
и отход live. ЗП уже по старым qty (amount до TX payroll).

Detection:
frozenAt IS NOT NULL AND SUM(TORCOVKA line qty/volume) != FINAL volumes
(через сечение). ChangeLog ProductionOperation после Batch.frozenAt.

Recovery:
Не auto-fix FINAL (BD-2). Вернуть lines к FINAL или принять drift
вручную. Stock выровнять инвентаризацией осторожно.

Minimal fix direction:
В TX: lock ProductionOperation WHERE id AND isPaid=false FIRST,
потом stock/line. Тот же каркас на delete (defense; FK уже стопит).
Lock order: Op → (optional Batch) → stock. Не Batch затем Op.

Confidence: HIGH
```

---

## DI-020

```
ID: DI-020
Severity: P1
Status: INVARIANT WEAKNESS
         (+ DESIGN RISK по UX копи; + NEEDS BUSINESS DECISION по порогам
            и correction workflow)
Domain: Production / Terminal / Cost / Inventory
Reviewed: 01.4 @ HEAD cc571f5, production SELECT 2026-09-04 read-only

Invariant (отсутствует):
Система не отличает физически правдоподобный расход реек от очевидной
ошибки ввода. Нет верхней границы wastePct на submit. Нет сценария
«исправить ошибочный railsTaken» с возвратом remainingQuantity.

Waste model (owner 2026-09-04):
Агрегат операции: railsTaken × lengthM vs Σ длин заготовок.
Не раскрой каждой рейки. DI-021 / bin-packing не открывать.
Минимум физики: заготовка ≤ длина рейки лота; Σ выход ≤ Σ взятых (INV-008).

Evidence (code):
torcovka-screen.tsx: «Сколько реек взято?», hint «Доступно N шт»,
  confirm bar без %; destructive только при overLength
terminal.ts:submitTorcovka — INV-008, gte remaining, нет max waste
production.ts:update — railsTaken immutable
production.ts:delete TORCOVKA — remaining не возвращается (INV-047)
src/ нет increment remainingQuantity

Evidence (production, READ ONLY, 2026-09-04):
Live ProductionOperation TORCOVKA N=0 (все 3 ops deleted).
ChangeLog reconstruction N=3, all later_deleted:
  5.21% (410/1280 пакета), 6.95% (420/1280), 72.98% (1280/1280 весь пакет).
Incident-like: cmtmj4dpi000srp29ek0iw37f ПАК-40-1280-01-7
  railsTaken=1280=lot_qty, taken_m=5120, produced_m=1383.48, waste_pct=72.98
  deleted 9 min later; remaining still 0.
Память «~97%» с этой строкой не совпадает; класс тот же.
P75/P90/P95 на N=3 непригодны (квантиль = инцидент).

Current behavior:
Любая пара (railsTaken ≤ remaining, producedM ≤ takenM, producedM > 0)
принимается. 73% и 97% внутренне согласованы с вводом.

Failure scenario (prod, already happened):
1. Пакет 1280 реек, hint «Доступно 1280 шт».
2. Ввод railsTaken=1280 вместо фактически взятых.
3. Небольшой выход относительно takenM (1383 м из 5120 м).
4. Submit ок. Delete не возвращает рейки.

Concurrency: не нужна. Sequential intended path.

Business impact:
Неверный склад реек. Завышенный % отхода и ₽/м³. ЗП по заготовкам.
Не data corruption «сама по себе»: цифры применены как введены.

Detection:
wastePct операции ≫ нормы; railsTaken = lot.quantity при малом producedM;
remaining=0 при физическом наличии реек.

Recovery:
Штатного пути нет. Delete не возвращает рейки. Нужен отдельный
corrective workflow (01.4 §8 CASE A). Ops в этом pass не чинить.

Proposed guard bands (01.4 §7.5, не wasteThresholdPct=30):
NORMAL < 20%; SUSPICIOUS 20–50% (повторный confirm); EXTREME ≥ 50%
(только поток высокого отхода / брак).

Minimal fix direction:
1) plausibility guard терминал+сервер (агрегат %, не bin-pack);
2) «исправить ошибочный ввод» (снизить railsTaken, вернуть remaining);
3) не менять обычный delete TORCOVKA.

Confidence: HIGH
```

---

## Явно не баги (для ревью)

| Тема | Почему |
| --- | --- |
| Двойное списание RailLot/Blank/Detail/Nom/GP на terminal+reverse | `updateMany`+`gte` под RC; оба 8 из 10 не проходят |
| TORCOVKA delete не возвращает remainingQuantity | v2:242-245; production.ts:372-381; smoke; prod 01.4: remaining ПАК-40-1280-01-7 всё ещё 0 после delete |
| Per-rail cutting / bin-packing (не DI-021) | владелец 2026-09-04: отход агрегатный по операции |
| Sequential retry импорта / supply | findFirst / deductedQty |
| markEmployeePaid двойной клик | claim count mismatch rollback |
| Payment+freeze | один interactive TX |
| Delete TORCOVKA после committed Payment | `PaymentBatchItem.operationId` ON DELETE RESTRICT; не DI-019 end-state |
| PRELIMINARY лагает после torcovka | отчёт live; PRELIMINARY не SoT |
| Несколько PRELIMINARY у открытой партии | cache, UI не читает; не автобаг (BD-1 в 01.2) |
| Freeze только unpaid TORCOVKA | v2:700-702 |
| Unconfirmed в балансе счёта, не в KPI | finance.ts:223-245 намеренно |
| Две вкладки терминала = два id | ключ попытки, не дедуп действия |
| ProductCost пустой | A17 отложено |
