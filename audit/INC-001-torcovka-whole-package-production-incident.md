# INC-001 — TORCOVKA whole-package production incident

Status: `OPEN — PHYSICAL FACT REQUIRED BEFORE PROD CORRECTION`

Confirmed finding: `INC-001-F1 — TORCOVKA correction semantics after delete — P1 / CONFIRMED`

`ARCH-P1-001` is **unrelated** (UPAKOVKA quantity-edit inventory boundary). Do not conflate.

AUDIT 1 remains `COMPLETE / REVIEWED`. AUDIT 2 remains `NEXT AFTER INC-001`.

Date: 2026-09-09

Production data: **not corrected** in this document cycle. Forensics + correction design. No SQL UPDATE/DELETE, no restore, no deploy of application containment in the docs checkpoint.

| | |
| --- | --- |
| Worktree | `D:/dev/St-torcovka-incident` |
| Branch | `fix/torcovka-production-incident` |
| Docs BASE | `b08b98b5f67f7568a18f090c54b362f01c3426ff` |
| Prod app HEAD | `d9f940e8540801bdb27dd72210193f5e4ab038c3` |
| Prod DB | `stell22` on VPS, read-only forensics |
| `production_cost_flow` | **absent** → inactive |
| Mutations | **NONE** |

| | |
| --- | --- |
| Worktree | `D:/dev/St-torcovka-incident` |
| Branch | `fix/torcovka-production-incident` |
| `origin/main` | `b08b98b5f67f7568a18f090c54b362f01c3426ff` |
| Prod app HEAD | `d9f940e8540801bdb27dd72210193f5e4ab038c3` |
| Prod DB | `stell22` on VPS, `SET TRANSACTION READ ONLY` / `SHOW transaction_read_only = on` |
| `production_cost_flow` | **absent** → inactive (`isCostFlowActive` = false) |
| Mutations | **NONE** |

---

## 1. What the shop sees now

Live `ProductionOperation` count = **0** (any type).

Package **`ПАК-40-1280-01-7`** has `quantity = 1280`, `remainingQuantity = 0`. Terminal lists lots with `remainingQuantity > 0`, so this package is gone from the normal TORCOVKA catalog.

Batch **`Волочёк 31.08`** (`cmth51aog006dph2a1u1t9olf`) is still `IN_WORK`, `closedAt = null`, `frozenAt = null`. Other lots still have remainder, so `archiveBatchIfDepleted` did **not** close the batch.

Waste report (`getWasteReport`): live TORCOVKA taken/produced = 0, but purchased − remaining includes the missing rails. Those metres become `writtenOffM`. For consumed material with produced = 0 the batch waste **displays ~100%**.

That ~100% is the **post-delete stock picture**, not the waste% of the original submit (that was **72.98%**).

---

## 2. Candidate operations

Live TORCOVKA: **none**. Reconstruction is from `ChangeLog` + current `RailLot`.

| operationId | employee | createdAt (stored UTC naive) | batch | railLot | lotLengthM | oldRailsTaken | producedM | wasteM | wastePct | lotRemainingNow | batchStatus | closedAt | frozenAt | isPaid |
| ----------- | -------- | ---------------------------- | ----- | ------- | ---------: | ------------: | --------: | -----: | -------: | --------------: | ----------- | -------- | -------- | ------ |
| `cmtmj4dpi000srp29ek0iw37f` **DELETED** | UNKNOWN (not in ChangeLog) | 2026-09-04 05:44:30.838 | Волочёк 31.08 `cmth51aog006dph2a1u1t9olf` | `ПАК-40-1280-01-7` `cmth51aoh006sph2af5gg0l4x` | 4.0000 | **1280** | 1383.48 | 3736.52 | **72.98** | **0** | IN_WORK | null | null | false at delete |
| `cmtk83p9u0001ph1wgylff94z` DELETED | UNKNOWN | 2026-09-02 15:00:31.046 | same | `ПАК-40-1280-01-5` | 4.0000 | 410 | 1554.57 | 85.43 | 5.21 | 870 | IN_WORK | null | null | false at delete |
| `cmtis6x3y00a1ph2ap7nkk01x` DELETED | UNKNOWN | 2026-09-01 14:47:21.137 | same | `ПАК-40-1280-01-4` | 4.0000 | 420 | 1563.29 | 116.71 | 6.95 | 860 | IN_WORK | null | null | false at delete |

