# Этап 1: Data Integrity findings

**Normalization base:** `4809c0cfdce11ada8563d6c6d8cb7f7069c90c85`.
**Production runtime verified during normalization:** `060629eaeb91dafdd2b0484d165ea695a949f6f4`.

Карта: `audit/01-data-integrity-map.md`. Инварианты: `audit/01-data-integrity-invariants.md`. Freeze/recalc: `audit/01.2-cost-freeze-review.md`.

Только подтверждённые находки с evidence. Не баги: двойное списание реек/деталей на gte-путях; «торцовка не возвращает рейки»; sequential retry импорта/supply; payroll claim; freeze в той же TX что Payment.

**Production status verified 2026-09-06.** Remaining not closed: DI-011 / DI-017 **DEFERRED BY OWNER**; DI-012 **DESIGN RISK**. Marketplace was not re-audited in this pass.

Шкала: P0 массовая порча без восстановления; P1 реальный неверный склад/деньги/ЗП/с/с; P2 слабый invariant / редкий race; P3 долг без текущего нарушения.

**Pass notes (historical evidence files, not current status):**
- **01.2:** DI-005 / DI-006 / DI-018 / DI-019 reviewed @ `9b5ed66`; remediation `audit/01.3-cost-freeze-remediation-plan.md`.
- **01.4:** DI-020 added; `audit/01.4-torcovka-input-safety-review.md`.
- **01.6:** DI-009 re-audit @ `931efe8`; `audit/01.6-inventory-provenance-review.md`. Plan `audit/01.7-inventory-integrity-remediation-plan.md` later shipped in `1f411e5`.
- **01.18:** DI-014 **CLOSED IN PRODUCTION** @ `060629e`. Разбор `audit/01.18-payment-operation-uniqueness-review.md`. Deploy `33992508139`. Migration `20260905220000_payment_batch_item_operation_unique`.

**Marketplace (owner, 2026-09-05):** DI-011 / DI-017 **DEFERRED BY OWNER** — marketplace subsystem is currently low priority and may be redesigned rather than incrementally hardened. Not FIXED, not CLOSED. DI-004 / DI-010 were **not** deferred; P1 closed them in production (see cards).

---

## Сводка

| ID | Sev | Status | Domain | Title |
| --- | --- | --- | --- | --- |
| DI-001 | P1 | CLOSED IN PRODUCTION | Cost/Purchases | `updateBatch` меняет `purchaseCost`, не `totalCost` |
| DI-002 | P1 | CLOSED IN PRODUCTION | Finance/Cost | `setAccountConfirmed` не пересчитывает Deal/Batch totals |
| DI-003 | P1 | CLOSED IN PRODUCTION | Finance | `importKey` не UNIQUE — concurrent import дублирует CashFlow |
| DI-004 | P1 | CLOSED IN PRODUCTION | Marketplace | Два sync могут дважды списать ProductStock (в минус) |
| DI-005 | P2 | CLOSED IN PRODUCTION | Cost | freeze считает FINAL без Batch lock; concurrent sync пишет C=B |
| DI-006 | P2 | CLOSED IN PRODUCTION | Cost | recalc без TX/lock: orphan PRELIMINARY рядом с FINAL |
| DI-007 | P2 | CLOSED IN PRODUCTION | Production | Torcovka: decrement реек до unique insert; retry может вернуть ошибку |
| DI-008 | P2 | CLOSED IN PRODUCTION | Production | `clientRequestId` nullable UNIQUE |
| DI-009 | P1 | CLOSED IN PRODUCTION | Inventory | устаревший DRAFT: deviation vs live; historical deviationSum не frozen |
| DI-010 | P2 | CLOSED IN PRODUCTION | Marketplace | skuOzon/skuWb не unique |
| DI-011 | P2 | DEFERRED BY OWNER | Marketplace | SHIPPED→PENDING не возвращает ГП (кроме Ozon cancel) |
| DI-012 | P3 | DESIGN RISK | Cost | cost-queue in-memory; CLI recalc/sync в обход |
| DI-013 | P2 | CLOSED IN PRODUCTION | Finance | Deal/CF commit без derived `totalCost` в той же TX |
| DI-014 | P3 | CLOSED IN PRODUCTION | Payroll | UNIQUE PaymentBatchItem.operationId (was: нет UNIQUE) |
| DI-015 | P3 | CLOSED IN PRODUCTION | Payroll | ставки live, не snapshot на операции |
| DI-016 | P2 | CLOSED IN PRODUCTION | Inventory | два DRAFT при concurrent create |
| DI-017 | P3 | DEFERRED BY OWNER | Marketplace | MpStock без unique (marketplace,sku) |
| DI-018 | P2 | CLOSED IN PRODUCTION | Cost/Payroll | два last TORCOVKA payment → freeze не ставится |
| DI-019 | P2 | CLOSED IN PRODUCTION | Cost/Production | update TORCOVKA qty после pay/freeze; FINAL stale |
| DI-020 | P1 | CLOSED IN PRODUCTION | Production/Terminal | TORCOVKA принимает неправдоподобный расход без guard |

Pass 01.4: `audit/01.4-torcovka-input-safety-review.md`. DI-021 (per-rail bin-packing) **не открывать**.

---

