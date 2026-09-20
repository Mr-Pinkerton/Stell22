# Stell22 — Project Journal / Source of Truth

Updated: 2026-09-19

This file answers three questions:

1. what is already decided/done;
2. where the project is now;
3. what happens next.

Statuses: `ACCEPTED`, `IMPLEMENTED`, `TESTED`, `PLANNED`, `BLOCKED`, `OPEN`, `UNVERIFIED`.

## 1. Domain

`ACCEPTED`

Stell22 is an internal ERP/MES for **rack/shelving manufacturing (производство стеллажей)**.

It is a separate domain from Woodveri door manufacturing. Do not import door-specific entities, routes, WIP assumptions, nomenclature, or business rules unless explicitly requested by the owner.

## 2. Product goal

Stell22 should connect the real production flow:

`order -> production -> employee output -> inventory/WIP -> purchases/batches -> cost -> finished goods -> shipment -> money`

The system is not only a status tracker. Production facts must remain reconcilable with material movement, payroll/output, inventory and cost accounting.

## 3. Canonical source hierarchy

1. GitHub `main`: current code + committed audit documents. **This is canonical truth.**
2. This `PROJECT.md`: owner decisions, package/deploy/activation status and current next step — **on `main`**.
3. `audit/AUDIT-INDEX.md`: audit navigation/status.
4. `/Projects/Stell22` Library snapshot: cross-chat recovery/cache.
5. Chat/Cursor transcripts: working evidence only.

If sources conflict, verify the actual GitHub `main` and record the divergence.

A Cursor/chat statement without a committed project artifact is not canonical.

## 4. Current verified technical checkpoint

Repository: `Mr-Pinkerton/Stell22`

Branch: `main`

Last verified production application SHA:

`eb02b17f488ef9ec13a11dcf158fc169b78e3e37`

Evidence: GitHub Production Deploy run `35337215903` SUCCESS (2026-09-18, `workflow_dispatch`). R-06 Inventory physical identity **DEPLOYED / POST-DEPLOY VERIFIED**. Migration `20260918130000_psr_p2_r06_inventory_line_identity` **APPLIED**. Index `InventoryLine_inventoryId_refType_refId_key` **LIVE**. InventoryMovement rows remain 0. Production has **no deployed runtime writers**. Source/main Inventory `conductInventory` writer is **CONNECTED / MERGED / NOT DEPLOYED** (`audit/08.14`). `inventory_movement_shadow_write` ABSENT in production. `production_cost_flow` **INACTIVE**. PSR-P2 dual-write **NOT STARTED**. Always verify current GitHub `main` HEAD. A later docs-only merge may advance `main`; that merge SHA is **not** a production application SHA.

Prior documented production application SHA:

`27538a5d5777d33fb87d060963a6d07a189cf044` — Production Deploy `35329071777` SUCCESS (2026-09-18). R-05 TORCOVKA correction identity **DEPLOYED**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`c14a58641d57dfabfce223b2c213db9c86167ca4` — Production Deploy `35314440036` SUCCESS (2026-09-18). R-04 Supply cycle identity **DEPLOYED**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`de2e1c015423e7b848f0583c0e75b2abb12733d9` — Production Deploy `35257469956` SUCCESS (2026-09-17). PSR-P2 general preconditions (`PSR-Q-004` / R-07 / R-10 / R-11) **DEPLOYED DORMANT**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`92532e818df41160b434caac2c6d94933e93d810` — `Merge pull request #7 from Mr-Pinkerton/feat/psr-p1-inventory-movement-shadow-schema`. Production Deploy `35228794988` SUCCESS (2026-09-17). PSR-P1 empty SHADOW schema. **Historical.** Do not rewrite.

That deploy includes:

