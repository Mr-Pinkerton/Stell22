# Stell22 Audit — Index

Updated: 2026-09-17

This is the canonical audit navigation and **master registry** for Stell22.

Business domain: ERP/MES for **rack/shelving manufacturing (производство стеллажей)**.
Do not import Woodveri door-manufacturing entities or workflows.

---

## A. CURRENT CHECKPOINT

| | |
| --- | --- |
| Repository | `Mr-Pinkerton/Stell22` |
| Branch | `main` is canonical. |
| Application-code checkpoint | `92532e818df41160b434caac2c6d94933e93d810` — `Merge pull request #7 from Mr-Pinkerton/feat/psr-p1-inventory-movement-shadow-schema`. Production Deploy `35228794988` SUCCESS. PSR-P1 empty SHADOW schema deployed; `InventoryMovement` rows = 0. Prior prod SHA `0686d00` (deploy `35204366279`) is **historical**. Containment SHA `3608b36` remains in the running tree. |
| Docs on `main` | AUDIT 1 artifact `08.01` (`COMPLETE / REVIEWED`). ARCH-2 artifact `08.02` (`ACCEPTED / REVIEWED`). PSR-P0-CORR artifact `08.03` (`ACCEPTED DESIGN / NOT IMPLEMENTED`). PSR-P0-CORE artifact `08.04` (`ACCEPTED DESIGN / NOT IMPLEMENTED`). PSR-P1 schema contract `08.05` (**ACCEPTED DESIGN**; historical **NOT IMPLEMENTED** at contract creation preserved). PSR-P1 closeout `08.06` (`COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY`). INDEX/PROJECT as last merged. |
| ARCH-2 | `audit/08.02-primary-system-readiness-architecture.md` — **`ACCEPTED / REVIEWED`**. Independent Review #1 = REQUEST CHANGES (R1…R6 CLOSED/PASS). Independent Review #2 = REQUEST CHANGES (R7…R8 CLOSED/PASS). Independent Review #3 = **PASS / ACCEPT** (new blockers = 0). Architecture contract accepted; **not** full PSR implementation complete. `PSR-Q-001` / `Q2` / `Q5` / `Q7` / `Q8` = **CLOSED / ACCEPTED** in `08.04` (design only). |
| PSR-P0 | **COMPLETE / ACCEPTED** as an architecture/design contract only (`08.03` + `08.04`). Not runtime. Correction Center **not** implemented. Cancellation **DEFERRED / NOT IMPLEMENTED**. |
| PSR-P1 | **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`08.06`). Schema contract `08.05` remains **ACCEPTED DESIGN** (do not rewrite its historical **NOT IMPLEMENTED** header). Empty unused SHADOW-capable table; row count = **0**; no runtime writers. PSR-P2 **NOT STARTED**. NEXT = **PSR-P2 PRE-DUAL-WRITE CONTRACT / PRECONDITIONS**. |
| Audit program | STEP 0 recovery **COMPLETE**. **AUDIT 1 = COMPLETE / REVIEWED** (not reopened). **ARCH-2 = ACCEPTED / REVIEWED** (architecture contract). Not a new AUDIT 1 defect count. **AUDIT 2 is NOT started.** |
| Production incident | **`INC-001` = `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION`**. Finding **`INC-001-F1` P1 / CONFIRMED**. Generic TORCOVKA delete `CONTAINED IN PRODUCTION`. Package data **not** corrected. `ARCH-P1-001` unrelated to INC-001. |
| `production_cost_flow` | inactive (delivery state; see `PROJECT.md`) |
| `ARCH-P1-001` | **OPEN / CONFIRMED**. Scope = `production_cost_flow` **ACTIVE** UPAKOVKA quantity-edit path. Inactive `prepareUpakovkaEdit` already unions old ∪ current refs. Not fixed. |

Always verify current `main` HEAD before relying on git SHA. Production **application** SHA `92532e8` after Production Deploy `35228794988`. Historical SHA `0686d00` / `71a01b4` / docs-merge SHAs `bd82aa0` (08.03) / `b11c37d` (08.04) / `2f8ec8d` (08.05) are not rewritten.