## DI-001

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `199fe2f283a9685bce889e71c95fd32faedc61f6` (`fix: harden P1 data integrity`)
- Migration: none
- Deploy evidence: GitHub Actions run `33875705448` SUCCESS (2026-09-04), SHA `199fe2f`. Still present in production `060629e`.
- What changed: `updateBatch` locks Deal→Batch, forbids frozen money/section/`materialId` edits, then `syncDealInternal` / `syncBatchTotalCostInternal` in the same TX so `totalCost` follows `purchaseCost`.
- Historical corruption: none observed / not asserted.

```
ID: DI-001
Severity: P1
Status: CLOSED IN PRODUCTION
Domain: Cost / Purchases
Reviewed: phase 1 @ 5479580; closed P1 199fe2f / prod 060629e

Invariant:
Batch.totalCost = purchaseCost + доля доставки из подтверждённых ДДС сделок
(v2: C = закупка + доставка). createBatch выставляет totalCost = purchaseCost.

Historical evidence (фаза 1 @ 5479580; line numbers of that SHA):
src/server/purchases.ts:createBatch L253 (init totalCost)
src/server/purchases.ts:updateBatch L301-324 — пишет purchaseCost, prices, section;
  НЕ пишет totalCost; НЕ вызывает syncBatchTotalCostInternal; нет проверки frozenAt.
src/lib/cost.ts distribute использует totalCost как C
src/lib/cost-report.ts:210
src/server/internal/finance-operations.ts:syncBatchTotalCostInternal L66-92

Historical behavior (pre-P1):
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
Shipped in P1 as described in Production resolution.

Confidence: HIGH
```

---

## DI-002

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `199fe2f283a9685bce889e71c95fd32faedc61f6`
- Migration: none
- Deploy evidence: GitHub Actions run `33875705448` SUCCESS (2026-09-04), SHA `199fe2f`. Still present in production `060629e`.
- What changed: `setAccountConfirmed` locks Account→Deal→Batch, updates `confirmed`, then `syncDealInternal` in the same TX. Totals follow quarantine on/off without waiting for a later Deal mutation.
- Historical corruption: none observed / not asserted.

```
ID: DI-002
Severity: P1
Status: CLOSED IN PRODUCTION
Domain: Finance / Cost
Reviewed: phase 1 @ 5479580; closed P1 199fe2f / prod 060629e

Invariant:
После подтверждения карантинного счёта его ДДС участвуют в Deal.total и
Batch.totalCost. Комментарий setAccountConfirmed finance.ts:365-368 это обещает
для «себестоимости сделок».

Historical evidence (фаза 1 @ 5479580):
src/server/finance.ts:setAccountConfirmed L370-376 — только account.confirmed.
Нет syncDealInternal / syncBatchTotalCostInternal.
Import: statement-import.ts создаёт confirmed:false, затем после TX
syncDealInternal по auto-assigned deals — в этот момент sumConfirmedExpense
ещё отсекает неподтверждённый счёт (deal-cost.ts / finance-operations.ts:63-64).
getFinanceData / getPeriodOverhead фильтруют confirmed=true — live ДДС ок,
derived Batch.totalCost нет.

Historical behavior (pre-P1):
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
Shipped in P1 as described in Production resolution.

Confidence: HIGH
```

---

## DI-003

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `199fe2f283a9685bce889e71c95fd32faedc61f6`
- Migration: `20260904150000_di003_account_number_import_key_unique` (applied 2026-09-04 13:07:42 UTC)
- Deploy evidence: GitHub Actions run `33875705448` SUCCESS (2026-09-04), SHA `199fe2f`. Production catalog 2026-09-06: `CashFlow_accountId_importKey_key` and `Account_accountNumber_key` present; dup importKey groups = 0.
- What changed: partial UNIQUE `(accountId, importKey)` where importKey NOT NULL; partial UNIQUE `Account.accountNumber`; import wraps in `retryOnceOnImportUnique` (P2002 → retry once as skip).
- Historical corruption: none observed / not asserted (dup groups 0 at verify).

```
ID: DI-003
Severity: P1
Status: CLOSED IN PRODUCTION
Domain: Finance
Reviewed: phase 1 @ 5479580; closed P1 199fe2f / prod 060629e

Invariant:
Одна банковская операция (тот же importKey на счёте) = одна строка CashFlow.
Комментарий lib/statement-import.ts:13-16 и INV-035.

Historical evidence (фаза 1 @ 5479580):
prisma/schema.prisma CashFlow L643-648 @@index([accountId, importKey]) — не @unique.
prisma/migrations/20260630164144_cashflow_import_key/migration.sql:
  CREATE INDEX ... (не UNIQUE).
src/server/internal/statement-import.ts:256-299 findFirst then create внутри I TX.
Два входа: importStatement (admin) и POST /api/cron/fetch-statements +
scripts/fetch-statements.ts.

Historical behavior (pre-P1):
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
Shipped in P1 as described in Production resolution.

Confidence: HIGH
```

---

## DI-004

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `199fe2f283a9685bce889e71c95fd32faedc61f6`
- Migration: none
- Deploy evidence: GitHub Actions run `33875705448` SUCCESS (2026-09-04), SHA `199fe2f`. Still present in production `060629e`. Owner deferred only DI-011 / DI-017, not this card.
- What changed: `lockSuppliesInOrder` + ProductStock `FOR UPDATE`, then `computeSupplyDeduction` from locked live qty and `updateMany` gte (CAS). Concurrent overlapping sync cannot double-decrement below available.
- Historical corruption: none observed / not asserted. Marketplace behavior was not re-audited in this pass beyond shipped P1 evidence.