**Incident candidate = first row only.** It is the only op with `railsTaken = lot.quantity`, extreme waste, and `remainingQuantity = 0`.

The other two are ordinary ~5–7% TORCOVKA that were also later deleted (stored 2026-09-03 10:25 UTC). Their remaining was also not restored (INV-047). They are **related stock damage**, not this whole-package class. Do not auto-correct them in this incident.

Memory «внёс только несколько заготовок» / «отход ~100%» does **not** match the submit payload: ChangeLog has **3843** pcs × **0.36 m** SORT1 (one length, large qty). Submit-time waste was **72.98%**, not 100%. The ~100% is what the waste report shows **after delete**.

---

## 3. Full fact — `cmtmj4dpi000srp29ek0iw37f`

### ProductionOperation (reconstructed; row **does not exist**)

| Field | Value |
| ----- | ----- |
| id | `cmtmj4dpi000srp29ek0iw37f` |
| employeeId / employee | **UNKNOWN** — create ChangeLog has no employee; `userId` null |
| createdAt / workDate | stored `2026-09-04 05:44:30.838` (`timestamp(3) without time zone`, Prisma naive UTC → 08:44 MSK) |
| deletedAt | ChangeLog `cmtmjg74f0014rp29qpa1blgu` at `2026-09-04 05:53:42.160` (~9 min later) |
| batchId | `cmth51aog006dph2a1u1t9olf` |
| railLotId | `cmth51aoh006sph2af5gg0l4x` |
| railsTaken | **1280** |
| isPaid | false (delete would have thrown if paid) |
| clientRequestId | **UNKNOWN** (not in ChangeLog) |
| high-waste / ack / approval | **none** — submit predates `a5f901a` / `8240f4d`; `TorcovkaApproval` count = 0 |

ChangeLog create (`cmtmj4dpy000xrp29bfeo8i6p`):

```json
{
  "type": "TORCOVKA",
  "picks": [{ "sort": "SORT1", "lengthM": 0.36, "quantity": 3843 }],
  "batchId": "cmth51aog006dph2a1u1t9olf",
  "railLotId": "cmth51aoh006sph2af5gg0l4x",
  "railsTaken": 1280
}
```

### OperationDetailLine (from ChangeLog picks; rows deleted with the op)

| blankLengthM | blankType | blankSort | quantity | materialId |
| -----------: | --------- | --------- | -------: | ---------- |
| 0.36 | KANAVKA (lot.railType) | SORT1 | 3843 | batch.materialId (not in ChangeLog) |

`producedM = 0.36 × 3843 = 1383.48 m`

`takenM = 1280 × 4.0000 = 5120 m`

`wasteM = 3736.52 m`

`wastePct = 72.98%`

### RailLot now

| Field | Value |
| ----- | ----- |
| id | `cmth51aoh006sph2af5gg0l4x` |
| code | `ПАК-40-1280-01-7` |
| isPackage | true |
| lengthM | 4.0000 |
| railType | KANAVKA |
| sort | SORT1 |
| quantity (original) | **1280** |
| remainingQuantity | **0** |
| batchId | `cmth51aog006dph2a1u1t9olf` |

### Batch now

| Field | Value |
| ----- | ----- |
| name | Волочёк 31.08 |
| status | IN_WORK |
| closedAt | null |
| frozenAt | null |
| totalCost | 936556.00 (= purchaseCost) |

### BatchCost

**0 rows.** No PRELIMINARY/FINAL snapshot for this batch. Cost-flow inactive; freeze not applied.

### ChangeLog around the incident