`08.01` = current-system architecture audit. `08.02` = accepted primary-system readiness architecture contract. They answer different questions. Do not treat 08.02 as a reopen of AUDIT 1. `ACCEPTED / REVIEWED` does **not** mean full PSR implementation complete, paper removable, or `production_cost_flow` active. PSR-P1 empty SHADOW schema **is** deployed (`08.06`); that is not primary-system readiness.

---

## B. SOURCE OF TRUTH

1. Current GitHub `main` (code + committed audit documents).
2. `PROJECT.md` — owner decisions, package/deploy/activation, next step.
3. This `audit/AUDIT-INDEX.md` — audit structure and status.
4. Audit documents under `audit/*.md`.
5. Historical docs (`docs/AUDIT-*`) — superseded July 2026 corpus.
6. Cursor/chat transcripts — working evidence only, never canonical.

If sources conflict, verify GitHub `main` and record the divergence. Do not reopen closed findings without new evidence.

---

## C. AUDIT FILE CONTRACT

1. Permanent Stell22 audit documents live **only** under `<repo>/audit/`.
2. Exceptions outside `audit/`: only `START-HERE.md` and `PROJECT.md`.
3. **Every** persistent markdown file directly in `audit/` **must** appear in section D of this index.
4. Creating, completing, renaming, moving, superseding, or changing the status of an audit document **must** update this index in the same working cycle.
5. Cursor/chat output without a file under `audit/` **and** a matching INDEX row = `UNVERIFIED / NOT CANONICAL`.
6. Always-on Cursor rule: `.cursor/rules/audit-truth.mdc`. Constitution: `audit/00-audit-principles.md`.
7. Allowed legacy exception: the two July files under `docs/` listed in section F (historical; not moved into `/audit`).

Audit loop: `find -> prove -> classify -> record -> continue`. Do not auto-patch every finding.

---

## D. MASTER AUDIT REGISTRY

Every file listed below exists under `audit/` unless noted. `01.16` and `01.17` **never existed** (recovery + git history); that gap is not an error.

Canonical? = living copy in `/audit` **on `main`**. A file may occupy the canonical **path** on a review branch before merge; that is not main truth.

Status vocabulary: `ACTIVE`, `COMPLETE`, `COMPLETE / REVIEWED`, `ACCEPTED / REVIEWED`, `IMPLEMENTED`, `CLOSED`, `DEFERRED BY OWNER`, `DESIGN RISK`, `SUPERSEDED`, `HISTORICAL`, `PLAN`, `NEXT`, `BLOCKED`, `UNKNOWN — NEEDS REVIEW`, `PROPOSED / INDEPENDENT REVIEW REQUIRED`.

### D.0 Index and recovery

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/AUDIT-INDEX.md` | Program | Index | `92532e8` app / this cycle | `ACTIVE` | YES | Master registry. Update in the same cycle as any audit-file change. |
| `audit/00-local-audit-recovery.md` | Recovery | Recovery report | Local scan @ `d9f940e` | `HISTORICAL` | YES | `RECOVERY COMPLETE / HISTORICAL REFERENCE`. Not a findings register. |

### D.1 Этап 00 — charter / maps / backlog

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/00-audit-principles.md` | Charter | Charter | Owner 2026-09-04 | `ACTIVE` | YES | Current-model over old v2. Drift ≠ automatic bug. |
| `audit/00-audit-backlog.md` | Queue | Backlog | этап 0 | `ACTIVE` | YES | Deep-audit queue. Later 00.5/01/02/03 covered many items; leftover rows are not auto-bugs. |
| `audit/00-project-map.md` | System map | Map | `f3ebbef42f388f4da9761d430464c4b35117b925` | `COMPLETE` | YES | Frozen 2026-09-03 snapshot. SHA exists locally. Stale vs current app HEAD. |
| `audit/00-business-flows.md` | Flows | Map | этап 0 | `COMPLETE` | YES | State machines as of этап 0. |
| `audit/00-data-model.md` | Data model | Map | этап 0 | `COMPLETE` | YES | Prisma model as of этап 0. |
| `audit/00-invariants.md` | Invariants | Map | этап 0 | `COMPLETE` | YES | Describes then-current code behavior. |