```
ID: DI-004
Severity: P1
Status: CLOSED IN PRODUCTION
Domain: Marketplace / Warehouse
Reviewed: phase 1 @ 5479580; closed P1 199fe2f / prod 060629e

Invariant:
Отгрузка поставки списывает ProductStock один раз на (delta). Нельзя уйти в минус
(computeSupplyDeduction + комментарий marketplace-sync.ts:535).

Historical evidence (фаза 1 @ 5479580):
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

Historical behavior (pre-P1):
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
Shipped in P1 as described in Production resolution.

Confidence: HIGH
```

---

## DI-005

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `cc571f5075b873b3f0ded733eedc438792562b40` (`fix: harden cost freeze integrity`)
- Migration: `20260904170000_batchcost_final_unique` (applied 2026-09-04 15:18:51 UTC)
- Deploy evidence: GitHub Actions run `33888149932` SUCCESS (2026-09-04), SHA `cc571f5`. Production catalog 2026-09-06: `BatchCost_batchId_final_key` present; duplicate FINAL groups = 0. Still in production `060629e`.
- What changed: `maybeFreezeBatch` `SELECT Batch FOR UPDATE` (unless already locked), re-read C/prices/ops, then FINAL + `frozenAt`. `syncBatchTotalCostInternal` still skips frozen via `updateMany where frozenAt: null`. Partial UNIQUE one FINAL per batch.
- Historical corruption: none observed / not asserted. BD-2: existing FINAL vs `totalCost` is not auto-rewritten.

```
ID: DI-005
Severity: P2
Status: CLOSED IN PRODUCTION
Domain: Cost / Finance
Reviewed: 01.2 @ HEAD 9b5ed66 (после P1 199fe2f); closed cc571f5 / prod 060629e

Invariant:
После freeze Batch.totalCost и FINAL — одна замороженная C
(finance-operations.ts:151 «Замороженные партии не трогаем»; P1:
money-поля updateBatch запрещены если frozenAt уже set).

Historical evidence (01.2 @ 9b5ed66):
P1 закрыл запись C ПОСЛЕ committed frozenAt:
  syncBatchTotalCostInternal L157 FOR UPDATE Batch;
  L159 skip if frozenAt; L182-186 updateMany where { id, frozenAt: null }.
P1 НЕ менял freeze path (internal/cost.ts, payroll.ts нет в 199fe2f):
  maybeFreezeBatch L400 findUnique БЕЗ FOR UPDATE;
  freezeBatch L370 computeBatchSnapshot(in-memory batch) ДО
  L371 batch.update frozenAt.
Тест p1-review-concurrency «freeze || updateBatch» сам делает
SELECT Batch FOR UPDATE — это не maybeFreezeBatch.

Historical behavior (pre-cc571f5):
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
Shipped in cc571f5 as described in Production resolution.

Confidence: HIGH
```

---

## DI-006

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `cc571f5075b873b3f0ded733eedc438792562b40`
- Migration: `20260904170000_batchcost_final_unique` (same as DI-005; UNIQUE FINAL only)
- Deploy evidence: GitHub Actions run `33888149932` SUCCESS (2026-09-04), SHA `cc571f5`. Production catalog 2026-09-06: unique FINAL index present. Still in production `060629e`.
- What changed: `recalcBatchCosts` runs per-batch in a TX with Batch `FOR UPDATE`; skips create if frozen (deletes orphan PRELIMINARY); freeze deletes PRELIMINARY then inserts at most one FINAL. UNIQUE PRELIMINARY was not added (BD-1: cache, not SoT).
- Historical corruption: none observed / not asserted.

```
ID: DI-006
Severity: P2
Status: CLOSED IN PRODUCTION
Domain: Cost
Reviewed: 01.2 @ HEAD 9b5ed66; closed cc571f5 / prod 060629e

Invariant (намерение freezeBatch, не UI SoT):
После freeze в BatchCost остаётся FINAL; recalc не пишет.
PRELIMINARY — cache, не SoT текущего отчёта.

Historical evidence (01.2 @ 9b5ed66):
recalcBatchCosts L340-361: нет $transaction, нет lock, нет recheck
frozenAt на create. deleteMany PRELIMINARY затем create — два statement.
Schema: @@index(batchId) only; unique (batchId,status) нет; FK RESTRICT.
loadCostContext L181: findMany { status: FINAL } only.
Бейдж отчёта: batch.frozenAt, не BatchCost.status (cost-report.ts:385).
Ни один reader не find PRELIMINARY.
cost-queue in-memory; recalcBatchCostsInternal нет; CLI recalc нет.
P1 cost.ts не трогал.

Historical behavior (pre-cc571f5):
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
Shipped in cc571f5 (UNIQUE FINAL + locked recalc). UNIQUE PRELIMINARY still
not added (BD-1).

Confidence: HIGH
```

---

## DI-007

**Pass 01.10 (2026-09-05):** переоценен на HEAD `16015d5` (после DI-020).
Разбор и полное воспроизведение: `audit/01.10-terminal-idempotency-review.md`.
Production SELECT read-only 2026-09-05. **На тот момент НЕ fixed.**