| changedAt stored | entity | entityId | oldValues | newValues |
| ---------------- | ------ | -------- | --------- | --------- |
| 2026-09-04 05:44:30.838 | ProductionOperation | `cmtmj4dpi000srp29ek0iw37f` | | TORCOVKA create (payload above) |
| 2026-09-04 05:53:42.160 | ProductionOperation | `cmtmj4dpi000srp29ek0iw37f` | `{"type":"TORCOVKA","deleted":true}` | |
| No Batch archive/reopen in this window | | | | |

`userId` is null on both rows (terminal create has no admin user; delete log also stored null).

---

## 4. Damage mechanism

```text
1. Terminal submit: railsTaken = 1280 = full remaining/original package
2. Picks: 3843 × 0.36 m (producedM 1383.48 << takenM 5120)
3. Then-current submitTorcovka: INV-008 only (produced ≤ taken). No waste band.
4. railLot.updateMany remainingQuantity -= 1280 → remainingQuantity = 0
5. archiveBatchIfDepleted: SUM(remaining) over ALL lots of the batch still > 0
   → Batch.status stayed IN_WORK, closedAt stayed null
6. Waste at submit = 72.98% (EXTREME by today's policy)
7. ~9 min later: deleteProductionOperation
   - BlankStock -= 3843 (blanks reversed)
   - INV-047: rails NOT returned; remaining stays 0
8. Live ops = 0 → waste report writtenOffM includes 1280×4 m (+ 410/420 from the other deleted ops)
   → displayed batch waste ~100% of consumed metres
9. BatchCost: no row; totalCost unchanged
```

**ROOT CAUSE = old terminal accepted a full-package `railsTaken` with low yield; server had no high-waste gate; then ordinary TORCOVKA delete reversed blanks but left `RailLot.remainingQuantity = 0` (INV-047), so the package vanished and the waste report now treats those metres as write-off (~100%).**

Not merely «worker mistake»:

| Hypothesis | Evidence |
| ---------- | -------- |
| Old UI defaulted to whole package | **No.** Current and 01.4: dialog `initial = 0`. `max = remainingQuantity` (1280). Worker (or a max/fill) entered 1280. |
| No high-waste protection in old code | **Yes.** Incident 2026-09-04 05:44. Guard landed `a5f901a` 2026-09-04; admin EXTREME `8240f4d` 2026-09-05. Prod at incident = pre-guard. |
| Stale draft / bad draft restore | **No evidence.** ChangeLog payload is a coherent single-length submit. Draft not required to explain 1280. |
| `archiveBatchIfDepleted` archived the batch | **No.** Batch still IN_WORK. |
| Worker-only silent confirm of ~73% waste | **Yes, then.** Today that band is EXTREME. |

---

## 5. Recurrence on current `main` / prod app `d9f940e`

Guards now in `submitTorcovka` + `decideTorcovkaSubmit`:

- `wastePct ≥ 20` → `ACK_REQUIRED` SUSPICIOUS (worker ack, no write)
- `wastePct ≥ 50` → EXTREME → admin HMAC approval, no write until verified
- 72.98% and ~100% are both EXTREME
- Rails dialog still starts at 0; title «Сколько реек вы взяли в работу?»; `max = remaining`
- Draft restore recomputes metrics; cannot skip the server gate

**RECURRENCE CURRENTLY BLOCKED = YES** for the original silent worker-submit class.

Residual (by design, not a missing 01.5 guard):

- Worker can still **type** `remainingQuantity` (whole package). Commit now needs admin EXTREME code.
- `deleteProductionOperation` still does not return rails (INV-047). A later admin delete of a *legitimate* high-waste op would recreate this stock hole.

No extra application patch in this cycle: the historical row is already gone; the silent-submit hole is closed.

---

## 6. Existing correction path `correctTorcovkaRailsTaken`

Inactive-cost-flow branch (`src/server/production.ts`, after `isCostFlowActive` is false):

