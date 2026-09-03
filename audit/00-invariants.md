# Этап 0: инварианты, уже выраженные в коде

Фиксируется **существующее** поведение, не желаемое из v2, если оно не реализовано.  
Zod нет. Слои: client (UI), server (`throw new Error`), database (unique/enum/FK: required→Restrict on delete, optional→SetNull on delete; onUpdate Cascade).

---

INV-001  
Активный сотрудник должен иметь PIN из ровно 4 цифр; PIN уникален среди ACTIVE (не среди ARCHIVED).

Enforced:  
- client: форма сотрудника (тот же паттерн через серверную ошибку)  
- server: `src/lib/employee-pin.ts:validateActivePin`; `employees.ts:assertActivePin` ~L76; create/update ACTIVE/restore  
- database: нет (`Employee.pin` не unique; комментарий схемы L117)

Used by: создание/правка сотрудника, restore, terminal login (`resolvePinLookup`)

Source: `src/lib/employee-pin.ts`; `src/server/employees.ts`; `prisma/schema.prisma` Employee

---

INV-002  
В терминал входит только ACTIVE; PIN не отдаётся на клиент.

Enforced:  
- client: `serEmployee` pin=""  
- server: `requireTerminalEmployee` status ACTIVE; `terminalLoginByPin`  
- database: нет

Used by: terminal login / submit*

Source: `src/server/terminal.ts:serEmployee` ~L80; `session.ts:requireTerminalEmployee` ~L76

---

INV-003  
Коллизия PIN у нескольких ACTIVE → вход отклоняется.

Enforced: server `terminalLoginByPin` + `resolvePinLookup`  
database: нет unique

Used by: terminal login

Source: `src/server/terminal.ts` ~L295–301; `src/lib/terminal-auth.ts`

---

INV-004  
Email администратора уникален.

Enforced: database `User.email @unique`  
server: `signIn` findUnique

Used by: admin login

Source: `prisma/schema.prisma` User; `src/server/auth.ts:signIn`

---

INV-005  
Admin login: 5 неудач / 15 мин → lock 15 мин (in-memory, один инстанс).

Enforced: server `RateLimiter` в `auth.ts` L18–24  
database: нет

Used by: `/login`

Source: `src/server/auth.ts`; `src/lib/rate-limit.ts`

---

INV-006  
Terminal PIN brute-force: rate limit на попытки.

Enforced: server `terminal.ts:terminalLoginByPin` ~L272  
database: нет

Used by: terminal login

Source: `src/server/terminal.ts`

---

INV-007  
Остаток реек/заготовок/деталей/крепежа/упаковки/ГП не уходит в минус: decrement через `updateMany` + `quantity|remainingQuantity: { gte: n }`, count===0 → ошибка.

Enforced: server  
database: нет CHECK qty≥0

Used by: terminal submit*; production reverse/edit/delete; (частично warehouse)

Source: `terminal.ts` ~L361, L483, L521, L737, L772, L794, L806, L821; `production.ts` ~L316, L405

---

INV-008  
Суммарная длина заготовок торцовки ≤ длина взятых реек (`railsTaken * lot.lengthM`).

Enforced: server `isOverRailLength`; UI helper `lib/torcovka.ts`  
database: нет

Used by: submitTorcovka; уменьшение qty торцовки в production.ts ~L328

Source: `terminal.ts` ~L353; `lib/torcovka.ts`

---

INV-009  
Пакет торцовки принадлежит указанной партии.

Enforced: server `lot.batchId !== batchId`  
database: RailLot.batchId — required FK → Restrict on delete

Used by: submitTorcovka

Source: `terminal.ts` ~L343

---

INV-010  
Деталь «готова» только если выполнены все требуемые присадки (`prisadkaTorcevaya` / `prisadkaPloskost`).

Enforced: lib `isReady` + бакеты DetailStock  
database: комментарий схемы DetailStock L472–473; уникальность комбинации

Used by: упаковка, складские виды, тесты

Source: `src/lib/detail-stock.ts`; `prisma/schema.prisma` DetailStock

---

INV-011  
Нельзя править/удалять присадку, если деталь уже ушла в дальнейшую присадку/упаковку.

Enforced: server reverse gte fail  
database: нет

Used by: production edit/delete; reversePrisadkaLine

Source: `terminal.ts` ~L595

---

INV-012  
Нельзя править/удалять упаковку, если изделие уже отгружено/продано (недостаточно ProductStock для возврата).

Enforced: server `reverseUpakovkaOperation` gte  
database: нет

Used by: production

Source: `terminal.ts` ~L862

---

INV-013  
Выплаченную операцию нельзя изменить или удалить.

Enforced: server `op.isPaid`; UI toast  
database: нет (isPaid просто Boolean)