**Pass 01.13 (2026-09-05):** owner lock. План `audit/01.13-terminal-idempotency-remediation-plan.md`.
Простой `findUnique` до `lockRailLots` **отклонён** как недостаточный под
concurrent same-id при `remaining === railsTaken`.

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `327b4ae6e54c15b37314d93b2b0c33563274d877` (`fix: harden terminal operation idempotency`)
- Migration: none for DI-007 (app-path). Companion DI-008 migration `20260905170000_production_operation_client_request_id_not_null` applied 2026-09-05 16:17:30 UTC.
- Deploy evidence: GitHub Actions run `33977066876` SUCCESS (2026-09-05), SHA `327b4ae`. Still present in production `060629e` (later `8240f4d` EXTREME admin-code did not reopen replay-before-ack).
- What changed: `submitTorcovka` fast `findUnique` → `lockRailLots` → post-lock `findUnique` → physics. Replay = `IDEMPOTENT_REPLAY` (no stock / ChangeLog / archive / enqueue). UNIQUE remains the backstop.
- Historical corruption: none observed. Ops/lines/BlankStock/ChangeLog were never doubled in 01.10 reproduction; the bug was a false error to the operator.

```
ID: DI-007
Severity: P2
Status: CLOSED IN PRODUCTION
Domain: Production / Terminal
Reviewed: 01.10 @ HEAD 16015d5; plan 01.13; closed 327b4ae / prod 060629e

Invariant:
Повтор того же clientRequestId после закоммиченного успеха = success, без
побочных эффектов и без повторного запроса подтверждения
(JSDoc terminal.ts:67-71, :339, A21).

Historical evidence (код, HEAD 16015d5, submitTorcovka terminal.ts:353-479):
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

Historical behavior (воспроизведено локально, PG 17, prod-код без правок @ 16015d5):
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

Production exposure (01.10):
0 живых ProductionOperation. Но лот ПАК-40-1280-01-7 remainingQuantity=0 при
quantity=1280 — ровно конфигурация S1a, т.е. путь реально достижим.

Detection:
Op с этим clientRequestId существует, клиент получил ошибку остатка или
повторный ACK_REQUIRED.

Recovery:
Не требуется (qty и деньги корректны).

Implemented fix (shipped 327b4ae):
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
2026-09-05. **На тот момент НЕ fixed.** Достижимо прямым вызовом Server Action и
internal-вызовами; штатным терминальным UI — НЕТ (трассировка всех 4 экранов).

**Pass 01.13 (2026-09-05):** owner = **C** (app required + DB NOT NULL + UNIQUE).
План `audit/01.13-terminal-idempotency-remediation-plan.md`. Backfill запрещён.
NULL перед migrate → STOP.

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `327b4ae6e54c15b37314d93b2b0c33563274d877`
- Migration: `20260905170000_production_operation_client_request_id_not_null` (applied 2026-09-05 16:17:30 UTC)
- Deploy evidence: GitHub Actions run `33977066876` SUCCESS (2026-09-05), SHA `327b4ae`. Production catalog 2026-09-06: `clientRequestId` `attnotnull = t`; UNIQUE `ProductionOperation_clientRequestId_key` present; NULL rows = 0.
- What changed: `requireClientRequestId` on all four submit paths; column SET NOT NULL (no backfill); existing UNIQUE kept. Upakovka duplicate productId validation shipped in the same release.
- Historical corruption: none observed / not asserted. NULL count was 0 before migrate.

```
ID: DI-008
Severity: P2
Status: CLOSED IN PRODUCTION
Domain: Production / Terminal
Reviewed: 01.10 @ HEAD 16015d5; plan 01.13 owner C; closed 327b4ae / prod 060629e

Invariant:
Дубль терминальной попытки не создаёт две ProductionOperation.

Historical evidence (HEAD 16015d5):
schema.prisma:355 clientRequestId String? @unique — nullable.
migration 20260713161800: ALTER TABLE ADD COLUMN TEXT + CREATE UNIQUE INDEX.
Production (SELECT 2026-09-05, pre-327b4ae): pg_attribute.attnotnull = 'f';
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

Historical behavior (воспроизведено локально, PG 17, prod-код без правок @ 16015d5):
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

Implemented fix (shipped 327b4ae):
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

**Pass 01.6 evidence:** `audit/01.6-inventory-provenance-review.md`. **Owner lock 2026-09-04.** Plan: `audit/01.7-inventory-integrity-remediation-plan.md`.

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `1f411e5e0f8018069e9f91d69439ff306fdc2572` (`fix: enforce inventory integrity boundary`)
- Migration: none (app-path; DI-016 later added draft UNIQUE)
- Deploy evidence: GitHub Actions run `33952967617` SUCCESS (2026-09-05), SHA `1f411e5`. Still present in production `060629e`. Later DI-016 (`16015d5`) did not reopen these guards.
- What changed: live == accountedQty guard (`STALE_SNAPSHOT`) inside TX; `deviationSum` frozen Decimal; `Inventory.date` at conduct; CONDUCTED `updateMany` CAS; reverse blocked when CONDUCTED line covers the ref (`assertInventoryBoundary`); serializeDoc returns stored deviationSum.
- Historical corruption: none observed / not asserted. Production 2026-09-06: 1 CONDUCTED, 0 DRAFT, 0 InventoryLine (same as 01.6 exposure 0).