- PSR-P1 empty `InventoryMovement` SHADOW schema (`20260917150000_psr_p1_inventory_movement_shadow`); production row count = **0**;
- OPS-CORR-01 Production Traceability v1 (PR #3);
- INC-001 generic TORCOVKA-delete containment (`3608b36`, still in effect);
- UI filter work;
- TORCOVKA BlankStock length canonicalization and railsTaken correction hardening (PR #1).

PSR-P1 = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY**. No runtime `InventoryMovement` writers. `PSR-Q-004` / R-07 / R-10 / R-11 remain **DEPLOYED DORMANT** (`audit/08.07`). R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.08`; Production Deploy `35314440036`). R-05 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.09`; Production Deploy `35329071777`). R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`; Production Deploy `35337215903`). PSR-P2 dual-write **NOT STARTED**.

Prior documented production application SHA:

`0686d0036da52cc32aaff531c91f1dd2ded899ec` — `Merge pull request #3 from Mr-Pinkerton/feat/ops-corr-01-traceability-v1`. Production Deploy `35204366279` SUCCESS (2026-09-17). **Historical.** Do not rewrite.

Earlier documented production application SHA:

`71a01b40008cf6da7cbc843b3b0dbaa31cf01853` — `Merge pull request #1 from Mr-Pinkerton/integration/p2025-di020`. Production Deploy `34635510843` SUCCESS (2026-09-11). **Historical.** Do not rewrite.

Earlier documented prod SHA (containment-only):

`3608b36bd324a5118f4ba5b1bbb21462cc0723d9` — `fix: block generic torcovka delete`

Earlier pre-incident application checkpoint:

`d9f940e8540801bdb27dd72210193f5e4ab038c3` — `fix: enforce prisadka inventory boundary`

Cost-flow / activation state at the current checkpoint:

- Cost flow Package 2/3: committed / **deployed dormant**;
- `production_cost_flow` **INACTIVE**;
- bootstrap not applied;
- business money initialization not performed;
- activation remains **BLOCKED** (`ARCH-P1-001` OPEN on the ACTIVE path);
- Close Month: **NOT IMPLEMENTED**.

Always establish current HEAD before starting new work.

## 5. Current work mode

`ACTIVE MODE: PSR-P2 RAW IDENTITY PREREQUISITE — IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED`. Artifact: `audit/08.19`. Supply writer closeout: `audit/08.18` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**). Canonical contract: `audit/08.11` (**ACCEPTED / REVIEWED**). Supply prerequisite on `main`: `audit/08.17` (**COMPLETE / NOT DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**). R-05 correction writer closeout on `main`: `audit/08.16` (PR #26; accepted head `c9d3c0b`; merge `debafda`; exact-head CI `35443727340`; post-merge CI `35444256886`). Terminal production writers on `main`: `audit/08.15` (PR #24; accepted head `1367e30`; merge `853db69`; exact-head CI `35439899641`; post-merge CI `35440444019`). Inventory writer closeout on `main`: `audit/08.14` (PR #22; accepted head `c58131c`; merge `2fd138e`; accepted CI `35427250317`; post-merge CI `35427681739`). P2-GUARD/CI: `audit/08.12` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; PR #18; accepted head `91c7e3e`; merge `643c796`; post-merge CI `35373616566`). Prerequisite closeout: `audit/08.13` (PR #20; accepted head `1f8b1d6`; merge `4dfaae2`; post-merge CI `35422069460`). R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`; production `eb02b17`; Production Deploy `35337215903`). R-05 identity prerequisite remains **DEPLOYED** (`audit/08.09`). R-04 remains **DEPLOYED** (`audit/08.08`). `PSR-Q-004` / R-07 / R-10 / R-11 remain **DEPLOYED DORMANT**. Source/`main` connected physical InventoryMovement contours = **Inventory conduct + normal TORCOVKA / PRISADKA / UPAKOVKA + R-05 `correctTorcovkaRailsTaken` + Supply deduction / Ozon restore**. Production writer currently live = **NO**. PSR-P2 dual-write **NOT STARTED**. This mode is **not** SHADOW activation, **not** dual-write, **not** Correction Center, and **not** AUDIT 2. **NEXT = PSR-P2 RAW IDENTITY PREREQUISITE PRODUCTION DEPLOYMENT PACKAGE**.

AUDIT 1 (system architecture) remains `COMPLETE / REVIEWED`. **Do not change AUDIT 1 status. Do not reopen AUDIT 1.**

`AUDIT 2 — FINANCE & MONEY INTEGRITY` is **NOT STARTED**. It remains `NEXT AFTER INC-001`. ARCH-2 does **not** silently start AUDIT 2.

INC-001 remains `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION`. Containment is still in the running production tree (first deployed at `3608b36`; still present on current application `eb02b17`). Do not treat ARCH-2 / PSR-P0-CORR as a production-data fix. Do not automatically invert INV-047 (generic TORCOVKA delete returning rails).

**ARCH-2 / Primary-System Readiness** (`audit/08.02-primary-system-readiness-architecture.md`): **`ACCEPTED / REVIEWED`**.

Independent Review #1 = REQUEST CHANGES (R1…R6 **CLOSED / PASS**). Independent Review #2 = REQUEST CHANGES (R7…R8 **CLOSED / PASS**). Independent Review #3 = **PASS / ACCEPT**. New blockers = 0.

`ACCEPTED / REVIEWED` means the **architecture contract** is accepted. It does **not** mean PSR implementation complete, primary-system readiness achieved, ledger deployed, paper removable, or `production_cost_flow` active.

PSR-P0-CORR (`audit/08.03-psr-p0-correction-history-contract.md`): **ACCEPTED DESIGN / NOT IMPLEMENTED**. Target = `ProductionOperationMutation` (CommandExecution not used for this contour). Schema **not** implemented. Correction Center **not** implemented. Cancellation **DEFERRED / NOT IMPLEMENTED**.

PSR-P0-CORE = **ACCEPTED DESIGN / NOT IMPLEMENTED** (`audit/08.04`; canonical through the reviewed docs merge). Closes remaining PRE-SCHEMA questions. Canonical design; **not** runtime implementation.

PSR-P1 schema contract = **ACCEPTED DESIGN** (`audit/08.05`; historical contract-creation status **ACCEPTED DESIGN / NOT IMPLEMENTED** is preserved in that file). Independent Review #1 = **PASS WITH NON-BLOCKING FINDINGS** (P0=0, P1=0). Current implementation/deploy = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`). Empty unused SHADOW-capable table in production; row count = **0**. Production has **no deployed runtime writers**.

`PSR-Q-001` / `PSR-Q-002` / `PSR-Q-005` / `PSR-Q-007` / `PSR-Q-008` = **CLOSED / ACCEPTED**.

`PSR-DESIGN-001` / `PSR-DESIGN-002` = **CLOSED / ACCEPTED**.

NEXT = **PSR-P2 RAW IDENTITY PREREQUISITE PRODUCTION DEPLOYMENT PACKAGE**. Raw identity prerequisite = `audit/08.19` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; PR #33; accepted head `919a427`; merge `76131ca`; exact-head CI `35499639266`; post-merge CI `35500149127`). Supply SHADOW writer = `audit/08.18` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**; PR #31; accepted head `2e90060`; merge `164ffca`; exact-head CI `35493552025`; post-merge CI `35493953060`). Supply prerequisite = `audit/08.17` (**COMPLETE / NOT DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**). R-05 correction writer = `audit/08.16` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**). Terminal production writers = `audit/08.15` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**). R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`). Inventory writer prerequisite = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED** (`audit/08.13`). Inventory SHADOW writer on `main` = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED** (`audit/08.14`). This is **not** SHADOW activation, **not** dual-write activation, **not** Correction Center implementation, and **not** AUDIT 2. Do not start the next writers from this file. Do not deploy. `PSR-Q-003` remains before P4. `PSR-Q-006` remains before P6.

## 5.1 Temporary operational rule — TORCOVKA delete

`ACCEPTED` until an explicit erroneous-cancellation flow exists:

**`DO NOT DELETE TORCOVKA OPERATIONS`**

Reason: generic TORCOVKA delete reverses produced `BlankStock` but **intentionally does not restore** `RailLot` remaining quantity (`INC-001-F1`). That is how `ПАК-40-1280-01-7` vanished from the terminal after the incident op was deleted.

Correction of a **live** TORCOVKA must use existing correction actions (`correctTorcovkaRailsTaken`, line quantity edit), not delete.

This rule remains operational. Application containment is **deployed in production** (first at `3608b36`; still present on current application `eb02b17`): the server rejects generic TORCOVKA delete before any mutation. That does **not** restore `ПАК-40-1280-01-7` and does **not** implement `cancelErroneousTorcovka`. Do not treat containment as a production-data fix. Cancellation remains deferred (`audit/08.03` §9).

`ARCH-P1-001` is unrelated to INC-001.

## 6. Cursor / ChatGPT working model

`ACCEPTED`

The owner prefers to work primarily in **Cursor**.

### Cursor

Cursor is the repository workstation. It should:

- inspect the actual checkout;
- establish branch/HEAD/clean state;
- perform audits against the repository;
- implement only approved remediation packages;
- run tests/checks;
- write/update project audit documents.

### ChatGPT

ChatGPT is the review/orchestration layer. It should:

- restore project context;
- inspect Cursor reports and evidence;
- look for errors, missing cases and contradictions;
- challenge architecture/business invariants;
- accept/reject findings and patch results;
- prepare the next precise Cursor prompt;
- maintain continuity across chats.

## 7. Mandatory Cursor evidence contract

Every substantial Cursor audit/patch response must report:

- repository and branch;
- BASE SHA before work;
- resulting HEAD SHA if committed, otherwise `NOT COMMITTED`;
- clean/dirty state;
- exact changed files;
- factual findings/change summary;
- tests/checks run and results;
- schema/migration/bootstrap/gate impact;
- deploy/activation impact;
- blockers/open questions;
- recommended next step.

For an audit, include exact code paths/evidence for material findings.

## 8. Audit completion rule

An audit section is `DONE` only when:

1. it was performed against a real identified BASE SHA;
2. results are written under `audit/*.md` in the repository;
3. the audit artifact is committed and pushed;
4. `audit/AUDIT-INDEX.md` is updated when audit structure/status changes;
5. this `PROJECT.md` is updated when owner decisions, blockers, package/deploy/activation state or next step change.

Cursor-only/chat-only output = `UNVERIFIED / NOT CANONICAL`.

## 9. Delivery / deploy gate

`ACCEPTED`

Before **every production deploy of a patch**:

1. implementation/factual review must be complete;
2. run a separate adversarial review in Cursor using **Claude**;
3. Claude reviews the final deploy candidate, not an obsolete earlier diff;
4. if Claude requests any code change, apply it and repeat Claude review;
5. deploy is allowed only after final Claude verdict `PASS / GO` or equivalent explicit no-blocker conclusion;
6. record Claude review and deploy result here.

The Claude deploy gate is not required for audit-only document work that does not deploy application code.

## 10. Current known cost-flow state

At the last verified application checkpoint:

- Cost flow Package 2: `IMPLEMENTED`;
- Cost flow Package 3: `COMMITTED / DEPLOYED DORMANT`;
- Package 3 architecture/factual review: `PASS`;
- Package 3.1 PRISADKA inventory-boundary hardening: `DEPLOYED DORMANT`;
- PRISADKA inventory-boundary blocker: `CLOSED`;
- cost-flow activation: `BLOCKED`;
- bootstrap: `NOT APPLIED`;
- business money initialization: `NO`;
- Close Month: `NOT IMPLEMENTED`.

Known remaining activation blocker (confirmed in AUDIT 1; scope refined in ARCH-2):

`ARCH-P1-001` — **OPEN / CONFIRMED**. Scope = `production_cost_flow` **ACTIVE** UPAKOVKA quantity-edit path. Activation blocker. **Not fixed.**

Current **inactive** runtime already protects `old refs ∪ current BOM refs` via `prepareUpakovkaEdit`. Do **not** say the inactive path has the same missing union check.

The unresolved finding is specifically the ACTIVE branch:

`snapshot current BOM → reverseActiveUpakovkaOperation(old refs) → apply current BOM`

without a single pre-mutation inventory boundary over old ∪ current refs.

`production_cost_flow` stays **INACTIVE**. Do not activate while this is open.

## 11. Local audit recovery

Status: `COMPLETE`

Local STEP 0 recovery (`audit/00-local-audit-recovery.md`) and STEP 0.5 canonicalization:

- `08.01-audit-1-system-architecture.md` did **not** exist on this PC (repo, worktrees, temp, Cursor folders, stash, reflog, unreachable objects). Status: `NOT PREVIOUSLY CREATED / RERUN REQUIRED`.
- 39 audit markdown files were in `/audit` before canonicalization (35 tracked; four `02.xx` untracked canonical candidates).
- The four recovered files are now part of the canonical tree: `audit/02.01-torcovka-terminal-ui-review.md`, `audit/02.02-torcovka-terminal-ui-plan.md`, `audit/02.03-terminal-functional-ux-review.md`, `audit/02.05-terminal-ui-commit-regression-review.md`.
- Conflicting current audit documents: **0**.
- Independent lost Stell22 clone: **none**.
- Historical copies, patches, and review bundles are **not** source of truth. See recovery report. Do not treat them as living findings.

## 12. AUDIT 1 — SYSTEM ARCHITECTURE

Status: `COMPLETE / REVIEWED`

Artifact: `audit/08.01-audit-1-system-architecture.md`

Repository audit base: `d1f46e46232499b61f55e754b0bd70ddc5924bca`

Application code base: `d9f940e8540801bdb27dd72210193f5e4ab038c3`

Result:

- P0 = 0
- P1 = `ARCH-P1-001`
- P2 = 0
- P3 = 0
- simplify = `ARCH-SIMPLIFY-001` (`TEMPORARY MIGRATION DEBT / REMOVE AFTER CUTOVER`)
- no new missing capabilities after adversarial review
- no unresolved owner questions from AUDIT 1
- existing known states were not reopened as new findings

### `ARCH-P1-001`

Status: `OPEN / CONFIRMED`

Scope: `production_cost_flow` **ACTIVE** UPAKOVKA quantity-edit path. Activation blocker.

Current inactive runtime already protects `old refs ∪ current BOM refs` via `prepareUpakovkaEdit`. The unresolved finding is the ACTIVE branch: snapshot current BOM → reverse old refs → apply current BOM without a single pre-mutation inventory boundary over old ∪ current refs.

Do **not** mark it fixed. Do **not** say the inactive path has the same missing union check. `production_cost_flow` stays INACTIVE. No remediation patch in this documentation cycle.

ChatGPT adversarial review of the 08.01 draft: **accepted**. Recovery had recorded that 08.01 did not previously exist; this cycle created and finalized it. `audit/03.02-production-cost-flow-architecture.md` remains cost-flow architecture only.

## 12.1 ARCH-2 — PRIMARY-SYSTEM READINESS

Status: `ACCEPTED / REVIEWED` (Review #1 R1…R6 CLOSED/PASS; Review #2 R7…R8 CLOSED/PASS; Review #3 **PASS / ACCEPT**; new blockers = 0)

Artifact (canonical on `main` after reviewed merge): `audit/08.02-primary-system-readiness-architecture.md`

Application/main BASE at ARCH-2 acceptance: `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` (**historical**; docs merge ≠ that-cycle production deploy). Current production application: see §4.

Forward-looking architecture so Stell22 can become the only warehouse/production operational source of truth. PSR namespace. **Not** a reopen of AUDIT 1. Architecture contract accepted; **not** full PSR implementation complete.

Correction-history production-correction slice of `PSR-DESIGN-001` / `PSR-Q-001`: **DECIDED / ACCEPTED** 2026-09-17 in `audit/08.03` (`ProductionOperationMutation`). Remainder + `PSR-Q-002` / `Q5` / `Q7` / `Q8` / `PSR-DESIGN-002`: **CLOSED / ACCEPTED** 2026-09-17 in `audit/08.04`. PSR-P0 = **COMPLETE / ACCEPTED** as architecture/design contract only. PSR-P1 schema contract: **ACCEPTED DESIGN** 2026-09-17 in `audit/08.05` (historical **NOT IMPLEMENTED** at contract creation preserved). PSR-P1 implementation/deploy: **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** 2026-09-17 in `audit/08.06`.

## 13. Current next step

NEXT = **PSR-P2 RAW IDENTITY PREREQUISITE PRODUCTION DEPLOYMENT PACKAGE**. Raw identity prerequisite = `audit/08.19` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; PR #33; accepted head `919a427`; merge `76131ca`; exact-head CI `35499639266`; post-merge CI `35500149127`). Supply SHADOW writer = `audit/08.18` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**; PR #31; accepted head `2e90060`; merge `164ffca`; exact-head CI `35493552025`; post-merge CI `35493953060`). Supply prerequisite = `audit/08.17` (**COMPLETE / NOT DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**). R-05 correction writer = `audit/08.16` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**; PR #26; accepted head `c9d3c0b`; merge `debafda`; exact-head CI `35443727340`; post-merge CI `35444256886`; **NOT DEPLOYED**). P2-GUARD/CI = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED** (`audit/08.12`; PR #18; merge `643c796`; post-merge CI `35373616566`; **NOT DEPLOYED**). Inventory writer prerequisite = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED** (`audit/08.13`; PR #20; accepted head `1f8b1d6`; merge `4dfaae2`; post-merge CI `35422069460`; **NOT DEPLOYED**). Inventory SHADOW writer on `main` = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED** (`audit/08.14`; PR #22; accepted head `c58131c`; merge `2fd138e`; accepted CI `35427250317`; post-merge CI `35427681739`; **NOT DEPLOYED**). Terminal production writers = `audit/08.15` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**; PR #24; accepted head `1367e30`; merge `853db69`; exact-head CI `35439899641`; post-merge CI `35440444019`; **NOT DEPLOYED**). Source/`main` connected physical InventoryMovement contours = **Inventory conduct + normal TORCOVKA / PRISADKA / UPAKOVKA + R-05 `correctTorcovkaRailsTaken` + Supply deduction / Ozon restore**. Production writer currently live = **NO**. Runtime P2 globally **NOT COMPLETE**. P3 **NOT STARTED**.

PSR-P0 = **COMPLETE / ACCEPTED** as an architecture/design contract only (`08.03` + `08.04`). Not runtime.

PSR-P1 = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`08.06`). Empty unused SHADOW-capable `InventoryMovement` in production; row count = **0**. Production has **no deployed runtime writers**. Source/main Inventory `conductInventory` writer is **CONNECTED / MERGED / NOT DEPLOYED**.

`PSR-Q-004` / R-07 / R-10 / R-11 remain **DEPLOYED DORMANT** (`audit/08.07`; Canonical? **YES**; first deployed at `de2e1c0`, run `35257469956`).

R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.08`; Production Deploy `35314440036`).

R-05 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.09`; production `27538a5`; Production Deploy `35329071777`). `ProductionOperationCorrection` is **LIVE** (initial row count **0**; historical backfill **NO**). Full `ProductionOperationMutation` remains later.