| # | Required behavior | Inactive path |
| - | ----------------- | ------------- |
| 1 | Lock operation then lot then batch | YES: `lockProductionOperations` → `lockRailLots` → `lockBatches` |
| 2 | Only decrease `railsTaken` | YES: `newRailsTaken < oldRailsTaken` |
| 3 | `producedM ≤ newRailsTaken × lot.lengthM` | YES |
| 4 | Return `old − new` to `RailLot.remainingQuantity` | YES increment |
| 5 | Update `ProductionOperation.railsTaken` | YES |
| 6 | ChangeLog with reason | YES (`field`, `oldRailsTaken`, `newRailsTaken`, `deltaReturned`, `reason`) |
| 7 | If remaining > 0: `Batch.status = IN_WORK`, `closedAt = null` | YES (batch here is already IN_WORK) |
| 8 | `enqueueRecalcBatchCosts` | YES |
| 9 | revalidate `/production`, `/reports`, `/purchases`, layout | YES (`PATH = /production`) |
| 10 | Works with inactive cost flow | YES — this is the else branch |
| 11 | Payroll | TORCOVKA wage = Σ blank qty × sort rate (`operationEarning`). **Does not use `railsTaken`.** Lines untouched → wage unchanged **if the op still existed**. |
| 12 | Does not recreate blanks | YES — no `BlankStock` / line writes |

Inactive-path **blockers that are missing vs active path**:

- **`isPaid` is not checked** on the inactive branch (active branch throws).
- **`assertTorcovkaBlankInventoryBoundary` is not called** on the inactive branch (active branch does).

Inactive **does** check `batch.frozenAt`.

**For this incident the path cannot run:** there is **no** `ProductionOperation` row. Generic correction cannot restore a deleted op. 01.5 §16 already recorded that.

`EXISTING CORRECTION PATH SAFE = BLOCKED` — missing operation row. Do not bypass with raw SQL this cycle.

---

## 7. `newRailsTaken` is not proven

```text
MIN_PHYSICALLY_POSSIBLE_RAILS = ceil(1383.48 / 4.0000) = ceil(345.87) = 346
ACTUAL_RAILS_TAKEN = UNKNOWN
```

Do **not** set `newRailsTaken = 346`. That is only the INV-008 floor.

Sources that could prove the fact (none collected in this pass):

1. Worker statement (who took the package that night)
2. Shop journal / verbal count
3. **Physical remainder of `ПАК-40-1280-01-7`** (count rails still in the pack; `factualTaken ≈ 1280 − physicalRemaining`)
4. Neighbor TORCOVKA on similar 4 m / 1280 packs: 410 and 420 rails with 5–7% waste — **analogy, not proof**
5. ChangeLog/draft: ChangeLog only has the erroneous 1280; no draft row
6. Photos / labels / another system — none in DB

Until a physical count (or worker statement) exists, **do not call** `correctTorcovkaRailsTaken` and **do not** invent `newRailsTaken`.

---

## 8. Correction plan (NOT executed)

```text
INCIDENT OPERATION:
cmtmj4dpi000srp29ek0iw37f
(DELETED — row absent)

OLD railsTaken:
1280

CURRENT RailLot.remainingQuantity:
0

PRODUCED:
1383.48 m   (3843 × 0.36; blanks reversed on delete)

RAIL LENGTH:
4.0000 m

MIN POSSIBLE railsTaken:
346

FACTUAL railsTaken:
UNKNOWN

DELTA TO RETURN:
UNKNOWN   (would be 1280 − factual IF the op still existed)

CURRENT BATCH STATUS:
IN_WORK (closedAt null, frozenAt null)

EXPECTED BATCH STATUS AFTER CORRECTION:
IN_WORK
```

Prepared call — **not valid until the operation exists again AND factual R is known**:

```text
correctTorcovkaRailsTaken({
  operationId: "cmtmj4dpi000srp29ek0iw37f",
  newRailsTaken: <FACTUAL, integer, 346..1279>,
  reason: "Исправление production incident: до внедрения защиты терминал списал весь пакет при частично внесённой торцовке",
})
```

**Do not run.** Recreating the deleted op first would also re-receive 3843 blanks into `BlankStock` and re-open payroll for that output. That is a **different** mutation than rails correction and needs a separate owner decision.

Related unrepaired INV-047 holes (out of scope unless owner expands INC-001):