```
ID: DI-009
Severity: P1
Status: CLOSED IN PRODUCTION
Domain: Inventory / Production
Reviewed: 01.6 @ HEAD 931efe8; closed 1f411e5 / prod 060629e

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

CONFIRMED BUG (historical, pre-1f411e5):
- deviation/deviationSum считаются от accountedQty черновика без сверки live
  (warehouse.ts:326 vs абсолютный SET :335/341/364/390 @ 931efe8).
- serializeDoc не отдаёт сохранённый deviationSum; UI истории считает
  live unitCost текущего месяца (warehouse-inventory-tab.tsx:320-323).

INVARIANT WEAKNESS (historical, pre-1f411e5):
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
- DI-016 два DRAFT (later closed separately);
- BD-9.3 НЗП/заготовки;
- BD-9.7 CashFlow «Потеря ГП»;
- explicit counted-line UX (prefill actual=accounted).

OWNER:
- BD-9.1 = C (abort если live != accountedQty);
- BD-9.2 = граница, точечный блок reverse по покрытому ref;
- BD-9.5 = CONDUCTED не undo;
- BD-9.6 = freeze deviationSum, Decimal;
- date at conduct = now(); historical prod не переписывать.

Historical evidence (код, HEAD 931efe8):
warehouse.ts:228-283 createInventoryDraft accountedQty = live at t0
warehouse.ts:313-422 conduct: valuation и status вне TX; SET actualQty;
  ChangeLog только {status, lines:N}
production-reversal.ts reverse: gte вниз, increment вверх, без inventory
schema: нет UNIQUE DRAFT; нет applied* колонок; InventoryLine.refId без FK

Production (SELECT 2026-09-04): 1 Inventory CONDUCTED, 0 InventoryLine.
Exposure = 0. Историческую corruption НЕ утверждать.

Minimal fix: 01.7 — без schema/migration. Shipped in 1f411e5.

Confidence: HIGH
```

Не открывать ledger/FIFO/event sourcing. 01.7 shipped in `1f411e5`; do not reopen as FIFO.

Смежное, карточка не открыта (01.6 §9.5): `InventoryLine.refId` без FK + `deleteDetail`.

---

## DI-010

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `199fe2f283a9685bce889e71c95fd32faedc61f6`
- Migration: `20260904151000_di010_active_sku_unique` (applied 2026-09-04 13:07:42 UTC)
- Deploy evidence: GitHub Actions run `33875705448` SUCCESS (2026-09-04), SHA `199fe2f`. Production catalog 2026-09-06: `Product_skuOzon_active_key` / `Product_skuWb_active_key` present. Owner deferred only DI-011 / DI-017, not this card.
- What changed: partial UNIQUE skuOzon / skuWb among ACTIVE products; `assertUniqueActiveSkus` on create/update/unarchive; ARCHIVED may keep historical SKUs (owner lock 2026-09-04).
- Historical corruption: none observed / not asserted. Marketplace matching was not re-audited in this pass beyond shipped P1 evidence.

```
ID: DI-010
Severity: P2
Status: CLOSED IN PRODUCTION
Domain: Marketplace / Nomenclature
Reviewed: phase 1 @ 5479580; closed P1 199fe2f / prod 060629e

Invariant:
Один skuOzon / skuWb соответствует одному Product (матчинг продаж и списания ГП).
Owner (P1): uniqueness among ACTIVE only.

Historical evidence (фаза 1 @ 5479580):
schema Product L281-282 String NOT NULL, без @unique.
nomenclature.ts:371-372 только non-empty trim.
marketplace-sync.ts:424-425 Map sku→id, last-wins при дублях.
marketplace.ts:buildNameBySku last-wins для UI имён.

Historical behavior (pre-P1):
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
Shipped in P1 as ACTIVE-only partial UNIQUE.

Confidence: HIGH
```

---

## DI-011

**Owner (2026-09-05):** **DEFERRED BY OWNER.** Marketplace currently low priority; may be redesigned rather than incrementally hardened. Not FIXED, not CLOSED. Код marketplace в этом pass не аудировался и не менялся.

```
ID: DI-011
Severity: P2
Status: DEFERRED BY OWNER
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

Re-checked 2026-09-06: still **DESIGN RISK**. Cost-queue remains in-memory; production still one app container (`DEPLOY-STATUS.md`). Not closed.

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

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `199fe2f283a9685bce889e71c95fd32faedc61f6`
- Migration: none
- Deploy evidence: GitHub Actions run `33875705448` SUCCESS (2026-09-04), SHA `199fe2f`. Still present in production `060629e`. Guarded by `finance-writers.lock.test.ts` (sync inside the same `$transaction` as CF/Deal/Account writers).
- What changed: `syncDealInternal` / `syncBatchTotalCostInternal` accept the TX client; create/update/delete CashFlow, Deal, import, and account confirm all write derived totals in the same TX as the source. Recalc queue stays after commit.
- Historical corruption: none observed / not asserted.

```
ID: DI-013
Severity: P2
Status: CLOSED IN PRODUCTION
Domain: Finance / Cost
Reviewed: phase 1 @ 5479580; closed P1 199fe2f / prod 060629e

Invariant:
Источник (Deal/CashFlow) и derived (Deal.total, Batch.totalCost) согласованы
после успешной мутации.

Historical evidence (фаза 1 @ 5479580):
createCashFlow L846-864: create затем syncDealInternal.
createDeal L1134-1147: nested create затем sync.
deleteDeal L1198-1205: TX unlink+delete затем sync batches.
updateDeal: TX items затем sync.
import: TX затем sync deals.
Нет общей TX источник+derived.

Historical behavior (pre-P1):
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
Shipped in P1 as described in Production resolution.

Confidence: HIGH
```

---

## DI-014

**Pass 01.18 (2026-09-05):** CLOSED IN PRODUCTION @ `060629eaeb91dafdd2b0484d165ea695a949f6f4`.
Разбор: `audit/01.18-payment-operation-uniqueness-review.md`. Deploy `33992508139`.
Классификация до hardening: **INVARIANT WEAKNESS / DB HARDENING**. Гипотеза live
double-pay **не подтверждена**. Исторической порчи выплат нет (на verify:
0 Payment, 0 PaymentBatchItem, 0 ProductionOperation). DI-015 **не** менялся.

```
ID: DI-014
Severity: P3 (historical)
Status: CLOSED IN PRODUCTION
Domain: Payroll
Reviewed: 01.18 @ HEAD 060629eaeb91dafdd2b0484d165ea695a949f6f4

