# Stell22 — Project Journal / Source of Truth

Updated: 2026-09-09

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

Last verified code checkpoint before recovery-document commits:

`d9f940e8540801bdb27dd72210193f5e4ab038c3`

`fix: enforce prisadka inventory boundary`

Package 3.1 code state at that checkpoint:

- committed;
- pushed;
- deployed dormant;
- PRISADKA inventory-boundary blocker closed;
- `production_cost_flow` inactive;
- bootstrap not applied;
- business money initialization not performed;
- activation remains blocked.

Always establish current HEAD before starting new work because documentation commits may be newer than the code checkpoint above.

## 5. Current work mode

`ACTIVE MODE: SYSTEM AUDIT`

The current objective is not an endless chain of local fixes. Audit the system as a whole, then group confirmed findings into coherent remediation packages.

Audit loop:

`find -> prove -> classify -> record -> continue`

Only after a logical audit section:

`group -> prioritize -> remediation package`

Do not automatically fix every audit finding.

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

Known remaining activation audit candidate from previous work:

UPAKOVKA correction may need inventory-boundary coverage for current BOM references (`old ∪ current refs`). It must be proven/classified in the audit lane before becoming a fix.

## 11. Local audit recovery

Status: `COMPLETE`

Local STEP 0 recovery (`audit/00-local-audit-recovery.md`) and STEP 0.5 canonicalization:

- `08.01-audit-1-system-architecture.md` did **not** exist on this PC (repo, worktrees, temp, Cursor folders, stash, reflog, unreachable objects). Status: `NOT PREVIOUSLY CREATED / RERUN REQUIRED`.
- 39 audit markdown files were in `/audit` before canonicalization (35 tracked; four `02.xx` untracked canonical candidates).
- The four recovered files are now part of the canonical tree: `audit/02.01-torcovka-terminal-ui-review.md`, `audit/02.02-torcovka-terminal-ui-plan.md`, `audit/02.03-terminal-functional-ux-review.md`, `audit/02.05-terminal-ui-commit-regression-review.md`.
- Conflicting current audit documents: **0**.
- Independent lost Stell22 clone: **none**.
- Historical copies, patches, and review bundles are **not** source of truth. See recovery report. Do not treat them as living findings.

## 12. Previous reported AUDIT 1

A previous Cursor session reported:

`audit/08.01-audit-1-system-architecture.md`

Recovery searched for it and did not find it. It was also absent from GitHub `main`.

Status:

`NOT PREVIOUSLY CREATED / RERUN REQUIRED`

Do not restore or invent that file from memory. Rerun AUDIT 1 against actual current `main`. Existing `audit/00*`–`audit/03*` documents are prior evidence, not a substitute for AUDIT 1. `audit/03.02-production-cost-flow-architecture.md` is cost-flow architecture only.

## 13. Current next step

`NEXT = AUDIT 1 — SYSTEM ARCHITECTURE`

Whole-system architecture. New document (do **not** write it in the canonicalization commit):

`audit/08.01-audit-1-system-architecture.md`

Constraints:

- audit-only; do not modify application code in that pass;
- do not turn findings into patches automatically;
- BASE = actual current `main` application checkpoint (`d9f940e8540801bdb27dd72210193f5e4ab038c3` unless newer **code** has landed);
- use existing `audit/00-*`, `01.*`, `02.*`, `03.*` as prior evidence;
- do not reopen closed findings without new evidence;
- write the result to `audit/08.01-audit-1-system-architecture.md`;
- update `audit/AUDIT-INDEX.md` in the same cycle;
- do not commit/push until ChatGPT reviews the report unless the owner explicitly changes this workflow.

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