- `ПАК-40-1280-01-4` remaining 860 = 1280 − 420
- `ПАК-40-1280-01-5` remaining 870 = 1280 − 410

---

## 9. BEFORE / EXPECTED AFTER

Assumes a hypothetical live op still present and a known factual `R`. **Not applicable until the row exists.**

| Fact | Before (now) | Expected after rails correction |
| ---- | -----------: | ------------------------------: |
| ProductionOperation.railsTaken | **no row** (was 1280) | R (only if row restored) |
| RailLot.remainingQuantity | 0 | 1280 − R |
| producedM | 0 live (was 1383.48, then reversed) | unchanged by rails correction |
| wasteM | n/a live; report writtenOff includes 5120 m | takenM = R×4; waste = taken − produced **if op restored** |
| wastePct | batch consumed ~100% writtenOff | no longer 100% of those metres as write-off |
| Batch.status | IN_WORK | IN_WORK |
| Batch.closedAt | null | null |
| Batch.totalCost | 936556.00 | unchanged by railsTaken (cost flow inactive; no BatchCost row) |
| BatchCost PRELIMINARY | none | still none unless recalc creates one |
| employee wage | 0 (op deleted; earning is from blanks not rails) | unchanged by railsTaken if op+lines exist |

Wage source: `src/lib/payroll.ts` `operationEarning` TORCOVKA branch — quantity/amount from `OperationDetailLine` sort rates only.

---

## 10. Inventory boundary

| Fact | Value |
| ---- | ----- |
| CONDUCTED inventories | 1: `cmr8v3qm1001tms2a9ihe2whw` date **2026-07-06**, **0 lines** |
| After TORCOVKA 2026-09-04? | **NO** |
| BlankStock qty ≠ 0 | **none** (8 rows, all quantity 0) |
| Inactive correction checks inventory? | **NO** |
| Active correction would check DETAIL refs matching blank spec | N/A — no later CONDUCTED lines |

**INVENTORY BOUNDARY BLOCKER = NO**

Do not bypass guards with SQL. This incident is blocked by **missing operation**, not by inventory.

---

## 11. Unresolved — physical facts still required

Do **not** infer:

1. **Physical remaining rails** in `ПАК-40-1280-01-7` (owner/factory count). `ACTUAL_RAILS_TAKEN = 1280 − PHYSICAL_REMAINING` only after that count.
2. **Whether 3843 × 0.36 m SORT1 blanks were physically produced** (Scenario A vs B).
3. **Employee identity** — not recoverable from DB/logs (see §15).

Also open, out of this incident’s write unless owner expands scope:

- INV-047 holes on `ПАК-40-1280-01-4` / `01-5` (410/420 rails, ~5–7% waste ops deleted 2026-09-03).

---

## 12. Forensics pass (earlier this cycle)

| Action | Result |
| ------ | ------ |
| Prod mutations | NONE |
| Application code | NOT CHANGED |
| Commit | NO |
| Push | NO |
| Deploy | NO |

---

## 13. Delete semantics — `deleteProductionOperation` TORCOVKA (current `main` / prod `d9f940e`)

Admin-only. Cost flow was **inactive**, so the inactive branch ran (and would still run).

Evidence: `src/server/production.ts` (`deleteProductionOperation`), `prepareTorcovkaBlankMutation`, `maybeFreezeBatch`, `enqueueRecalcBatchCosts` → `recalcBatchCosts`, `src/server/reports.ts` `getWasteReport`.

JSDoc and INV-047 are explicit: rails are **intentionally not** returned.

