# Stell22 — Project Journal / Source of Truth

Updated: 2026-09-17

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

`0686d0036da52cc32aaff531c91f1dd2ded899ec`

`Merge pull request #3 from Mr-Pinkerton/feat/ops-corr-01-traceability-v1`

Evidence: GitHub Production Deploy run `35204366279` SUCCESS (2026-09-17, `workflow_dispatch`; `headSha` = `0686d0036da52cc32aaff531c91f1dd2ded899ec`).

GitHub `main` after the PSR-P0-CORE docs merge is `b11c37df94be8aee0fb4d0e9a466182924e29fc7`. The production **application** remains `0686d0036da52cc32aaff531c91f1dd2ded899ec` until a **separate** production deploy. This cycle’s application-code base remains that SHA. A later documentation merge of PSR-P1 schema contract (`audit/08.05`) will advance GitHub `main` again and will **not** deploy application code. Historical docs-merge SHA `bd82aa0` (08.03) is not rewritten.

That deploy includes:

- OPS-CORR-01 Production Traceability v1 (PR #3);
- INC-001 generic TORCOVKA-delete containment (`3608b36`, still in effect);
- UI filter work;
- TORCOVKA BlankStock length canonicalization and railsTaken correction hardening (PR #1).

Schema / migrations: **none** in the Traceability v1 / this documentation cycle.

Prior documented production application SHA:

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

`ACTIVE MODE: PSR-P0 COMPLETE / ACCEPTED as an architecture/design contract only` (`audit/08.03` + `audit/08.04`; **not** runtime). PSR-P1 schema contract **ACCEPTED DESIGN / NOT IMPLEMENTED** (`audit/08.05`). Prisma/migration **not** started.

AUDIT 1 (system architecture) remains `COMPLETE / REVIEWED`. **Do not change AUDIT 1 status. Do not reopen AUDIT 1.**

`AUDIT 2 — FINANCE & MONEY INTEGRITY` is **NOT STARTED**. It remains `NEXT AFTER INC-001`. ARCH-2 does **not** silently start AUDIT 2.

INC-001 remains `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION`. Containment is still in production on `0686d00` (first deployed at `3608b36`). Do not treat ARCH-2 / PSR-P0-CORR as a production-data fix. Do not automatically invert INV-047 (generic TORCOVKA delete returning rails).

**ARCH-2 / Primary-System Readiness** (`audit/08.02-primary-system-readiness-architecture.md`): **`ACCEPTED / REVIEWED`**.

Independent Review #1 = REQUEST CHANGES (R1…R6 **CLOSED / PASS**). Independent Review #2 = REQUEST CHANGES (R7…R8 **CLOSED / PASS**). Independent Review #3 = **PASS / ACCEPT**. New blockers = 0.

`ACCEPTED / REVIEWED` means the **architecture contract** is accepted. It does **not** mean PSR implementation complete, primary-system readiness achieved, ledger deployed, paper removable, or `production_cost_flow` active.

PSR-P0-CORR (`audit/08.03-psr-p0-correction-history-contract.md`): **ACCEPTED DESIGN / NOT IMPLEMENTED**. Target = `ProductionOperationMutation` (CommandExecution not used for this contour). Schema **not** implemented. Correction Center **not** implemented. Cancellation **DEFERRED / NOT IMPLEMENTED**.

PSR-P0-CORE = **ACCEPTED DESIGN / NOT IMPLEMENTED** (`audit/08.04`; canonical through the reviewed docs merge). Closes remaining PRE-SCHEMA questions. Canonical design; **not** runtime implementation.

PSR-P1 schema contract = **ACCEPTED DESIGN / NOT IMPLEMENTED** (`audit/08.05`; canonical through the reviewed docs merge). Independent Review #1 = **PASS WITH NON-BLOCKING FINDINGS** (P0=0, P1=0). Exact `InventoryMovement` schema frozen. Prisma/migration **NOT STARTED**. Canonical design; **not** runtime implementation. Implementation is **not** authorized by the Independent Review cycle.

`PSR-Q-001` / `PSR-Q-002` / `PSR-Q-005` / `PSR-Q-007` / `PSR-Q-008` = **CLOSED / ACCEPTED**.

`PSR-DESIGN-001` / `PSR-DESIGN-002` = **CLOSED / ACCEPTED**.

NEXT after reviewed merge of `08.05`: PSR-P1 Prisma/migration of empty `InventoryMovement` in **SHADOW**, only after a separate implementation prompt. Does **not** mean dual-write, authoritative ledger, production deploy, paper removal, `production_cost_flow` activation, or Correction Center. `PSR-Q-003` / `Q4` / `Q6` remain later-timing.

## 5.1 Temporary operational rule — TORCOVKA delete

`ACCEPTED` until an explicit erroneous-cancellation flow exists:

**`DO NOT DELETE TORCOVKA OPERATIONS`**

Reason: generic TORCOVKA delete reverses produced `BlankStock` but **intentionally does not restore** `RailLot` remaining quantity (`INC-001-F1`). That is how `ПАК-40-1280-01-7` vanished from the terminal after the incident op was deleted.

Correction of a **live** TORCOVKA must use existing correction actions (`correctTorcovkaRailsTaken`, line quantity edit), not delete.

This rule remains operational. Application containment is **deployed in production** (first at `3608b36`; still present on running `0686d00`): the server rejects generic TORCOVKA delete before any mutation. That does **not** restore `ПАК-40-1280-01-7` and does **not** implement `cancelErroneousTorcovka`. Do not treat containment as a production-data fix. Cancellation remains deferred (`audit/08.03` §9).

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

Application/main BASE at ARCH-2 acceptance: `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` (**historical**; docs merge ≠ that-cycle production deploy). Current production application: `0686d00` (see §4).

Forward-looking architecture so Stell22 can become the only warehouse/production operational source of truth. PSR namespace. **Not** a reopen of AUDIT 1. Architecture contract accepted; **not** implementation complete.

Correction-history production-correction slice of `PSR-DESIGN-001` / `PSR-Q-001`: **DECIDED / ACCEPTED** 2026-09-17 in `audit/08.03` (`ProductionOperationMutation`). Remainder + `PSR-Q-002` / `Q5` / `Q7` / `Q8` / `PSR-DESIGN-002`: **CLOSED / ACCEPTED** 2026-09-17 in `audit/08.04`. PSR-P0 = **COMPLETE / ACCEPTED** as architecture/design contract only. PSR-P1 schema contract: **ACCEPTED DESIGN / NOT IMPLEMENTED** 2026-09-17 in `audit/08.05`. Prisma/migration **NOT STARTED**.

## 13. Current next step

`NEXT = reviewed merge of audit/08.05, then a separate PSR-P1 implementation prompt: empty InventoryMovement Prisma/migration in SHADOW.`

PSR-P0 = **COMPLETE / ACCEPTED** as an architecture/design contract only (`08.03` + `08.04`). Not runtime.

PSR-P1 schema contract = **ACCEPTED DESIGN / NOT IMPLEMENTED** (`08.05`). Prisma/migration still **NOT STARTED**. Does **not** mean dual-write, authoritative ledger, production deploy, paper removal, `production_cost_flow` activation, or Correction Center.

Do **not** implement InventoryMovement Prisma/dual-write/cutover from this file. Wait for reviewed merge of `08.05` and a separate implementation prompt.

Do **not** implement `ProductionOperationMutation` schema or Correction Center in this documentation cycle.

Do **not** start AUDIT 2. AUDIT 2 remains `NOT STARTED` / `NEXT AFTER INC-001`.

INC-001 remains OPEN (containment deployed on `0686d00`; physical facts still required before any production-data correction). ARCH-2 / 08.03 / 08.04 do not close it. Cancellation remains deferred.

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
| PSR-P1 Prisma/migration | **NOT STARTED**. Implementation **not** authorized. |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Deploy | **NO** |
| Next | Reviewed merge of `08.05`. Then a separate implementation prompt: empty InventoryMovement table in SHADOW. Not dual-write. Not deploy. |