Invariant:
Одна ProductionOperation входит не более чем в один PaymentBatchItem
(атомарно целиком). Partial payment и payment reversal не поддерживаются.

Original finding (фаза 1, сохранившаяся причина карточки):
init PaymentBatchItem: PK id, FK operationId Restrict, без UNIQUE operationId.
Тогда защита только claim isPaid в markEmployeePaid.

Re-audit 01.18 (не live race):
App-path уже был безопасен после позднего payroll/freeze locking (cc571f5):
  ProductionOperation ORDER BY id FOR UPDATE
  → post-lock isPaid re-read
  → authoritative amount recalculation
  → updateMany WHERE isPaid=false claim
  → Payment
  → PaymentBatchItem
Оставшаяся слабость — только DB: Prisma 1:N, нет UNIQUE(operationId).
Двойной insert тем же operationId был возможен лишь в обход app-path
(Studio / будущий writer / test harness), не штатной выплатой.

Current behavior (production):
UNIQUE("PaymentBatchItem"."operationId") + прежние app locks/claim.
ProductionOperation.payment: PaymentBatchItem? (Prisma 1:1).
PaymentBatchItem.amount нет; сумма — Payment.amount.

Implemented:
schema: operationId String @unique
migration: 20260905220000_payment_batch_item_operation_unique
  LOCK ACCESS EXCLUSIVE; duplicate groups RAISE; CREATE UNIQUE INDEX only.
  No UPDATE / DELETE / DROP / backfill / dedup.
index: PaymentBatchItem_operationId_key
FK: operationId → ProductionOperation.id ON DELETE RESTRICT (unchanged)

Production:
release SHA 060629eaeb91dafdd2b0484d165ea695a949f6f4
deploy run 33992508139 SUCCESS
migration applied YES (1 row, finished_at 2026-09-05 21:21:43 UTC)
duplicate operationId before: 0
duplicate operationId after:  0

Concurrency:
App serializes markEmployeePaid via FOR UPDATE; UNIQUE — backstop.

Business impact:
Сейчас нет. Страховка схемы **есть** в production.

Detection:
GROUP BY operationId HAVING count>1 на PaymentBatchItem — ожидается 0.

Recovery:
n/a. Preflight STOP, если дубли появятся до migrate (на проде не было).

DI-015:
UNCHANGED / separate issue (live Employee rates at payment time).

Confidence: HIGH
```

---

## DI-015

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `13eaceaf079941bcf9efeb13bd08f8845ae68f40`
- Migration: `20260906013000_operation_rate_snapshots`
- Deploy evidence: GitHub Actions run `34030735264` SUCCESS
- Migration finished: `2026-09-06 11:43:33.229016+00`
- Rollback: none
- What changed: ProductionOperation now stores the Employee rate snapshot at operation performance/create time; later Employee rate changes affect future operations only.
- Snapshot model: six nullable Decimal(14,2) rate fields + required `rateSnapshotVersion=1`
- Readers: payroll / payment / day breakdown / production journal / terminal journal / cost use operation snapshots, not live Employee rates
- Fact correction: corrected fact × historical snapshot rate
- Historical reconstruction: not required because ProductionOperation count was 0 immediately before migration
- Production verification: runtime exact SHA `13eaceaf079941bcf9efeb13bd08f8845ae68f40`; schema 6 nullable rate columns + `rateSnapshotVersion` NOT NULL / no default; ProductionOperation count after deploy = 0; health/pages PASS; no production functional write test performed
- Historical payroll corruption: not asserted / not claimed

Historical owner decision (2026-09-06, before implementation):
Card was previously OPEN / NEEDS BUSINESS DECISION, then OPEN (OWNER DECISION LOCKED).
Owner chose: snapshot rate at operation performance; later Employee rate
changes affect future operations only; unpaid fact correction keeps the
historical rate (corrected fact × snapshot). That decision is now
implemented and shipped in production (see resolution). Dedicated
audit/remediation lived in the DI-015 workstream until this deploy.

```
ID: DI-015
Severity: P3
Status: CLOSED IN PRODUCTION
Domain: Payroll / Cost
Reviewed: owner decision 2026-09-06; closed in production 13eacea / deploy 34030735264

Invariant (owner, 2026-09-06; now implemented in production):
Rate is determined when the ProductionOperation is performed / created.
Later Employee rate changes affect FUTURE operations only.
Existing operations retain the historical applicable rate.
Unpaid fact correction (qty/hours) uses corrected fact × historical
snapshotted rate, not the current Employee rate.
Payment and historical labor cost use operation snapshot rates.

Historical status (pre-13eacea):
OPEN / NEEDS BUSINESS DECISION, then OPEN (OWNER DECISION LOCKED).
Implementation was pending until release SHA 13eacea.

Historical evidence (pre-13eacea / pre-migration):
Нет полей rate на ProductionOperation / Payment кроме Payment.amount.
payroll.ts:185-194 amount из buildRefMaps() = текущие Employee.*Rate.
getSalaryReport: unpaid — live rates; paid — p.amount.
loadCostContext L198-226: labor в с/с изделия тоже текущие ставки,
включая оплаченные ops. FINAL BatchCost — только материал партии.