| Entity | Before this delete | Delete effect |
| ------ | ------------------ | ------------- |
| `ProductionOperation` | Row `cmtmj4dpi000srp29ek0iw37f`, type TORCOVKA, `railsTaken=1280`, `isPaid=false` | **Row deleted** after lines. Throws if `isPaid`. |
| `OperationDetailLine` | 1 line: 3843 × 0.36 SORT1 | **`deleteMany` by operationId** |
| `BlankStock` | After submit: key `mat_default_hvoya` + `0.36` + `KANAVKA` + `SORT1` had **at least 3843** (delete uses `quantity >= line.qty`) | **`quantity -= 3843`**. Throws «заготовки уже прошли присадку/упаковку» if not enough. **No ChangeLog on BlankStock.** |
| `RailLot.remainingQuantity` | 0 after submit (`1280 − 1280`) | **Unchanged (stays 0).** Intentional. No `increment`. |
| `Batch.status` | `IN_WORK` | **Unchanged.** `maybeFreezeBatch` no-ops unless `closedAt` set. `archiveBatchIfDepleted` is **not** called on delete. |
| `Batch.closedAt` / `frozenAt` | null / null | **Unchanged** |
| `BatchCost` | After submit recalc: PRELIMINARY from that TORCOVKA (or none if snapshot empty). Now **0 rows** | After TX: `enqueueRecalcBatchCosts(batchId)` → `recalcBatchCosts` deletes PRELIMINARY; with **0** live TORCOVKA `computeBatchSnapshot` is null → **no new row**. |
| payroll / `isPaid` | Unpaid; `Payment` count now 0 | Op gone → **no earning**. Wage formula never used `railsTaken`. |
| `ChangeLog` | Create payload with picks/`railsTaken` | `{ type, deleted: true }` on same `entityId`. `userId` null. **Does not store employee, lines, or remaining.** |

Also: `revalidatePath("/production")` and `"/reports"` only — **not** `/purchases`.

### Waste report after delete

`takenM` from live TORCOVKA = 0. `writtenOffM = purchasedM − remainingM − takenM`. Remaining of this lot is 0, so **5120 m** of this package is write-off. With produced = 0, consumed waste **displays ~100%**. Notification `system:waste-high` «Волочёк 31.08 — 100%» already existed from the **2026-09-03** deletes of the other two ops; this incident added more write-off metres.

---

## 14. Downstream after `2026-09-04 05:44:30` UTC

**BlankStock key:** `materialId=mat_default_hvoya` (`Хвоя`) + `lengthM=0.3600` + `detailType=KANAVKA` + `sort=SORT1`  
Row: `cmtis6x4600a7ph2ae8yvybwd` (created by the **earlier** Sep 1 TORCOVKA on a different lot, same spec).

| When | Qty on this key | Evidence |
| ---- | --------------: | -------- |
| After Sep 1 TORCOVKA `cmtis6x3y…` | +1194 then | ChangeLog picks; row id prefix `cmtis6x46` |
| After Sep 3 10:25 delete of that op | 0 | delete reverse; live ops 0 |
| Immediately after INC-001 submit 05:44 | **≥ 3843** (expected 3843 if start was 0) | submit upsert increment; delete 9 min later succeeded ⇒ `quantity >= 3843` at 05:53 |
| Delete delta 05:53 | **−3843** | `updateMany` decrement; delete completed |
| Later TORCOVKA additions | **none** | live `ProductionOperation` count = 0; no ChangeLog TORCOVKA after 05:53 |
| Later PRISADKA / UPAKOVKA consumption | **none** | 0 live ops, 0 leftover lines, `DetailStock` empty |
| Inventories after op | **none** | only CONDUCTED `2026-07-06`, 0 lines |
| **Current DB quantity** | **0** | SELECT 2026-09-09 |

9-minute window: if anything had consumed those blanks before delete, delete would have thrown. It did not.

Catalog details for 0.36 / KANAVKA / SORT1 all **require prisadka**. No PRISADKA operations exist. Those blanks could not have become `DetailStock` **in the system**.

`DOWNSTREAM DEPENDENCY = NONE` (application). Physical off-system use of 3843 pcs remains **UNKNOWN** and is the same owner check as Scenario A vs B — not a later recorded operation.

---

## 15. Employee recovery (read-only)

Searched: ChangeLog create/delete (`userId` null, no `employeeId`); live ops (none); `SystemLog` (mail fetch only); `Notification`; `Payment` (0); `TorcovkaApproval` (0); `clientRequestId` (not stored); docker `stell22-app` logs since 2026-09-01 (no op id / package code). Nearby deleted TORCOVKA ChangeLogs also lack employee.