Used by: production admin; payroll freeze path

Source: `production.ts` ~L212, L391; `payroll.ts` после claim

---

INV-014  
Повтор терминальной операции с тем же `clientRequestId` не создаёт дубль (P2002 → success).

Enforced: database `@unique clientRequestId`; server `isDuplicateClientRequest`  
client: шлёт request id

Used by: submit*

Source: schema ProductionOperation L336–339; `terminal.ts` L59–71

---

INV-015  
Выплата ЗП атомарна: claim `updateMany` isPaid:false, count должен совпасть с выбранными ops (анти-TOCTOU).

Enforced: server tx  
database: нет отдельного lock кроме row update

Used by: markEmployeePaid

Source: `payroll.ts` ~L203–214 (A19)

---

INV-016  
Нет невыплаченных операций → выплатить нельзя.

Enforced: server `ops.length === 0`  
Used by: payroll  
Source: `payroll.ts` ~L189

---

INV-017  
Снапшот партии PRELIMINARY заменяется, пока `frozenAt == null`; после freeze recalc пропускает партию.

Enforced: server `recalcBatchCosts` where frozenAt null; `freezeBatch`  
database: CostStatus enum

Used by: cost-queue после ops/закупок; выплата

Source: `cost.ts` ~L435–459, L462–466

---

INV-018  
Заморозка партии только если `closedAt` задан и unpaid TORCOVKA count = 0.

Enforced: server `canFreezeBatch` + `maybeFreezeBatch`  
database: нет составного constraint

Used by: payroll; archiveBatchIfDepleted

Source: `cost.ts` ~L510–532; `lib/cost.ts:canFreezeBatch`

---

INV-019  
Партия архивируется (ARCHIVED + closedAt), когда Σ RailLot.remainingQuantity = 0 и lots.length > 0.

Enforced: server `archiveBatchIfDepleted`  
database: BatchStatus

Used by: torcovka; writeOffBatchRemainder

Source: `cost.ts` ~L542–556

---

INV-020  
Нельзя удалить партию, если есть движения (ops) или привязка к сделке.

Enforced: server  
database: required FK → Restrict on delete (доп. к явной проверке в коде)

Used by: purchases

Source: `purchases.ts` ~L369

---

INV-021  
Имя партии уникально.

Enforced: database `Batch.name @unique`; server `assertUniqueBatchName`  
Used by: createBatch  
Source: schema Batch; `purchases.ts` ~L223

---

INV-022  
Материал уникален по (name, sectionWidth, sectionHeight); сечение обязано быть > 0 при create/update.

Enforced: database unique; server requireSection / clash  
Used by: materials, createBatch (материал должен иметь сечение)

Source: schema Material L159; `materials.ts` ~L33; `purchases.ts` ~L208–210

---

INV-023  
В партии хотя бы один пакет; purchaseCost > 0; название и materialId обязательны.

Enforced: server `validateBatch`  
database: NOT NULL на money/name/materialId

Used by: createBatch

Source: `purchases.ts` ~L190–194

---

INV-024  
Код пакета уникален, если задан.

Enforced: database `RailLot.code @unique`  
Used by: createBatch packages

Source: schema RailLot L204

---

INV-025  
BlankStock уникален по (materialId, lengthM, detailType, sort); DetailStock — (detailId, torcevayaDone, ploskostDone); один ProductStock на product; один NomenclatureStock на item.

Enforced: database uniques  
Used by: upserts терминала/склада

Source: schema L420, L482, L487, L495

---

INV-026  
Нельзя удалить сотрудника с производственными операциями — только архив.

Enforced: server  
database: required FK Employee←ops → Restrict on delete

Used by: employees

Source: `employees.ts` ~L186

---

INV-027  
Нельзя удалить материал, если есть партии/детали/изделия/заготовки — архив.

Enforced: server  
Used by: materials  
Source: `materials.ts` ~L125

---

INV-028  
ФИО сотрудника обязательно.

Enforced: server create/update  
Used by: employees  
Source: `employees.ts` ~L105, L124

---

INV-029  
Сумма ДДС > 0; счета перевода различны.

Enforced: server  
Used by: createCashFlow, createTransfer, convertCashFlowToTransfer

Source: `finance.ts` ~L810–876, L1003–1005

---

INV-030  
Нельзя удалить счёт с операциями ДДС.

Enforced: server  
database: required FK CashFlow.accountId → Restrict on delete

Used by: deleteAccount

Source: `finance.ts` ~L378

---

INV-031  
Категория статей: имя уникально на уровне приложения (findFirst), не unique в схеме.

Enforced: server  
database: нет

Used by: create/update ArticleCategory

Source: `finance.ts` ~L475–501

---