Historical behavior (pre-snapshot):
Смена ставки после работы:
- невыплаченное начисление в отчёте ЗП меняется;
- уже созданный Payment.amount нет;
- вклад работы в live cost report меняется даже для прошлого.

Current behavior (production):
Writers snapshot Employee rates onto ProductionOperation at successful
submit (rateSnapshotVersion=1). Readers use snapshots only; null rate
→ earning 0; no live Employee fallback. Later Employee rate edits do
not rewrite existing ops.

Concurrency:
Operation submit vs Employee rate update is serialized.

Submit lock order:
existing operation/stock locks
→ Employee FOR UPDATE
→ read Employee rate vector
→ INSERT ProductionOperation with snapshot

`updateEmployee` waits on the same Employee row lock.

If submit acquires the Employee lock first:
the operation stores the old rate snapshot.

If the Employee rate update commits first:
the operation stores the new rate snapshot.

This prevents a successfully committed operation from capturing a stale
rate across a concurrent Employee rate change.

Business impact (historical, pre-snapshot):
Историческая «начисленная, но не выплаченная» сумма была нестабильна.
Полная с/с изделия за период не замораживалась вместе с партией.
На проде до migrate ops=0 — реконструкция истории не требовалась;
порчу исторических выплат не утверждать.

Detection (historical):
Сравнить Payment.amount с пересчётом тех же ops текущими ставками.

Recovery:
n/a — snapshot semantics shipped; historical reconstruction not required
(ProductionOperation count was 0 immediately before migration).

Minimal fix direction:
Shipped as described in Production resolution.

Confidence: HIGH
```

---

## DI-016

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `16015d5ece9af8514a0ec3dc9c0fb913c15ced48` (`fix: enforce single inventory draft`)
- Migration: `20260905160000_di016_inventory_single_draft` (applied 2026-09-05 14:28:50 UTC)
- Deploy evidence: GitHub Actions run `33971627473` SUCCESS (2026-09-05), SHA `16015d5`. Production catalog 2026-09-06: `Inventory_status_draft_key` present (`WHERE status = 'DRAFT'`); DRAFT count = 0.
- What changed: partial UNIQUE one global DRAFT; `createInventoryDraft` maps P2002 (Inventory/status) to `DRAFT_ALREADY_EXISTS`; admin `deleteInventoryDraft` (DRAFT only, stock untouched); CONDUCTED remains immutable.
- Historical corruption: none observed / not asserted. Duplicates never existed on prod.

```
ID: DI-016
Severity: P2  (повышено с P3 — audit/01.8, 2026-09-05)
Status: CLOSED IN PRODUCTION
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

Historical evidence (pre-16015d5):
DB-гарантии нет. createInventoryDraft (warehouse.ts:244-299):
findFirst({status:"DRAFT"}) :246 и inventory.create :275 — два запроса
в РАЗНЫХ транзакциях, без lock, без advisory lock, без DB-unique.
Окно гонки = время getWarehouseStock() :249 (десятки–сотни мс).
Production (SELECT read-only 2026-09-05, pre-16015d5): индексы только Inventory_pkey /
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

Historical behavior (pre-16015d5):
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

**Owner (2026-09-05):** **DEFERRED BY OWNER.** Marketplace currently low priority; may be redesigned rather than incrementally hardened. Not FIXED, not CLOSED. Код marketplace в этом pass не аудировался и не менялся.

```
ID: DI-017
Severity: P3
Status: DEFERRED BY OWNER
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

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `cc571f5075b873b3f0ded733eedc438792562b40`
- Migration: none (app lock; UNIQUE FINAL is DI-005/006)
- Deploy evidence: GitHub Actions run `33888149932` SUCCESS (2026-09-04), SHA `cc571f5`. Still present in production `060629e`.
- What changed: `markEmployeePaid` locks TORCOVKA batches after claim, then `maybeFreezeBatch(..., { batchAlreadyLocked: true })`. Concurrent last-T payments serialize on Batch `FOR UPDATE`; the second count sees unpaid=0 or already frozen.
- Historical corruption: none observed / not asserted.

```
ID: DI-018
Severity: P2
Status: CLOSED IN PRODUCTION
Domain: Cost / Payroll
Reviewed: 01.2 @ HEAD 9b5ed66; closed cc571f5 / prod 060629e

Invariant:
Закрытая партия (closedAt) с unpaid TORCOVKA = 0 должна получить
frozenAt + FINAL (canFreezeBatch; payroll.ts:234-237).

Historical evidence (01.2 @ 9b5ed66):
maybeFreezeBatch L402-404: count isPaid:false TORCOVKA без lock всех
ops партии и без Batch FOR UPDATE.
markEmployeePaid вызывает maybeFreeze только для batchId TORCOVKA
этой выплаты.
archiveBatchIfDepleted L417: если closedAt уже set → return, freeze нет.
Других callers maybeFreezeBatch нет.

Historical behavior (pre-cc571f5):
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
Shipped in cc571f5 as described in Production resolution.

Confidence: HIGH
```

---

## DI-019

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `cc571f5075b873b3f0ded733eedc438792562b40`
- Migration: none
- Deploy evidence: GitHub Actions run `33888149932` SUCCESS (2026-09-04), SHA `cc571f5`. Still present in production `060629e`.
- What changed: `updateProductionLineQuantity` / delete lock `ProductionOperation` `FOR UPDATE` first, then reject if `isPaid`. Same lock order on `correctTorcovkaRailsTaken` (later DI-020). Payment FK RESTRICT still blocks delete of paid ops.
- Historical corruption: none observed / not asserted.

```
ID: DI-019
Severity: P2
Status: CLOSED IN PRODUCTION
Domain: Cost / Production
Reviewed: 01.2b @ HEAD 9b5ed66; closed cc571f5 / prod 060629e