`EMPLOYEE FACTUALLY RECOVERABLE = NO`

Do not guess from the employee roster.

Scenario B **cannot write** until the owner names the worker.

---

## 16. Correction scenarios (NOT implemented, NOT executed)

Choose **after** factory facts. Do not mix A and B.

### SCENARIO A — 3843 blanks were **not** physically produced

Deleted TORCOVKA should stay gone. Do **not** restore lines/BlankStock. Align `RailLot.remainingQuantity` to **owner-confirmed physical count**.

Target: `remainingQuantity = PHYSICAL_REMAINING_RAILS` (integer, `0..1280`). Not `ceil(producedM/lengthM)`.

One-off admin application action (not raw SQL, not a generic UI): e.g. `repairInc001RailLotPhysicalRemaining`.

Guards:

- `requireAdmin()`
- allowlist `railLotId === cmth51aoh006sph2af5gg0l4x`
- `lot.batchId === cmth51aog006dph2a1u1t9olf`
- `lot.remainingQuantity === 0` (expected-current-value)
- `batch.frozenAt === null`
- inventory: no CONDUCTED inventory dated after the incident on affected refs (today: none; still check)
- `PHYSICAL_REMAINING_RAILS` integer in `0..lot.quantity` (1280)
- idempotency: refuse if remaining ≠ 0 **or** incident marker already applied (`Setting` key e.g. `incident:INC-001:scenario-A` / ChangeLog with `incidentId=INC-001` + this lot). If physical remaining is 0, the remaining-guard alone is not enough — require the marker.
- lock lot then batch (same order family as other lot writers)

Writes:

- `RailLot.remainingQuantity = PHYSICAL_REMAINING_RAILS` (set, not blind increment)
- ChangeLog entity `RailLot`, entityId lot id, `{ incidentId: "INC-001", deletedOperationId, oldRemaining: 0, newRemaining, reason }`
- `enqueueRecalcBatchCosts(batchId)` (PRELIMINARY still none without TORCOVKA; waste/`writtenOffM` **will** change)
- revalidate `/purchases`, `/production`, `/reports`, layout

Does **not** create payroll. Does **not** call `submitTorcovka`. Does **not** reopen archive (already `IN_WORK`).

If physical remaining is 1280, the package returns to the terminal catalog. If 0, Scenario A is a no-op on remaining (package correctly empty) and write-off stays; that still needs an explicit owner “all 1280 rails gone, no blanks” confirmation plus the idempotency marker.

### SCENARIO B — 3843 blanks **were** physically produced

RailLot-only fix is insufficient. Must restore **factual rail consumption** and **3843 blanks**. Employee + factual `railsTaken` (`R`, integer, `346..1280`) required before write. Original op unpaid; restoring it **will** create wage once (currently 0 — not a double pay). Skip terminal high-waste/approval (`submitTorcovka` must not be used).

Current remaining is 0 (= treated as 1280 consumed). After repair: remaining = `1280 − R`, BlankStock += 3843, one TORCOVKA fact with `R` and the original output line.

#### Option B1 — dedicated incident restoration transaction

Single admin TX, not terminal submit:

- lock op-id (none) / lot / batch
- guards: same lot/batch/frozen/remaining===0/inventory; `R` in range; `producedM=1383.48 <= R×4`; employeeId required; refuse if `ProductionOperation` id already exists; refuse if incident marker applied
- `INSERT ProductionOperation` with **original id** `cmtmj4dpi000srp29ek0iw37f`, `workDate`/`createdAt` = original `2026-09-04 05:44:30.838`, `railsTaken=R`, `isPaid=false`, snapshots from **current** employee rates (historical rates unknown — document that), `clientRequestId` = synthetic unique `inc-001-restore:cmtmj4dpi000srp29ek0iw37f` because original request id is **lost**
- `INSERT` line 3843 × 0.36 KANAVKA SORT1 `blankMaterialId=mat_default_hvoya`
- `BlankStock` increment 3843 on the known key
- `RailLot.remainingQuantity = 1280 − R` (from 0)
- ChangeLog: restore + `incidentId`, `originalOperationId`, `oldRemaining`, `newRemaining`, `R`, reason
- recalc + revalidate including `/purchases`