R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`; production `eb02b17`; Production Deploy `35337215903`). First-class BLANK InventoryLine. Unique `(inventoryId, refType, refId)` **LIVE**. Legacy DRAFT recreate. No InventoryMovement writer. Rollback window immediately after deploy = **PHASE A** (`audit/08.10` §12.1).

Does **not** mean dual-write, SHADOW posting, authoritative ledger, `OPENING_BALANCE` data, paper removal, `production_cost_flow` activation, or Correction Center.

This NEXT is **PSR-P2 RAW IDENTITY PREREQUISITE PRODUCTION DEPLOYMENT PACKAGE**. Raw identity prerequisite is `audit/08.19` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**). Do not deploy from this file. Production does not yet have migration `20260920120000_psr_p2_raw_identity_prerequisite`. Supply writer closeout is `audit/08.18` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**). Supply prerequisite remains **COMPLETE** (`audit/08.17`). R-05 writer closeout is `audit/08.16` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**). R-05 identity remains **DEPLOYED** (`audit/08.09`). It is **not** SHADOW activation, **not** dual-write activation, **not** Correction Center implementation, and **not** AUDIT 2. Do not start the next writers from this file. Do not deploy. Production Supply preflight is **COMPLETE / TRUSTED**. `PSR-Q-003` remains before P4. `PSR-Q-006` remains before P6.

Do **not** implement the full `ProductionOperationMutation` schema or Correction Center in this package.

Do **not** start AUDIT 2. AUDIT 2 remains `NOT STARTED` / `NEXT AFTER INC-001`.

INC-001 remains OPEN (containment first deployed at `3608b36` and still in the running tree; physical facts still required before any production-data correction). ARCH-2 / 08.03 / 08.04 / 08.06 / 08.07 / 08.08 / 08.09 do not close it. Cancellation remains deferred.

When AUDIT 2 starts: audit-only; do not auto-patch findings; `production_cost_flow` stays inactive; activation stays `BLOCKED`.

## 14. Journal update rule

After every significant delivery action record:

- date;
- stage/package;
- BASE SHA;
- resulting commit SHA;
- key changes/decisions;
- blockers closed/open;
- tests/review status;
- Claude deploy-gate status when applicable;
- deploy status;
- activation status;
- next step.

## 15. Journal — AUDIT 1 finalization

| | |
| --- | --- |
| Date | 2026-09-09 |
| Stage | AUDIT 1 — system architecture |
| BASE | repo `d1f46e46232499b61f55e754b0bd70ddc5924bca`; app `d9f940e8540801bdb27dd72210193f5e4ab038c3` |
| Result | `COMPLETE / REVIEWED`. P0=0. P1=`ARCH-P1-001` OPEN/CONFIRMED. P2=0. P3=0. Simplify=`ARCH-SIMPLIFY-001`. |
| Blockers | `ARCH-P1-001` remains an activation blocker. `production_cost_flow` inactive. Activation `BLOCKED`. Bootstrap `NOT APPLIED`. |
| Review | ChatGPT adversarial review accepted. No application patch. |
| Claude deploy gate | not required (docs only, no deploy) |
| Deploy | **NO** |
| Activation | unchanged / `BLOCKED` |
| Next | **INC-001** (AUDIT 2 deferred until INC-001 physical facts + correction review) |

## 16. Journal — INC-001 correction design

| | |
| --- | --- |
| Date | 2026-09-09 |
| Stage | INC-001 TORCOVKA whole-package production incident |
| BASE | `b08b98b5f67f7568a18f090c54b362f01c3426ff` (worktree `fix/torcovka-production-incident`); prod app `d9f940e` |
| Result | Delete semantics verified. Downstream NONE. Employee not recoverable. Scenarios A/B designed, not implemented. Finding `INC-001-F1` P1 recorded. |
| Blockers | Physical remaining rails; whether 3843 blanks existed; employee if Scenario B. `ARCH-P1-001` unchanged. |
| Review | Correction design only. No application patch. ChatGPT reviews A vs B before prod write. |
| Claude deploy gate | not required (no deploy) |
| Deploy | **NO** |
| Activation | unchanged / `BLOCKED` |
| Next | **Physical facts → reviewed Scenario A or B.** AUDIT 2 after INC-001. |

## 17. Journal — INC-001 containment deploy

| | |
| --- | --- |
| Date | 2026-09-09 |
| Stage | INC-001 application containment |
| BASE | docs `c1cc3c628e24cbcc6ee8cd290ac361c613e49b9b`; main before `b08b98b5f67f7568a18f090c54b362f01c3426ff` |
| Result | Generic TORCOVKA delete rejected before mutation. SHA `3608b36bd324a5118f4ba5b1bbb21462cc0723d9`. |
| Reviews | ChatGPT PASS; Claude #1 PASS; smoke fix; isolated smoke/integrity PASS; Claude #2 PASS |
| Main CI | `34357390695` SUCCESS |
| Deploy | Production Deploy `34357726641` SUCCESS; health OK; running SHA `3608b36` |
| Schema / migration | NO change; `No pending migrations to apply` |
| `production_cost_flow` | unchanged / INACTIVE (ABSENT) |
| Bootstrap | NOT APPLIED |
| Production data correction | NO |
| Damaged package | `ПАК-40-1280-01-7` remaining=0 unchanged |
| Next | Physical facts → Scenario A/B. AUDIT 2 after INC-001. |

## 18. Journal — origin/main `71a01b4` production deploy

| | |
| --- | --- |
| Date | 2026-09-11 (deploy); recorded 2026-09-12 |
| Stage | Production deploy of current `origin/main` |
| SHA | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` |
| Result | Production Deploy run `34635510843` SUCCESS |
| Includes | INC-001 containment + UI filters + TORCOVKA length/railsTaken hardening (PR #1) |
| Schema / migration | no change claimed in this docs cycle |
| `production_cost_flow` | unchanged / INACTIVE |
| Bootstrap | NOT APPLIED |
| Production data correction | NO |
| INC-001 data | still not corrected |
| Next after deploy | ARCH-2 documentation (this cycle) |

## 19. Journal — ARCH-2 primary-system readiness draft

| | |
| --- | --- |
| Date | 2026-09-12 |
| Stage | ARCH-2 / Primary-System Readiness architecture draft |
| BASE | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` |
| Result | `audit/08.02-primary-system-readiness-architecture.md` created. Status `PROPOSED / INDEPENDENT REVIEW REQUIRED`. |
| Blockers | `ARCH-P1-001` OPEN / CONFIRMED (ACTIVE path). INC-001 OPEN. `production_cost_flow` INACTIVE. |
| Review | Independent adversarial review required before implementation packages |
| Claude deploy gate | not required (docs only, no deploy) |
| Deploy | **NO** |
| Activation | unchanged / `BLOCKED` |
| AUDIT 1 | unchanged `COMPLETE / REVIEWED` |
| AUDIT 2 | **NOT STARTED** |
| Next | Independent adversarial review of `audit/08.02` |

## 20. Journal — ARCH-2 Independent Review #1

| | |
| --- | --- |
| Date | 2026-09-12 |
| Stage | ARCH-2 Independent Review #1 |
| BASE branch commit | `7c1b651e63747912285a5840246c64b9a053844b` |
| Application/main | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` |
| Verdict | **REQUEST CHANGES** |
| Findings | `ARCH2-R1`…`ARCH2-R6` accepted into the draft |
| Result | Draft still `PROPOSED / INDEPENDENT REVIEW REQUIRED`. Review #2 required. ARCH-2 **not accepted**. |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| `ARCH-P1-001` | OPEN / CONFIRMED (ACTIVE path) |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Deploy / merge | **NO** |
| Canonicality | Proposed branch artifact; not main truth until reviewed merge |
| Next | **Independent Review #2** |

## 21. Journal — ARCH-2 Independent Review #2

| | |
| --- | --- |
| Date | 2026-09-12 |
| Stage | ARCH-2 Independent Review #2 |
| BASE branch commit | `3777b68f5340acc20dfa9872346b4c568f5dc886` |
| Application/main | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` |
| Verdict | **REQUEST CHANGES** |
| Findings | `ARCH2-R7` BLOCKER (final epoch before correction); `ARCH2-R8` MAJOR (pre-schema questions). R1…R6 remain CLOSED/PASS. |
| Result | Draft still `PROPOSED / INDEPENDENT REVIEW REQUIRED`. Review #3 required. ARCH-2 **not accepted**. |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| `ARCH-P1-001` | OPEN / CONFIRMED (ACTIVE path) |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Deploy / merge | **NO** |
| Canonicality | Proposed branch artifact; not main truth until reviewed merge |
| Next | **Independent Review #3** |

## 22. Journal — ARCH-2 Independent Review #3

| | |
| --- | --- |
| Date | 2026-09-12 |
| Stage | ARCH-2 Independent Review #3 |
| BASE branch commit | `7b98f79c642e37eb89e14da95839770e57ec9142` |
| Application/main | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` |
| Verdict | **PASS / ACCEPT** |
| New blockers | **0** |
| Findings | R1…R8 remain **CLOSED / PASS**. No new architecture blockers. |
| Result | ARCH-2 **`ACCEPTED / REVIEWED`**. Architecture contract accepted. **Not** implementation complete. |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| `ARCH-P1-001` | OPEN / CONFIRMED (ACTIVE path) |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Production deploy | **NO** |
| Canonicality | `audit/08.02` on `main` is the canonical ARCH-2 architecture after this reviewed merge |
| Next | **PSR-P0** (not started in that Review #3 cycle). **Historical journal.** Later current next: journal 25 / `audit/08.04`. |

## 23. Journal — origin/main `0686d00` production deploy (Traceability v1)

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | Production deploy of `origin/main` after PR #3 |
| SHA | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Result | Production Deploy run `35204366279` SUCCESS |
| Includes | OPS-CORR-01 Production Traceability v1 (who entered / createdAt); INC-001 containment still in tree |
| Schema / migration | **none** |
| `production_cost_flow` | unchanged / INACTIVE |
| Bootstrap | NOT APPLIED |
| Production data correction | NO |
| INC-001 data | still not corrected |
| Next after deploy | PSR-P0-CORR architecture contract (this cycle) |

## 24. Journal — PSR-P0-CORR correction-history contract

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P0-CORR / history-preserving correction contract |
| BASE | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Result | `audit/08.03-psr-p0-correction-history-contract.md` created. Target = `ProductionOperationMutation`. CommandExecution not used for this contour. **ACCEPTED DESIGN / NOT IMPLEMENTED.** |
| `PSR-Q-001` | **OPEN / PARTIALLY RESOLVED** (production-correction slice DECIDED / ACCEPTED) |
| `PSR-DESIGN-001` | **OPEN / PARTIALLY RESOLVED** (production-correction slice ACCEPTED) |
| PSR-P0 overall | **PARTIAL / NOT COMPLETE** |
| Still open | Q1 remainder (warehouse / inventory / payroll / other writers), `PSR-Q-002`, `Q5`, `Q7`, `Q8`; cancellation; InventoryMovement; INC-001 |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Correction Center / Cancellation | **not implemented** / cancellation **DEFERRED** |
| PSR-P1 | **NOT STARTED / BLOCKED** until Q1, Q2, Q5, Q7, Q8 fully closed |
| Deploy | **NO** |
| Next | Remaining PSR-P0 PRE-SCHEMA questions. Not InventoryMovement schema. |

## 25. Journal — PSR-P0-CORE remaining PRE-SCHEMA contracts

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P0-CORE / remaining PRE-SCHEMA contracts |
| BASE GitHub `main` | `bd82aa0e0f4785cee316d282ef55eb593aadca3b` |
| Application / production | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Result | `audit/08.04-psr-p0-core-contract.md` created. Q1 remainder, Q2, Q5, Q7, Q8 and DESIGN-001/002 **CLOSED / ACCEPTED**. **ACCEPTED DESIGN / NOT IMPLEMENTED.** |
| PSR-P0 | **COMPLETE / ACCEPTED** as architecture/design contract only |
| PSR-P1 | **NOT STARTED**. **NEXT after reviewed merge** = InventoryMovement schema in SHADOW |
| `PSR-Q-003` / `Q4` / `Q6` | unchanged later timing |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Correction Center / Cancellation | **not implemented** / cancellation **DEFERRED** |
| Deploy | **NO** |
| Next | Reviewed merge of `08.04`. Then PSR-P1 InventoryMovement schema in SHADOW. Not dual-write. Not deploy. |

## 26. Journal — PSR-P1 InventoryMovement schema contract

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P1 / InventoryMovement exact schema contract |
| BASE GitHub `main` | `b11c37df94be8aee0fb4d0e9a466182924e29fc7` |
| Application / production | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Result | `audit/08.05-psr-p1-inventory-movement-schema-contract.md` created. Exact enums/model/no-FK/partial indexes/CHECKs/snapshots frozen. **ACCEPTED DESIGN / NOT IMPLEMENTED.** |
| PSR-P0 | **COMPLETE / ACCEPTED** as architecture/design contract only (unchanged) |
| PSR-P1 schema contract | **ACCEPTED DESIGN / NOT IMPLEMENTED** |
| PSR-P1 Prisma/migration | **NOT STARTED** |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Correction Center / Cancellation | **not implemented** / cancellation **DEFERRED** |
| Deploy | **NO** |
| Next | Reviewed merge of `08.05`. Then a separate implementation prompt: empty InventoryMovement table in SHADOW. Not dual-write. Not deploy. |

## 27. Journal — PSR-P1 Independent Review #1 schema-contract corrections

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P1 schema contract — Independent Review #1 disposition |
| BASE GitHub `main` | `b11c37df94be8aee0fb4d0e9a466182924e29fc7` |
| Application / production | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Review verdict | **PASS WITH NON-BLOCKING FINDINGS**. P0=0. P1=0. |
| Result | ChatGPT resolved schema-shaping items into `audit/08.05`: SHADOW may carry rehearsal `epochId`; AUTHORITATIVE-only opening UNIQUE indexes; reversal remains partial/multi/chain without self-FK; snapshot keys-present/null-ok; identity length + MANUAL reason CHECKs; no-money snapshot rule. R-03 proposed UNIQUE/self-FK/1:1 full reversal **rejected**. Writer items R-04…R-07/R-10/R-11 recorded as PSR-P2 preconditions. R-06 also current runtime DI finding; **no new DI number allocated**. |
| PSR-P1 schema contract | **ACCEPTED DESIGN / NOT IMPLEMENTED** |
| Deploy | **NO** |
| Next | Reviewed merge of `08.05`. Then a separate implementation prompt: empty InventoryMovement table in SHADOW. Not dual-write. Not deploy. |

## 28. Journal — PSR-P1 SHADOW schema implementation and production deploy

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P1 InventoryMovement SHADOW schema — implemented and deployed empty |
| Implementation PR | #7 — `feat: add PSR-P1 inventory movement shadow schema` |
| Reviewed head | `087ed7c5b09937cacf10fe3c110465a08c14de78` |
| Merge commit / `origin/main` | `92532e818df41160b434caac2c6d94933e93d810` |
| Post-merge CI | `35227949324` SUCCESS |
| Production Deploy | `35228794988` SUCCESS (`workflow_dispatch`) |
| Previous production application | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Current production application | `92532e818df41160b434caac2c6d94933e93d810` |
| Migration | `20260917150000_psr_p1_inventory_movement_shadow` — `_prisma_migrations` 1 row; `finished_at` set; `rolled_back_at` NULL; `applied_steps_count` = 1 |
| `InventoryMovement` | EXISTS; row count = **0** |
| Catalog | 5 enums PASS; 12 CHECKs PASS; FK 0/0; Prisma + 8 partial + 5 opening UNIQUE indexes PASS |
| Health | HTTP 200 `{"status":"ok","db":"up"}` |
| Rollback | **NO** |
| Manual production mutation | **NO** |
| Result | **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`) |
| Runtime writers | **none** |
| PSR-P2 | **NOT STARTED** |
| `production_cost_flow` | unchanged canonical delivery state / INACTIVE (no fresh live query in this closeout) |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **PSR-P2 PRE-DUAL-WRITE CONTRACT / PRECONDITIONS**. Not dual-write implementation. |

## 29. Journal — PSR-P2 general pre-dual-write preconditions (Q4 / R-07 / R-10 / R-11)

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P2 general preconditions implementation |
| BASE GitHub `main` | `394f753dd4e04ea5d2b345894041f63e70818d2d` (**historical pre-merge / work start**) |
| Production application | `92532e818df41160b434caac2c6d94933e93d810` (**unchanged**; intentionally different from current GitHub `main`) |
| Result | `audit/08.07-psr-p2-pre-dual-write-general-preconditions.md`. Architecture **CLOSED**. Implementation **VERIFIED / MERGED TO main / NOT DEPLOYED**. PR #9 **MERGED**. PR #9 implementation merge checkpoint = `3f89fffb8dc5842027420095bd3c85a07a85e284`. Post-merge CI **SUCCESS** `35250490823`. Always verify current GitHub `main` HEAD. |
| Historical packaging | Feature-branch / PR-open state (`COMMITTED ON FEATURE BRANCH / PR #9 OPEN`) is **historical**. Do not treat it as current. |
| Q4 | Setting `inventory_movement_shadow_write`; writer = SHARED TX lock; ON/OFF = same EXCLUSIVE control lock as reset via transaction-only setter + maintenance CLI; not wired into physical writers |
| R-07 | New migration `recordedAt TIMESTAMPTZ(3)`; P1 migration not rewritten; empty-table guard |
| R-10 | SHADOW-only delete; exclusive control lock first (same primitive as gate ON/OFF); causal UNIQUE unchanged |
| R-11 | CI/static append-only guard |
| Runtime `InventoryMovement` writers | **none** (except dedicated R-10 maintenance path) |
| Dual-write | **NOT STARTED** |
| Deploy | **NO** |
| Production queried | **NO** |
| `production_cost_flow` | canonical delivery state INACTIVE; live runtime NOT QUERIED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| R-04 / R-05 / R-06 | remain OPEN |
| `PSR-Q-003` / `Q6` | remain later-timing |
| Next | **PSR-P2 GENERAL PRECONDITIONS — PRODUCTION PREFLIGHT / DEPLOYMENT DECISION**. Not dual-write. Not deploy from this file. |

## 30. Journal — PSR-P2 R-04 Supply cycle identity

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P2 R-04 Supply cycle-identity prerequisite |
| BASE GitHub `main` | `de2e1c015423e7b848f0583c0e75b2abb12733d9` |
| Production application | `de2e1c015423e7b848f0583c0e75b2abb12733d9` (**unchanged** this cycle) |
| Result | `audit/08.08-psr-p2-r04-supply-cycle-identity.md`. Architecture **CLOSED**. Implementation **VERIFIED / NOT DEPLOYED**. Dual-write **NOT STARTED**. No InventoryMovement writer. |
| Fields | `Supply.stockAccountingGeneration` default 0; `Supply.stockAccountingOpen` default false |
| Migration | `20260917200000_psr_p2_r04_supply_stock_accounting_cycle` |
| Ozon | cancel closes open cycle including full shortfall; same-sync cancel wins |
| WB | consume-only; DI-011 still deferred |
| Deploy | **NO** |
| Production queried | **NO** |
| `inventory_movement_shadow_write` | unwired / inactive |
| R-05 / R-06 | remain OPEN |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **R-04 DELIVERY — PR #11 MERGE / PRODUCTION PREFLIGHT / DEPLOYMENT DECISION**. Not SUPPLY SHADOW dual-write. SHADOW gate inactive. InventoryMovement writer 0. R-05 / R-06 remain OPEN. Not a deploy from this file. |

## 31. Journal — PSR-P2 R-04 production deployment

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 R-04 production deploy closeout |
| Production application | `c14a58641d57dfabfce223b2c213db9c86167ca4` |
| Evidence | Production Deploy run `35314440036` SUCCESS (`workflow_dispatch`). Deploy job `105503362569`. CI/verify `105503012164`. |
| Prior production | `de2e1c015423e7b848f0583c0e75b2abb12733d9` (**historical**) |
| Result | `audit/08.08`. R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED**. Migration `20260917200000_psr_p2_r04_supply_stock_accounting_cycle` **APPLIED**. |
| Schema | `Supply.stockAccountingGeneration` integer NOT NULL DEFAULT 0; `Supply.stockAccountingOpen` boolean NOT NULL DEFAULT false; CHECKs `Supply_stockAccountingGeneration_nonnegative`, `Supply_stockAccountingOpen_generation` |
| Unique identity | unchanged `UNIQUE(marketplace, externalId, sku)` |
| InventoryMovement | 0 / 0 / 0; runtime writers **0** |
| `inventory_movement_shadow_write` | ABSENT / inactive |
| `production_cost_flow` | **INACTIVE** |
| Dual-write | **NOT STARTED** |
| P3009 recovery | **NO** |
| Rollback | **NO** |
| R-05 / R-06 | remain OPEN |
| DI-011 | **DEFERRED BY OWNER** |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **PSR-P2 R-05 CORRECTION IDENTITY — RECONNAISSANCE / CONTRACT DECISION**. Not SUPPLY SHADOW dual-write. Not an InventoryMovement writer. Not R-06. Not Correction Center. Not AUDIT 2. |

## 32. Journal — PSR-P2 R-05 correction identity

This journal is **historical** (PR #13 implementation/review). Current runtime status is §33.

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 R-05 TORCOVKA railsTaken correction identity |
| BASE GitHub `main` | `30972dd76a6e84e03bd40d5b7551f10ac89ed4f5` |
| Production application | `c14a58641d57dfabfce223b2c213db9c86167ca4` (**unchanged** this cycle) |
| Result | `audit/08.09-psr-p2-r05-correction-identity.md`. Architecture **CLOSED**. Implementation **VERIFIED / NOT DEPLOYED**. Dual-write **NOT STARTED**. No InventoryMovement writer. Not full `ProductionOperationMutation`. |
| Model | `ProductionOperationCorrection` (scalar IDs, no FK cascade). `requestId` UNIQUE. expected-old CAS. Idempotent replay. |
| Migration | `20260918120000_psr_p2_r05_production_operation_correction` (empty table, no backfill) |
| Deploy | **NO** |
| Production queried | **NO** |
| `inventory_movement_shadow_write` | ABSENT / inactive |
| R-06 | remains OPEN |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **R-05 PRODUCTION PREFLIGHT / DEPLOYMENT DECISION**. Not R-06. Not dual-write. Not Correction Center. Always verify current GitHub `main` HEAD. |

## 33. Journal — PSR-P2 R-05 production deployment

This journal does **not** rewrite §32. §32 remains the historical PR-#13 implementation/review status (**NOT DEPLOYED** at that time).

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 R-05 production deploy closeout |
| Production application | `27538a5d5777d33fb87d060963a6d07a189cf044` |
| Evidence | Production Deploy run `35329071777` SUCCESS (`workflow_dispatch`). Resolve `105548942840`. CI/verify `105548987647`. Deploy `105549637693`. Created `2026-09-18T09:21:04Z`. Completed `2026-09-18T09:27:58Z`. |
| Prior production | `c14a58641d57dfabfce223b2c213db9c86167ca4` (**historical**) |
| Result | `audit/08.09`. R-05 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED**. Migration `20260918120000_psr_p2_r05_production_operation_correction` **APPLIED**. |
| Table | `ProductionOperationCorrection` **LIVE**. Initial row count **0**. Historical backfill **NO**. No fabricated correction identities. |
| InventoryMovement | 0 / 0 / 0; runtime writers **0**. R-05 deploy did **not** start an InventoryMovement writer. |
| `inventory_movement_shadow_write` | ABSENT / inactive |
| `production_cost_flow` | **INACTIVE** |
| Dual-write | **NOT STARTED** |
| P3009 recovery | **NO** |
| Rollback | **NO** |
| R-04 | remains **DEPLOYED** |
| R-06 | **OPEN** |
| DI-011 | **DEFERRED BY OWNER** |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **PSR-P2 R-06 INVENTORY IDENTITY — RECONNAISSANCE / CONTRACT DECISION**. Not R-06 implementation. Not SHADOW activation. Not dual-write. Not an InventoryMovement writer. Not Correction Center. Not AUDIT 2. |

## 34. Journal — PSR-P2 R-06 inventory identity implementation

This journal does **not** rewrite §33. §33 remains the historical R-05 production-deploy closeout.

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 R-06 inventory physical identity implementation |
| Production application | `27538a5d5777d33fb87d060963a6d07a189cf044` (**unchanged**) |
| Result | `audit/08.10`. R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / NOT DEPLOYED**. |
| Migration | `20260918130000_psr_p2_r06_inventory_line_identity` (uniqueness only; not deployed) |
| InventoryMovement | writers **0**; dual-write **NOT STARTED**; SHADOW inactive |
| `production_cost_flow` | **INACTIVE** |
| Production access | **NO** |
| Deploy | **NO** |
| Next | **R-06 HEAD REVIEW**. Not InventoryMovement dual-write. Not Correction Center. Not AUDIT 2. |

## 35. Journal — PSR-P2 R-06 production deployment

This journal does **not** rewrite §34. §34 remains the historical R-06 implementation/review status (**NOT DEPLOYED** at that time).

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 R-06 production deploy closeout |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` |
| Evidence | Production Deploy run `35337215903` SUCCESS (`workflow_dispatch`). Resolve `105574729643`. CI/verify `105574756893`. Deploy `105575381753`. |
| Prior production | `27538a5d5777d33fb87d060963a6d07a189cf044` (**historical**) |
| Result | `audit/08.10`. R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED**. Migration `20260918130000_psr_p2_r06_inventory_line_identity` **APPLIED**. Index `InventoryLine_inventoryId_refType_refId_key` **LIVE**. |
| Cutover Inventory | total **1** (CONDUCTED **1**, DRAFT **0**, CLOSED **0**). InventoryLine **0**. Historical backfill **NO**. No BLANK document at cutover. |
| InventoryMovement | 0 / 0 / 0; runtime writers **0**. R-06 deploy did **not** start an InventoryMovement writer. |
| `inventory_movement_shadow_write` | ABSENT / inactive |
| `production_cost_flow` | **INACTIVE** |
| Dual-write | **NOT STARTED** |
| P3009 recovery | **NO** |
| Rollback used | **NO** |
| Rollback window | **PHASE A**. Rollback to `27538a5` currently **SAFE**. Phase B = SAFE BUT DRAFT UNUSABLE FOR CONDUCT. Phase C (first CONDUCTED R-06 BLANK inventory) = **SEMANTICALLY UNSAFE** — do not blindly rollback to `27538a5`. |
| R-05 | remains **DEPLOYED** |
| R-04 | remains **DEPLOYED** |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **PSR-P2 INVENTORY WRITER PREREQUISITE PACKAGE**. Not the first Inventory physical writer. Not SHADOW activation. Not dual-write. Not Correction Center. Not AUDIT 2. |

---
## PSR-P2 shadow-writer contract freeze — 2026-09-18

Accepted contract: `audit/08.11-psr-p2-shadow-writer-contract.md` (PR #17).

Starting main: `2eb4f6a6d769900481a5c3fd33a76240789d953d`.

The contract records all verified physical mutation contours and explicitly keeps blocked contours blocked. In particular: Inventory requires one global BlankStock lock set/order; Supply requires the null-product restore guard and a global Supply/ProductStock lock order; R-05 requires explicit READ COMMITTED; SimplePurchase and general production edit/delete paths require retained retry-stable mutation identity; positive-stock Batch deletion cannot bypass the future ledger.

No runtime InventoryMovement writer is introduced by this package. No SHADOW activation. No production deploy or mutation.

Current NEXT after contract acceptance was **P2-GUARD/CI**. That package is now **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED** (`audit/08.12`; PR #18). NEXT: **PSR-P2 INVENTORY WRITER PREREQUISITE PACKAGE**. Not the first physical writer.

---
## PSR-P2 P2-GUARD/CI implementation — 2026-09-18

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 P2-GUARD/CI |
| BASE GitHub `main` | `71182863c7432b9af490370a66179e060f2ed913` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Result | `audit/08.12`. Common SHADOW gateway skeleton, INSERT/gate-read/TRUNCATE guards, identity/actor/time helpers, disposable PostgreSQL CI. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**. |
| Runtime InventoryMovement writers | **0** |
| Gateway wired to physical paths | **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| PR / merge | `#18` / `643c7966a4f03670747517050031843eac1b5013` |
| Accepted implementation HEAD | `91c7e3e91f956f9fc2d4959cb83c105d4979f96d` |
| Post-merge CI | `35373616566` SUCCESS |
| Next | **PSR-P2 INVENTORY WRITER PREREQUISITE PACKAGE**. Not the first Inventory physical writer. Not dual-write. Not Correction Center. Not AUDIT 2. |

The prerequisite package is recorded in `audit/08.13`. Feature-branch journal: §36. Merge closeout: §37. **NOT DEPLOYED. INVENTORY WRITER NOT STARTED.** NEXT after merge closeout: **PSR-P2 INVENTORY SHADOW WRITER IMPLEMENTATION PACKAGE**.

## 36. Journal — PSR-P2 Inventory writer prerequisite (feature branch)

This journal does **not** rewrite §35. §35 remains the P2-GUARD/CI merge closeout. Subsequent merge closeout is §37; do not treat this table as current merge state.

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 Inventory writer prerequisite |
| BASE GitHub `main` | `6a1eeaf6ad7f39803f0ddf193e2ac232531636a9` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-inventory-writer-prereq` |
| Result | `audit/08.13`. SHADOW gate-first Inventory TX, temporary SHADOW-active fail-closed, dual-active fail-closed, global BlankStock lock plan, retained USER actor. **IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / INVENTORY WRITER NOT STARTED**. |
| Runtime InventoryMovement writers | **0** |
| `appendShadowInventoryMovements` from Inventory | **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Next | **HEAD REVIEW OF INVENTORY WRITER PREREQUISITE PR**. Not the Inventory writer. Not SHADOW activation. Not merge. Not deploy. |

## 37. Journal — PSR-P2 Inventory writer prerequisite merge closeout

This journal does **not** rewrite §36. §36 remains the feature-branch implementation record.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Inventory writer prerequisite merge closeout |
| BASE GitHub `main` | `6a1eeaf6ad7f39803f0ddf193e2ac232531636a9` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Exact accepted implementation HEAD | `1f8b1d64e7d4d7828606514f728c4603f1281244` |
| PR | `#20` |
| Merge commit | `4dfaae26471188db04d76262d9776336aada854a` |
| Accepted PR CI | `35379385996` SUCCESS |
| Post-merge CI | `35422069460` SUCCESS |
| HEAD review | **PASS** |
| Independent Opus review | **PASS** |
| Findings | **P0=0 / P1=0 / P2=5** (non-blocking; dispositioned in `audit/08.13` §10) |
| Result | `audit/08.13`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / INVENTORY WRITER NOT STARTED**. |
| Runtime InventoryMovement writers | **0** |
| `appendShadowInventoryMovements` from Inventory | **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Next | **PSR-P2 INVENTORY SHADOW WRITER IMPLEMENTATION PACKAGE**. Not started. Not SHADOW activation. Not deploy. |

The writer implementation is recorded in `audit/08.14`. Feature-branch journal: §38. Merge closeout: §39. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED.** NEXT: **PSR-P2 NORMAL TERMINAL PRODUCTION SHADOW WRITERS PACKAGE**.

## 38. Journal — PSR-P2 Inventory SHADOW writer (feature branch)

This journal does **not** rewrite §37. §37 remains the Inventory writer prerequisite merge closeout.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Inventory SHADOW writer |
| BASE GitHub `main` | `ab81d9b7094d063b3d0ef4ab6ddb117fc18aa878` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-inventory-shadow-writer` |
| Result | `audit/08.14`. First physical InventoryMovement writer for Inventory `conductInventory`. **IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | **Inventory conduct only** (not in production) |
| `appendShadowInventoryMovements` from Inventory | **YES** (feature branch) |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| Next | **HEAD REVIEW OF INVENTORY SHADOW WRITER PR**. Not merge. Not deploy. Not SHADOW activation. Not the next contour writer. |

## 39. Journal — PSR-P2 Inventory SHADOW writer merge closeout

This journal does **not** rewrite §38. §38 remains the feature-branch implementation record.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Inventory SHADOW writer merge closeout |
| BASE GitHub `main` | `ab81d9b7094d063b3d0ef4ab6ddb117fc18aa878` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Exact accepted implementation HEAD | `c58131c02484ae49897fa0259ad623af65708b9e` |
| PR | `#22` |
| Merge commit | `2fd138e2c7195b63c2e943d0f85f2b9b0050740c` |
| Accepted PR CI | `35427250317` SUCCESS |
| Post-merge CI | `35427681739` SUCCESS |
| HEAD review | **PASS** |
| Independent Opus review | **PASS — P0=0 / P1=0 / P2=4** (reviewed `28d7247`; no second Opus after W1/W4) |
| Findings | **P0=0 / P1=0 / P2=4**. W1 CLOSED. W2 accepted non-blocking. W3 accepted pre-existing/non-blocking. W4 CLOSED. |
| Result | `audit/08.14`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | **Inventory conduct only** in source/main; production writer currently live = **NO** |
| `appendShadowInventoryMovements` from Inventory | **YES** (source/main; not in production) |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Next | **PSR-P2 NORMAL TERMINAL PRODUCTION SHADOW WRITERS PACKAGE**. Not started. Not SHADOW activation. Not deploy. |

The terminal production writer implementation is recorded in `audit/08.15`. Journal: §40. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED.**

## 40. Journal — PSR-P2 terminal production SHADOW writers

This journal does **not** rewrite §39. §39 remains the Inventory SHADOW writer merge closeout.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 terminal production SHADOW writers |
| BASE GitHub `main` | `cb0a9019a739738a44399f5491bd4d00a2cd1f65` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Exact accepted implementation HEAD | `1367e306f4c5e0be77137cf005e7396bf110ae33` |
| PR | #24 |
| Merge commit | `853db69b00485f5201c2fd1046cc68b07ac69ded` |
| Exact-head CI | `35439899641` SUCCESS |
| Post-merge CI | `35440444019` SUCCESS |
| HEAD final review | **PASS** |
| Independent Opus | **SKIPPED BY OWNER COST POLICY** |
| Initial findings | **P0=0 / P1=2 / P2=1**. P1-01 CLOSED. P1-02 CLOSED. P2-01 CLOSED. |
| Result | `audit/08.15`. SHADOW writers for normal `submitTorcovka` / `submitPrisadka` / `submitUpakovka`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits in source/main; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Next | **PSR-P2 R-05 TORCOVKA CORRECTION SHADOW WRITER PACKAGE**. Not started. Not SHADOW activation. Not deploy. Not Supply. |

The R-05 correction writer merge closeout is recorded in `audit/08.16`. Journal: §42. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED.**

## 42. Journal — PSR-P2 R-05 TORCOVKA correction SHADOW writer merge closeout

This journal does **not** rewrite §41. §41 remains the historical feature-branch implementation snapshot.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 R-05 TORCOVKA correction SHADOW writer merge closeout |
| BASE GitHub `main` | `f89081f70b7522afe21694527fa22f8f778daafe` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Exact accepted implementation HEAD | `c9d3c0b62894d505987685ee399fa99c69ce3126` |
| PR | #26 |
| Merge commit | `debafdae9510acab7182e334fcfe1a5b00608e0d` |
| Exact-head CI | `35443727340` SUCCESS |
| Post-merge CI | `35444256886` SUCCESS |
| HEAD final review | **PASS** |
| Findings | **P0=0 / P1=0 / P2=0** |
| Independent Opus | **SKIPPED BY OWNER COST POLICY** |
| Result | `audit/08.16`. SHADOW writer for `correctTorcovkaRailsTaken`. Explicit READ COMMITTED. Gate-first. Retained USER actor. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 correction in source/main; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Next | **PSR-P2 SUPPLY PREREQUISITE FIX PACKAGE**. Not started. Not SHADOW activation. Not deploy. Do not start Supply from this closeout. |

## 43. Journal — PSR-P2 Supply writer prerequisite (feature branch)

This journal does **not** rewrite §42. §42 remains the R-05 correction writer merge closeout. The original feature-branch name is historical. The Result / access rows below are a **historical snapshot** after PR #28 merge and failed read-only preflight `35449877592`. Current living closeout is §44.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Supply writer prerequisite |
| BASE GitHub `main` | `f740dbcc3a0838df85ad3a83a3a061e503368a4d` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-supply-prerequisite` |
| Result | `audit/08.17`. Runtime hardening **MERGED** (PR #28 `5fe5f40`; accepted `8e92dd6`). P1-01/P1-02 **CLOSED**. Production preflight **FAILED / INCOMPLETE** (`SUPPLY-PREFLIGHT-PARSER-001`; run `35449877592`). Supply writer **BLOCKED / NOT STARTED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 correction in source/main; Supply **NOT connected**; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access | **YES — READ-ONLY** preflight attempt via run `35449877592` |
| Production mutation / deploy | **NO / NO** |
| Trusted counts / `SUPPLY_DATA_BLOCKER` | **NONE** / **UNKNOWN** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Next | Historical next at this snapshot: HEAD re-review of the Supply preflight parser-fix PR. Closed by §44. |

## 44. Journal — PSR-P2 Supply writer prerequisite closeout

This journal does **not** rewrite §43. §43 remains the historical feature-branch / failed-preflight snapshot.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Supply writer prerequisite closeout |
| BASE GitHub `main` | `eb79b261ed8c2dfe423ba9207d48e7d29e14dbd8` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `docs/psr-p2-supply-prerequisite-closeout` |
| Result | `audit/08.17` **COMPLETE**. Runtime hardening **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**. Production preflight **COMPLETE / TRUSTED**. P1-01/P1-02 **CLOSED**. `SUPPLY-PREFLIGHT-PARSER-001` **CLOSED**. P2-01 **CLOSED**. Supply writer **READY TO START / NOT STARTED**. |
| Implementation | PR #28 accepted `8e92dd62caf063914e56d4105d550fb2fe1505af`; merge `5fe5f40572ce9259c3725a93516a76f9533f07ab`; exact-head CI `35449013808`; post-merge CI `35449670249` |
| Parser fix | PR #29 accepted `7795e88d9bf250c330db3cc3b360b780a18148c5`; merge `eb79b261ed8c2dfe423ba9207d48e7d29e14dbd8`; exact-head CI `35451478137`; post-merge CI `35452147190` |
| Historical failed preflight | `35449877592` — `SUPPLY-PREFLIGHT-PARSER-001`; trusted counts **NONE** |
| Trusted preflight | `35452435411` SUCCESS on `eb79b26`. TOTAL=0 / DEDUCTED_POSITIVE=0 / SHORTFALL_ONLY=0 / OPEN_DEDUCTED_POSITIVE=0 / `SUPPLY_DATA_BLOCKER=NO` |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 correction in source/main; Supply **NOT connected**; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access | **YES — READ ONLY** |
| Production mutation / deploy | **NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Next | **PSR-P2 SUPPLY SHADOW WRITER IMPLEMENTATION PACKAGE**. Not started. Not deploy. Not SHADOW activation. Do not start Supply writer from this closeout. |

## 41. Journal — PSR-P2 R-05 TORCOVKA correction SHADOW writer (feature branch)

This journal does **not** rewrite §40. §40 remains the terminal production SHADOW writer merge closeout.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 R-05 TORCOVKA correction SHADOW writer |
| BASE GitHub `main` | `f89081f70b7522afe21694527fa22f8f778daafe` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-r05-correction-shadow-writer` |
| Result | `audit/08.16`. SHADOW writer for `correctTorcovkaRailsTaken`. Explicit READ COMMITTED. Gate-first. Retained USER actor. **IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 correction on this branch; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Next | **HEAD REVIEW OF R-05 TORCOVKA CORRECTION SHADOW WRITER PR**. Not merge. Not deploy. Not SHADOW activation. Not Supply. |

## 45. Journal — PSR-P2 Supply SHADOW writer (feature branch)

This journal does **not** rewrite §44. §44 remains the Supply prerequisite closeout.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Supply SHADOW writer |
| BASE GitHub `main` | `b030086746292464414e1508c798cea2c8ff7e5a` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-supply-shadow-writer` |
| Result | `audit/08.18`. SHADOW writer for Supply ProductStock deduction and Ozon positive restore. Gate-first marketplace TX. Retained USER actor. **IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 + Supply deduction/Ozon restore on this branch; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Next | **HEAD RE-REVIEW OF SUPPLY SHADOW WRITER PR** (historical; completed). Not merge. Not deploy. Not SHADOW activation. |

## 46. Journal — PSR-P2 Supply SHADOW writer closeout

This journal does **not** rewrite §45. §45 remains the feature-branch implementation record.

| | |
| --- | --- |
| Date | 2026-09-20 |
| Stage | PSR-P2 Supply SHADOW writer closeout |
| BASE GitHub `main` | `b030086746292464414e1508c798cea2c8ff7e5a` |
| Initial implementation HEAD | `b1787205d51b9ce60ea6859708f9c3d80a6bda43` |
| Initial HEAD review | **REQUEST CHANGES** — P0=0 / P1=1 / P2=1 |
| Correction / accepted HEAD | `2e90060d145bac9fc9eb6b2fcaef4253fbfe877b` |
| Merge | `164ffca49d5200af0b442de05c8966fc3b5c70ed` |
| Exact-head CI | `35493552025` SUCCESS |
| Post-merge CI | `35493953060` SUCCESS |
| Final HEAD review | **PASS** — P0=0 / P1=0 / P2=0; P1-01 CLOSED; P2-01 CLOSED |
| Independent Opus | **SKIPPED BY OWNER COST POLICY** |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Result | `audit/08.18`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 + Supply deduction/Ozon restore on `main`; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Next | **PSR-P2 RAW RECEIPT / WRITE-OFF IDENTITY PREREQUISITE PACKAGE** (historical; started on feature branch). Not the next writers. Not deploy. Not SHADOW activation. |

## 47. Journal — PSR-P2 raw receipt / write-off identity prerequisite

This journal does **not** rewrite §46. §46 remains the Supply writer closeout.

| | |
| --- | --- |
| Date | 2026-09-20 |
| Stage | PSR-P2 raw receipt / write-off identity prerequisite |
| BASE GitHub `main` | `ea7942464add030cbe12b7226075820bc16f70bc` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-raw-identity-prerequisite` |
| Result | `audit/08.19`. Retained identities for `createBatch`, `writeOffBatchRemainder`, `createSimplePurchase`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**. PR #33 accepted head `919a427`; merge `76131ca`; exact-head CI `35499639266`; post-merge CI `35500149127`. |
| Runtime InventoryMovement writers | still 6 source contours; this package adds **0** writers; production writer currently live = **NO** |
| Schema / migration | **YES** — three empty identity tables; no FK; no backfill; no InventoryMovement change |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Next | **PSR-P2 RAW IDENTITY PREREQUISITE PRODUCTION DEPLOYMENT PACKAGE**. Not the three writers. Not deploy from this file. Not SHADOW activation. |