Invariant:
После выплаты TORCOVKA (и freeze FINAL) факт lines не меняется.
FINAL считается из TORCOVKA lines (freezeBatch / distribute).

Historical evidence (01.2b @ 9b5ed66):
updateProductionLineQuantity L210-215 isPaid check ВНЕ TX.
TORCOVKA TX L306-362: BlankStock ±; operationDetailLine.update qty.
Нет lock ProductionOperation. Нет where isPaid=false.
deleteProductionOperation L390-395 isPaid вне TX; L436 delete({ id })
без isPaid. PaymentBatchItem.operationId ON DELETE RESTRICT (init L609).
OperationDetailLine.operationId ON DELETE RESTRICT (init L555) —
lines удаляют до Op, это не про Payment.
Parent UPDATE isPaid не блокирует child quantity UPDATE.

Historical behavior (pre-cc571f5):
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
Shipped in cc571f5 as described in Production resolution.

Confidence: HIGH
```

---

## DI-020

Production resolution:
- Status: CLOSED IN PRODUCTION
- Release SHA: `a5f901add5825bd37bdd18ffee476b060c13e138` (`feat: protect torcovka input and add rail correction`); security classify `931efe87f98431e8fb27dd11f4e3dd7e61738a03`
- Migration: `20260904180000_torcovka_waste_ack` (applied 2026-09-04 18:00:14 UTC)
- Deploy evidence: GitHub Actions run `33903011976` SUCCESS (2026-09-04), SHA `931efe8`. Still present in production `060629e`.
- What changed: NORMAL / SUSPICIOUS / EXTREME waste bands; SUSPICIOUS requires worker confirm; EXTREME blocked without explicit high-waste ack; admin `correctTorcovkaRailsTaken` returns remaining rails (decrease only). Later `8240f4d` replaced EXTREME reason UX with admin 4-digit approval (`20260905210000_torcovka_approval`, deploy `33989414542`) — **did not reopen** the plausibility invariant.
- Historical corruption: not asserted as DB corruption. Incident-like op existed (72.98% waste on ПАК-40-1280-01-7) and was deleted; remaining stayed 0.

```
ID: DI-020
Severity: P1
Status: CLOSED IN PRODUCTION
Domain: Production / Terminal / Cost / Inventory
Reviewed: 01.4 @ HEAD cc571f5, production SELECT 2026-09-04 read-only;
  closed a5f901a / 931efe8 / prod 060629e

Invariant (historical absence; now enforced):
Система отличает физически правдоподобный расход реек от очевидной
ошибки ввода. Guard: NORMAL < 20%; SUSPICIOUS 20–50% (повторный confirm);
EXTREME ≥ 50% (explicit high-control path). Correction workflow exists
to lower railsTaken and return remainingQuantity. Ordinary delete TORCOVKA
still does not return rails (INV-047, unchanged).

Waste model (owner 2026-09-04):
Агрегат операции: railsTaken × lengthM vs Σ длин заготовок.
Не раскрой каждой рейки. DI-021 / bin-packing не открывать.
Минимум физики: заготовка ≤ длина рейки лота; Σ выход ≤ Σ взятых (INV-008).

Historical evidence (code @ cc571f5, before a5f901a):
torcovka-screen.tsx: «Сколько реек взято?», hint «Доступно N шт»,
  confirm bar без %; destructive только при overLength
terminal.ts:submitTorcovka — INV-008, gte remaining, нет max waste
production.ts:update — railsTaken immutable
production.ts:delete TORCOVKA — remaining не возвращается (INV-047)
src/ нет increment remainingQuantity

Historical evidence (production, READ ONLY, 2026-09-04):
Live ProductionOperation TORCOVKA N=0 (все 3 ops deleted).
ChangeLog reconstruction N=3, all later_deleted:
  5.21% (410/1280 пакета), 6.95% (420/1280), 72.98% (1280/1280 весь пакет).
Incident-like: cmtmj4dpi000srp29ek0iw37f ПАК-40-1280-01-7
  railsTaken=1280=lot_qty, taken_m=5120, produced_m=1383.48, waste_pct=72.98
  deleted 9 min later; remaining still 0.
Память «~97%» с этой строкой не совпадает; класс тот же.
P75/P90/P95 на N=3 непригодны (квантиль = инцидент).

Historical behavior (pre-a5f901a):
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
Штатного пути не было. Delete не возвращает рейки. Нужен отдельный
corrective workflow (01.4 §8 CASE A). Ops в том pass не чинить.
Correction workflow shipped in a5f901a.

Proposed guard bands (01.4 §7.5, не wasteThresholdPct=30) — shipped:
NORMAL < 20%; SUSPICIOUS 20–50% (повторный confirm); EXTREME ≥ 50%
(высокий контроль; later admin 4-digit instead of reason picker).

Minimal fix direction:
1) plausibility guard терминал+сервер (агрегат %, не bin-pack);
2) «исправить ошибочный ввод» (снизить railsTaken, вернуть remaining);
3) не менять обычный delete TORCOVKA.
Shipped in a5f901a / 931efe8 as described in Production resolution.

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
