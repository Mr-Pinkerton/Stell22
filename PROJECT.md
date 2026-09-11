# Stell22 — Project Journal / Source of Truth

Updated: 2026-09-12

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

1. GitHub `main`: current code + committed audit documents.
2. This `PROJECT.md`: owner decisions, package/deploy/activation status and current next step.
3. `audit/AUDIT-INDEX.md`: audit navigation/status.
4. `/Projects/Stell22` Library snapshot: cross-chat recovery/cache.
5. Chat/Cursor transcripts: working evidence only.

If sources conflict, verify the actual GitHub `main` and record the divergence.

A Cursor/chat statement without a committed project artifact is not canonical.

## 4. Current verified technical checkpoint

Repository: `Mr-Pinkerton/Stell22`

Branch: `main`

Last verified production application SHA:

`71a01b40008cf6da7cbc843b3b0dbaa31cf01853`

`Merge pull request #1 from Mr-Pinkerton/integration/p2025-di020`

Evidence: GitHub Production Deploy run `34635510843` SUCCESS (2026-09-11, `workflow_dispatch`; Resolve origin/main SHA / CI verify / Deploy origin/main all SUCCESS). Head SHA of that run = `71a01b40008cf6da7cbc843b3b0dbaa31cf01853`.

That deploy includes:

- INC-001 generic TORCOVKA-delete containment (`3608b36`, still in effect);
- UI filter work;
- TORCOVKA BlankStock length canonicalization and railsTaken correction hardening (PR #1).

Prior documented prod SHA (containment-only):

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

`ACTIVE MODE: ARCH-2 PRIMARY-SYSTEM READINESS` (architecture-hardening; documentation)

AUDIT 1 (system architecture) remains `COMPLETE / REVIEWED`. **Do not change AUDIT 1 status. Do not reopen AUDIT 1.**

`AUDIT 2 — FINANCE & MONEY INTEGRITY` is **NOT STARTED**. It remains `NEXT AFTER INC-001`. ARCH-2 does **not** silently start AUDIT 2.

INC-001 remains `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION`. Containment is still in production on `71a01b4`. Do not treat ARCH-2 as a production-data fix. Do not automatically invert INV-047 (generic TORCOVKA delete returning rails).

**Current architecture-hardening work:** ARCH-2 / Primary-System Readiness (`audit/08.02-primary-system-readiness-architecture.md`), status `PROPOSED / INDEPENDENT REVIEW REQUIRED`.

## 5.1 Temporary operational rule — TORCOVKA delete

`ACCEPTED` until an explicit erroneous-cancellation flow exists:

**`DO NOT DELETE TORCOVKA OPERATIONS`**

Reason: generic TORCOVKA delete reverses produced `BlankStock` but **intentionally does not restore** `RailLot` remaining quantity (`INC-001-F1`). That is how `ПАК-40-1280-01-7` vanished from the terminal after the incident op was deleted.

Correction of a **live** TORCOVKA must use existing correction actions (`correctTorcovkaRailsTaken`, line quantity edit), not delete.

This rule remains operational. Application containment is **deployed in production** (first at `3608b36`; still present on running `71a01b4`): the server rejects generic TORCOVKA delete before any mutation. That does **not** restore `ПАК-40-1280-01-7` and does **not** implement `cancelErroneousTorcovka`. Do not treat containment as a production-data fix.

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

Status: `PROPOSED / INDEPENDENT REVIEW REQUIRED`

Artifact: `audit/08.02-primary-system-readiness-architecture.md`

BASE: `71a01b40008cf6da7cbc843b3b0dbaa31cf01853`

Forward-looking architecture so Stell22 can become the only warehouse/production operational source of truth. PSR namespace. **Not** a reopen of AUDIT 1. No application/schema change in this cycle.

## 13. Current next step

`NEXT = independent adversarial review of audit/08.02-primary-system-readiness-architecture.md before accepting any ARCH-2 implementation packages`

Do **not** implement InventoryMovement / dual-write / cutover in this cycle.

Do **not** start AUDIT 2. AUDIT 2 remains `NOT STARTED` / `NEXT AFTER INC-001`.

INC-001 remains OPEN (containment deployed on `71a01b4`; physical facts still required before any production-data correction). ARCH-2 does not close it.

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