INV-032  
Статья не может быть parent самой себе; нельзя удалить статью с детьми / cashflows / auto-rules; нельзя удалить категорию со статьями.

Enforced: server  
Used by: finance articles

Source: `finance.ts` ~L573, L606–612, L519

---

INV-033  
Контрагента нельзя удалить, если есть ДДС или автоправила.

Enforced: server  
Source: `finance.ts` ~L436

---

INV-034  
Выписка: формат `1CClientBankExchange` и наличие РасчСчет.

Enforced: server + `lib/bank-statement-1c.ts`  
Used by: importStatement / IMAP

Source: `finance.ts` ~L1325–1329

---

INV-035  
Дубли строк выписки пропускаются по `(accountId, importKey)` через findFirst (не unique constraint).

Enforced: server  
database: index, **не unique**

Used by: importStatement

Source: `finance.ts` ~L1406–1414; schema CashFlow L647–648

---

INV-036  
Автосозданный импортом счёт `confirmed=false` до ручного подтверждения; неподтверждённые не в KPI/ДДС (по комментарию схемы Account L546–550 — проверить в чтении finance/dashboard на следующем этапе).

Enforced: server create path import; schema default confirmed=true для ручных

Used by: statement import

Source: schema Account; `finance.ts` import ~L1358+

---

INV-037  
Сделка: название и ≥1 закупка.

Enforced: server  
Used by: createDeal/updateDeal  
Source: `finance.ts` ~L1170–1195

---

INV-038  
Только один черновик инвентаризации; править actual и проводить можно только DRAFT; actualQty ≥ 0.

Enforced: server  
database: нет unique на status=DRAFT

Used by: warehouse

Source: `warehouse.ts` ~L226, L284, L290, L310

---

INV-039  
BOM изделия: детали того же материала, что продукт; нет дублей detailId (DB unique + server).

Enforced: server `assertProductDetailsMaterial`; database ProductDetail `@@unique([productId, detailId])`

Used by: create/update Product

Source: `nomenclature.ts` ~L353–364; schema L305

---

INV-040  
skuOzon и skuWb обязательны как строки (schema NOT NULL), уникальность в БД **не** задана.

Enforced: database NOT NULL; server validateProduct  
database unique: нет

Used by: marketplace match

Source: schema Product L281–282

---

INV-041  
Номер детали не уникален и не используется как ключ потока — только detailId.

Enforced: by design schema comment L250–254; index non-unique

Used by: nomenclature, terminal

Source: schema Detail

---

INV-042  
Нельзя удалить изделие при связанных goals/ops/costs (guards в deleteProduct).

Enforced: server  
Used by: nomenclature  
Source: `nomenclature.ts:deleteProduct` ~L484–497

---

INV-043  
Простая закупка: nomenclatureId, qty>0, unitPrice≥0.

Enforced: server  
Used by: createSimplePurchase  
Source: `purchases.ts` ~L398–400

---

INV-044  
Часы > 0; railsTaken > 0; picks не пустые; employeeId обязателен на submit.

Enforced: server terminal  
Used by: submitHours/Torcovka/Prisadka/Upakovka

Source: `terminal.ts` ~L335–338, L650–652, L927–929, L976–978

---

INV-045  
Сессия терминала должна совпасть с employeeId в мутации (нельзя сабмитить «за другого»).

Enforced: server `requireTerminalEmployee(expectedEmployeeId)`  
Used by: submit*

Source: `session.ts` ~L79–81

---

INV-046  
Cron fetch-statements: без `CRON_SECRET` — 503; неверный Bearer — 401; сравнение timing-safe.

Enforced: server route  
Used by: host cron

Source: `src/app/api/cron/fetch-statements/route.ts` L29–38

---

INV-047  
Удаление торцовки **не** возвращает рейки в `remainingQuantity`; снятые заготовки уходят со склада; «взято сверх произведённого» становится отходом партии.

Enforced: server (явный комментарий + отсутствие increment remainingQuantity)

Used by: deleteProductionOperation TORCOVKA

Source: `production.ts` ~L374–375, L419–420

---

INV-048  
Тип операции не меняется после создания (нет updater type).

Enforced: отсутствие кода перехода  
database: enum на create

Used by: production

---

INV-049  
Накладные в себестоимости изделия: EXPENSE cashflows категорий `isOverhead` (ЗП производства по правилам v2 не должна быть в этой категории — категория задаётся справочником, не кодом payroll).

Enforced: data (`ArticleCategory.isOverhead`) + `getPeriodOverhead`  
database: Boolean flag

Used by: cost report

Source: schema ArticleCategory L564; `cost.ts:getPeriodOverhead` ~L162

---

INV-050  
Порог отхода в настройках валидируется при save.

Enforced: server `saveAppSettings`  
Used by: settings  
Source: `settings.ts` ~L132