### D.2 Этап 00.5 — security

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/00.5-security-boundaries.md` | Security | Map | `f3ebbef4…` | `COMPLETE` | YES | Server Action / route surface. |
| `audit/00.5-findings.md` | Security | Findings | `f3ebbef4…` | `COMPLETE` | YES | SEC-001…007 recorded. File itself does **not** record post-fix card status. Later commit `5479580` hardened actions. Do not reopen without new evidence; do not invent CLOSED here. |
| `audit/00.5-remediation-classification.md` | Security | Plan | pre-remediation export inventory | `IMPLEMENTED` | YES | Classification used for Server Action policy / `5479580`. |

### D.3 Этап 01 — data integrity register

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/01-data-integrity-findings.md` | Data integrity | Findings register | `4809c0cfdce11ada8563d6c6d8cb7f7069c90c85` | `ACTIVE` | YES | Living DI register. DI-001…010, 013–016, 018–020 `CLOSED IN PRODUCTION`. DI-011 / DI-017 `DEFERRED BY OWNER`. DI-012 `DESIGN RISK`. |
| `audit/01-data-integrity-map.md` | Data integrity | Map | `9b5ed66da36543c3a58d7ab8e392fcd19e78b9c1` | `COMPLETE` | YES | WRITE PATHS / transactions. |
| `audit/01-data-integrity-invariants.md` | Data integrity | Invariants | этап 1 | `COMPLETE` | YES | Classes A/B/C/D. |

### D.4 Этап 01.xx — reviews and plans (each file)

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/01.1-p1-remediation-plan.md` | DI P1 | Plan | `5479580bdb1a33f53dec8005a2354456537ec8d4` | `IMPLEMENTED` | YES | DI-001/002/003/004/010/013 closed in production. DI-011 out of scope (deferred). |
| `audit/01.2-cost-freeze-review.md` | Cost freeze | Review | `9b5ed66d…` | `COMPLETE` | YES | DI-005/006/018/019. |
| `audit/01.3-cost-freeze-remediation-plan.md` | Cost freeze | Plan | `9b5ed66d…` | `IMPLEMENTED` | YES | Closed in production (see findings). |
| `audit/01.4-torcovka-input-safety-review.md` | TORCOVKA | Review | `cc571f5075b873b3f0ded733eedc438792562b40` | `COMPLETE` | YES | Opened DI-020. |
| `audit/01.5-torcovka-input-safety-remediation-plan.md` | TORCOVKA | Plan | `cc571f50…` | `IMPLEMENTED` | YES | DI-020 closed in production. |
| `audit/01.6-inventory-provenance-review.md` | Inventory | Review | `931efe87f98431e8fb27dd11f4e3dd7e61738a03` | `COMPLETE` | YES | DI-009. |
| `audit/01.7-inventory-integrity-remediation-plan.md` | Inventory | Plan | `931efe87…` | `IMPLEMENTED` | YES | Shipped `1f411e5`. |
| `audit/01.8-inventory-draft-uniqueness-review.md` | Inventory | Review | `1f411e5e0f8018069e9f91d69439ff306fdc2572` | `COMPLETE` | YES | DI-016. |
| `audit/01.9-inventory-draft-uniqueness-remediation-plan.md` | Inventory | Plan | `1f411e5e…` | `IMPLEMENTED` | YES | DI-016 closed in production. |
| `audit/01.10-terminal-idempotency-review.md` | Terminal | Review | `16015d5ece9af8514a0ec3dc9c0fb913c15ced48` | `COMPLETE` | YES | DI-007 / DI-008. |
| `audit/01.13-terminal-idempotency-remediation-plan.md` | Terminal | Plan | `16015d5e…` | `IMPLEMENTED` | YES | DI-007 / DI-008 closed in production. |
| `audit/01.11-terminal-draft-persistence-review.md` | Terminal | Review | `16015d5e…` | `COMPLETE` | YES | Draft persistence. |
| `audit/01.12-terminal-draft-persistence-remediation-plan.md` | Terminal | Plan | `16015d5e…` | `IMPLEMENTED` | YES | Shipped `64fa9fa` / follow-ups. |
| `audit/01.14-torcovka-admin-approval-review.md` | TORCOVKA | Review | `327b4ae6e54c15b37314d93b2b0c33563274d877` | `COMPLETE` | YES | EXTREME 4-digit approval. |
| `audit/01.15-torcovka-admin-approval-remediation-plan.md` | TORCOVKA | Plan | `4db2c96e1369a4ec3024814efdc4e270021c6619` | `IMPLEMENTED` | YES | Shipped `8240f4d`. |
| `audit/01.18-payment-operation-uniqueness-review.md` | Payroll | Review | `8240f4d611ac2c8b04834ebd239374199f764fc7` | `COMPLETE` | YES | DI-014 closed in production (`060629e`). |
| `audit/01.19-payroll-rate-snapshot-review.md` | Payroll | Review | `4809c0cf…` | `COMPLETE` | YES | DI-015. |
| `audit/01.20-payroll-rate-snapshot-remediation-plan.md` | Payroll | Plan | `4809c0cf…` | `IMPLEMENTED` | YES | DI-015 closed in production (`13eacea` / `1af5a2a`). |

No `audit/01.16*` or `audit/01.17*`.

### D.5 Этап 02.xx — terminal UX

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/02.01-torcovka-terminal-ui-review.md` | TORCOVKA UI | Review | `4809c0cf…` (runtime `060629e`) | `COMPLETE` | YES | Recovered untracked → canonical. Read-only UI review. No tracked analog under another name. SHA exists. |
| `audit/02.02-torcovka-terminal-ui-plan.md` | TORCOVKA UI | Plan | `4809c0cf…` | `IMPLEMENTED` | YES | Recovered. UI-only plan paired with 02.01. Later terminal commits built on this visual tree (see 02.04). |
| `audit/02.03-terminal-functional-ux-review.md` | Terminal UX | Review | `06e9e27361f4f8ba706108ea8509806cc129c5a6` | `COMPLETE` | YES | Recovered. F-01…F-16. No P1. Follow-up 02.04 / 02.06 / 02.07. |
| `audit/02.04-terminal-functional-ux-remediation-plan.md` | Terminal UX | Plan | `06e9e273…` | `IMPLEMENTED` | YES | Owner P2 rules; tasks checked in-doc. Commit `727ea79`. F-05 F5 hydrate explicitly out of scope. |
| `audit/02.05-terminal-ui-commit-regression-review.md` | Terminal UI | Review | `1af5a2a6..06e9e273` | `COMPLETE` | YES | Recovered. No confirmed regression in range. P3 recommendations only. |
| `audit/02.06-terminal-owner-decisions-plan.md` | Terminal UX | Plan | `5046950823870b589c618175297b6ad1fab61a0f` | `IMPLEMENTED` | YES | Owner decisions; shipped `f738c57`. |
| `audit/02.07-terminal-final-p3-review.md` | Terminal UX | Review | `f738c572e9a4c03b98c432689473e39c4c923b3e` | `COMPLETE` | YES | F-02/08/10/12/13 `CLOSED`. F-09 not reproduced. Remaining F-05 etc. preserved, not reopened as new DI. |