Honest gap: `clientRequestId` is not the original; rate snapshots are not the 2026-09-04 capture (DI-015 landed later). Document both.

#### Option B2 — replacement TORCOVKA (new id)

Same stock math. New `ProductionOperation.id`. `workDate` still original. ChangeLog references `originalOperationId=cmtmj4dpi…`. Synthetic `clientRequestId` `inc-001-replace:…`. Journal shows a **new** row, not the deleted id.

| | B1 | B2 |
| - | -- | -- |
| Journal identity | Original id reused | New id |
| `clientRequestId` | Synthetic either way (original unknown) | Synthetic |
| Risk of colliding with a resurrected unique id | Low (id unused) | None |
| Honesty | “Restore” with a fake request id | Explicit replacement |
| Payroll | One unpaid earning on restored/new op | Same |

**Prefer B1** only if the owner wants the production journal id to match ChangeLog history. **Prefer B2** if we must not reuse a deleted primary key. Either is valid; both are dedicated incident TX, not `submitTorcovka`.

Do **not** implement until physical facts + employee + chosen option exist.

`correctTorcovkaRailsTaken` stays irrelevant until a live TORCOVKA row exists.

---

## 17. Generic TORCOVKA delete — still the right default?

Two business cases:

**A. ERRONEOUS DATA ENTRY** — physical cut did not happen / amount overstated. Need to restore rails (and not leave blanks). Current delete does the **wrong** half: reverses blanks (good if they were never made) but **keeps** rail consumption (bad).

**B. REAL PHYSICAL TORCOVKA** — cut happened; journal row is wrong or being cleaned up. Rails must **stay** consumed (INV-047). Current delete matches this if blanks should also come off stock.

**GENERIC DELETE SHOULD CHANGE = NEEDS OWNER DECISION.**

Recommended hypothesis (not implemented): **do not** change generic delete to “always return rails”. Keep INV-047 for physical cuts. Add a **distinct** admin verb for cancel-erroneous TORCOVKA (return rails + reverse blanks, with reason), vs historical delete / `correctTorcovkaRailsTaken` while the row still exists.

This incident is case A **or** B depending on factory facts — that is why Scenario A/B is a branch, not a default code change.

---

## 18. Incident-derived finding

Not `ARCH-P1-001`. Not a reopen of DI-020 (high-waste guard; already on `main`). 01.5 §16 recorded the deleted row as out of migrate scope; this finding is the **missing application recovery path** after that delete.

| | |
| --- | --- |
| ID | `INC-001-F1` |
| Title | TORCOVKA correction semantics after delete |
| Statement | Deleting an erroneous TORCOVKA reverses produced `BlankStock` but intentionally does not restore `RailLot` consumption, leaving **no application path** to recover a falsely consumed package once the operation row is gone. |
| Classification | `CONFIRMED` (production impact) / `NEEDS BUSINESS DECISION` on generic delete vs dedicated cancel |
| Severity | **P1** — live package `ПАК-40-1280-01-7` is missing from terminal; batch waste displays ~100% of consumed metres; `correctTorcovkaRailsTaken` cannot run |
| Impact | Inventory / production flow / waste reporting. Not money freeze (`frozenAt` null, cost flow inactive). |
| Remediation | Incident Scenario A or B (one-off) first; optional later distinct cancel-erroneous verb. Do not silently invert INV-047. |

---

## 19. Design pass (this document revision)

| Action | Result |
| ------ | ------ |
| Prod mutations | NONE |
| Application code | NOT CHANGED |
| PROJECT.md | YES (priority INC-001; AUDIT 2 deferred) |
| Commit | NO |
| Push | NO |
| Deploy | NO |

Status: `OPEN — PHYSICAL FACT REQUIRED BEFORE PROD CORRECTION`

Next: owner/factory answers the three physical facts; ChatGPT reviews Scenario A vs B before any production write.