### D.6 Этап 03.xx — production cost flow

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/03.01-production-cost-truth-map.md` | Cost | Truth map | `1bf910908f72f478e635a3202fb605cec62176b8` | `COMPLETE` | YES | Read-only. Do not reopen closed DI cards from this map. |
| `audit/03.02-production-cost-flow-architecture.md` | Cost | Architecture | Snapshot `1bf91090`; Package 3 review BASE `77ee6af9691130a2e3411ff6fa558f9e6b7dc17d` | `COMPLETE` | YES | Cost-flow architecture (not whole-system AUDIT 1). Packages 2/3 implemented in code; activation `BLOCKED` (`PROJECT.md`). |

### D.7 AUDIT 1 / ARCH-2 — whole-system architecture (08.xx)

`08.01` and `08.02` are **not** the same audit. `08.01` classifies current-system defects. `08.02` defines primary-system readiness (PSR-*) before Stell22 can be the only warehouse/production SoT. `08.03` is the PSR-P0-CORR production correction-history contract. `08.04` is the PSR-P0-CORE remainder (Q1 remainder, Q2, Q5, Q7, Q8). `08.05` is the PSR-P1 InventoryMovement schema contract. `08.06` is the PSR-P1 implementation/deployment closeout. Do not reopen AUDIT 1 defect counts from 08.02/08.03/08.04/08.05/08.06.

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/08.01-audit-1-system-architecture.md` | Whole system | Architecture audit | Repo `d1f46e46232499b61f55e754b0bd70ddc5924bca`; app `d9f940e8540801bdb27dd72210193f5e4ab038c3` | `COMPLETE / REVIEWED` | YES | ChatGPT adversarial review accepted. New P0=0. New P1=`ARCH-P1-001` (OPEN / CONFIRMED; ACTIVE-path scope). New P2/P3=0. Simplify=`ARCH-SIMPLIFY-001`. **Do not reopen.** AUDIT 2 is a later finance audit, not started. |
| `audit/08.02-primary-system-readiness-architecture.md` | Primary-system readiness | Architecture contract | App BASE at acceptance `71a01b4` (**historical**). Current prod app `92532e8`. | `ACCEPTED / REVIEWED` | YES | ARCH-2. Review #1 REQUEST CHANGES → R1…R6 CLOSED/PASS. Review #2 REQUEST CHANGES → R7…R8 CLOSED/PASS. Review #3 **PASS / ACCEPT** (new blockers = 0). Architecture contract accepted; **not** full PSR implementation complete. PSR-P0-CORR addendum §24.1. PSR-P0-CORE addendum §24.2. PSR-P1 schema addendum §24.3 (historical). PSR-P1 deploy closeout addendum §24.4. Generic `CommandExecution` not used. |
| `audit/08.03-psr-p0-correction-history-contract.md` | Production correction history | Architecture contract | App `0686d00`; GitHub main at 08.03 merge `bd82aa0` | `ACCEPTED DESIGN / NOT IMPLEMENTED` | YES | PSR-P0-CORR. Target = `ProductionOperationMutation`. **At 08.03 acceptance:** global `PSR-Q-001` / `PSR-DESIGN-001` = **OPEN / PARTIALLY RESOLVED**. **Subsequently CLOSED / ACCEPTED** by `08.04`. Do not rewrite 08.03 as if it closed global Q1. v1 HOURS delete **must be blocked**. v1 TORCOVKA line-qty **must reject frozen batch**. Schema **not** implemented. Correction Center **not** implemented. Cancellation **DEFERRED**. INC-001 remains OPEN. |
| `audit/08.04-psr-p0-core-contract.md` | PSR-P0 remaining PRE-SCHEMA | Architecture contract | App `0686d00`; GitHub main at creation `bd82aa0` | `ACCEPTED DESIGN / NOT IMPLEMENTED` | YES | PSR-P0-CORE. Closes Q1 remainder, Q2, Q5, Q7, Q8 and DESIGN-001/002. PSR-P0 **COMPLETE / ACCEPTED** as design contract only. Canonical design; **not** runtime implementation. |
| `audit/08.05-psr-p1-inventory-movement-schema-contract.md` | PSR-P1 InventoryMovement schema | Architecture contract | App `0686d00` at contract creation; GitHub main at creation `b11c37d` | `ACCEPTED DESIGN` (historical **NOT IMPLEMENTED** header preserved) | YES | PSR-P1 schema contract. Independent Review #1 = **PASS WITH NON-BLOCKING FINDINGS** (P0=0, P1=0). Exact enums/model/no-FK/partial indexes/CHECKs/snapshots. AUTHORITATIVE-only opening UNIQUEs. SHADOW may carry rehearsal `epochId`. Do not rewrite contract-creation **NOT IMPLEMENTED**. Current implementation/deploy: `08.06`. |
| `audit/08.06-psr-p1-deployment-closeout.md` | PSR-P1 InventoryMovement SHADOW deploy | Closeout / evidence | App/main `92532e8`; deploy `35228794988` | `COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY` | YES | PR #7 merged. Migration `20260917150000_psr_p1_inventory_movement_shadow` applied. Table exists. Row count = 0. No runtime writers. PSR-P2 **NOT STARTED**. |

### D.8 Production incidents

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/INC-001-torcovka-whole-package-production-incident.md` | TORCOVKA / RailLot | Production incident | Prod HEAD `3608b36`; main CI `34357390695`; deploy `34357726641` | `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION` | YES | Generic delete contained. Package `ПАК-40-1280-01-7` remaining=0 unchanged. Scenarios A/B not implemented. `INC-001-F1` P1. |

---

## E. AUDIT 1 — SYSTEM ARCHITECTURE

| | |
| --- | --- |
| Filename | `audit/08.01-audit-1-system-architecture.md` |
| Recovery | Previously **not found**; this cycle **created** (not restored from memory) |
| Status | `COMPLETE / REVIEWED` |
| BASE | Repo HEAD `d1f46e46232499b61f55e754b0bd70ddc5924bca`; application `d9f940e8540801bdb27dd72210193f5e4ab038c3` |
| New P0 | 0 |
| New P1 | `ARCH-P1-001` (`OPEN / CONFIRMED`; not patched; ACTIVE UPAKOVKA qty-edit path) |
| New P2 / P3 | 0 |
| Simplify | `ARCH-SIMPLIFY-001` (temporary migration debt) |
| Next from AUDIT 1 | **AUDIT 2 — FINANCE & MONEY INTEGRITY** (still **not started**; not silently opened by ARCH-2) |

`03.02` is production **cost-flow** architecture. It is **not** a substitute for AUDIT 1.

`08.02` is **ARCH-2 primary-system readiness**. It is **not** a substitute for AUDIT 1 and does **not** change the AUDIT 1 counts above.

`08.03` is **PSR-P0-CORR** (production correction-history contract). Status = **ACCEPTED DESIGN / NOT IMPLEMENTED**. It is **not** a substitute for 08.02 and does **not** implement schema.

`08.04` is **PSR-P0-CORE**. Status = **ACCEPTED DESIGN / NOT IMPLEMENTED**. Canonical on `main` after this reviewed merge. It does **not** implement InventoryMovement.

`08.05` is **PSR-P1 InventoryMovement schema contract**. Status at contract creation = **ACCEPTED DESIGN / NOT IMPLEMENTED** (preserved in that file). Current implementation/deploy is recorded in `08.06`.

`08.06` is **PSR-P1 SHADOW schema deployment closeout**. Status = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY**. Empty unused table. No runtime writers. PSR-P2 **NOT STARTED**.

---

## F. Historical / superseded (outside `/audit`)

Allowed legacy exception. **Do not move** into `/audit`.

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `docs/AUDIT-ERP-2026-07-12.md` | Whole product (July) | Report | `5268259` | `HISTORICAL` / `SUPERSEDED` | NO | July 2026. Used v2 as calculation source of truth — superseded by `audit/00-audit-principles.md`. |
| `docs/AUDIT-FIX-CHECKLIST.md` | July follow-up | Checklist | 2026-07-12 | `HISTORICAL` / `SUPERSEDED` | NO | A1–A23 checklist for the July audit. |

---

## G. Historical review artifacts (not audit documents)

Local `*.patch`, `*-review-bundle*`, zip bundles, temp snapshots, other worktree copies, and unreachable git blobs exist on this machine.

They are evidence/history, **not** audit documents. They were **not** moved into `/audit` and were **not** deleted in canonicalization.

See `audit/00-local-audit-recovery.md`.

---

## H. Current audit queue

### STEP 0 — LOCAL AUDIT RECOVERY

Status: `COMPLETE`

### STEP 0.5 — AUDIT CANONICALIZATION

Status: `COMPLETE` (`d1f46e4`).

### AUDIT 1 — SYSTEM ARCHITECTURE

Status: `COMPLETE / REVIEWED`

Artifact: `audit/08.01-audit-1-system-architecture.md`

BASE repo: `d1f46e46232499b61f55e754b0bd70ddc5924bca`. Application: `d9f940e8540801bdb27dd72210193f5e4ab038c3`. New P0=0. New P1=`ARCH-P1-001` (OPEN / CONFIRMED; ACTIVE path). New P2/P3=0. Simplify=`ARCH-SIMPLIFY-001`.

**Do not reopen AUDIT 1.**

### ARCH-2 — PRIMARY-SYSTEM READINESS

Status: `ACCEPTED / REVIEWED`

Artifact: `audit/08.02-primary-system-readiness-architecture.md` (canonical ARCH-2 architecture on `main` after Review #3 merge)

Application/main BASE at ARCH-2 acceptance: `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` (**historical**; **not** a later production application SHA rewrite). Current production application: `92532e8`.

Independent Review #1: **REQUEST CHANGES** (ARCH2-R1…R6 **CLOSED / PASS**; not reopened).

Independent Review #2: **REQUEST CHANGES** (ARCH2-R7…R8 **CLOSED / PASS**; not reopened).

Independent Review #3: **PASS / ACCEPT**. New architecture blockers = **0**. R1…R8 = **CLOSED / PASS**.

`ACCEPTED / REVIEWED` = architecture **contract** accepted. It does **not** mean PSR implementation complete, primary-system readiness achieved, ledger deployed, paper removable, or `production_cost_flow` active.

Forward-looking foundation so Stell22 can become the only warehouse/production operational source of truth. PSR-MUST / PSR-DESIGN / PSR-DEFER / PSR-REJECT namespace. **Not** a new AUDIT 1 defect register.

### PSR-P0 — PRE-SCHEMA CONTRACTS

Status: **COMPLETE / ACCEPTED** as an architecture/design contract only. **Not** runtime.

Artifacts: `audit/08.03-psr-p0-correction-history-contract.md` (correction history) and `audit/08.04-psr-p0-core-contract.md` (Q1 remainder, Q2, Q5, Q7, Q8) — both **`ACCEPTED DESIGN / NOT IMPLEMENTED`**. `08.04` is the canonical PSR-P0-CORE contract on `main` after this reviewed merge. Canonical design; **not** runtime implementation.

`PSR-Q-001` / `PSR-Q-002` / `PSR-Q-005` / `PSR-Q-007` / `PSR-Q-008` = **CLOSED / ACCEPTED**.

`PSR-DESIGN-001` / `PSR-DESIGN-002` = **CLOSED / ACCEPTED**.

`PSR-Q-003` / `Q4` / `Q6` remain later-timing (`Q4` before dual-write / P2; `Q3` before physical recon / P4; `Q6` before FINAL epoch / P6).

Correction Center **not** implemented. Cancellation **DEFERRED / NOT IMPLEMENTED**.

PSR-P1 empty SHADOW table is **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`08.06`). Not dual-write, not authoritative, not paper removal, not `production_cost_flow` activation, not Correction Center. AUDIT 2 not started.

### PSR-P1 — INVENTORY MOVEMENT SHADOW SCHEMA

Status: **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY**. Schema contract `08.05` remains **ACCEPTED DESIGN** (historical **NOT IMPLEMENTED** at contract creation preserved). Independent Review #1 = **PASS WITH NON-BLOCKING FINDINGS** (P0=0, P1=0).

Artifacts: `audit/08.05-psr-p1-inventory-movement-schema-contract.md` (exact schema) and `audit/08.06-psr-p1-deployment-closeout.md` (implementation/deploy evidence). Production table exists. Row count = **0**. No runtime writers.

**NEXT = PSR-P2 PRE-DUAL-WRITE CONTRACT / PRECONDITIONS.** Close `PSR-Q-004`, R-10, R-11 before PSR-P2. Close R-07 before movement writers. Close R-04 / R-05 / R-06 before their contour dual-write. Not dual-write, not OPENING_BALANCE data, not AUTHORITATIVE rows, not projection change, not Correction Center.

### INC-001 — TORCOVKA whole-package production incident

Status: `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION`

Artifact: `audit/INC-001-torcovka-whole-package-production-incident.md`

Finding: `INC-001-F1` (P1) — after TORCOVKA delete, no application path to restore falsely consumed `RailLot`. Generic delete path is `CONTAINED IN PRODUCTION` (first at `3608b36`; still present on running `92532e8`). Proper `cancelErroneousTorcovka` `NOT IMPLEMENTED`. Damaged package `NOT CORRECTED`. Scenario A vs B still requires physical facts. Employee not recoverable. ARCH-2 / `08.03` / `08.04` / `08.06` do **not** close INC-001. Cancellation remains deferred.

### AUDIT 2 — FINANCE & MONEY INTEGRITY

Status: `NOT STARTED` (`NEXT AFTER INC-001`)

ARCH-2 / `08.02` does **not** silently start AUDIT 2. Audit-only when started. Do not open as a file until INC-001 production correction is decided. High-level scope: CashFlow, Account/balance, Statement/import, Deal allocations, transfers, Payment/payroll money, corrections/voids, transaction boundaries, idempotency, confirmed/unconfirmed money, reconciliation, Sale vs money where relevant.
