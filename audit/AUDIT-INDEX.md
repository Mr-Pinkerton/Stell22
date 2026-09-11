# Stell22 Audit — Index

Updated: 2026-09-12

This is the canonical audit navigation and **master registry** for Stell22.

Business domain: ERP/MES for **rack/shelving manufacturing (производство стеллажей)**.
Do not import Woodveri door-manufacturing entities or workflows.

---

## A. CURRENT CHECKPOINT

| | |
| --- | --- |
| Repository | `Mr-Pinkerton/Stell22` |
| Branch | `main` (this INDEX update lands on `audit/arch2-primary-system-readiness` until merge) |
| Application-code checkpoint | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` — `Merge pull request #1 from Mr-Pinkerton/integration/p2025-di020`. Production Deploy `34635510843` SUCCESS. Prior containment SHA `3608b36` remains historical INC-001 containment; it is no longer the running SHA. |
| Docs checkpoint | ARCH-2 draft `audit/08.02-primary-system-readiness-architecture.md` (this cycle). AUDIT 1 artifact `08.01` unchanged. |
| Audit program | STEP 0 recovery **COMPLETE**. **AUDIT 1 = COMPLETE / REVIEWED** (not reopened). **ARCH-2 = PROPOSED / INDEPENDENT REVIEW REQUIRED** (primary-system readiness; not a new AUDIT 1 defect count). **AUDIT 2 is NOT started.** |
| Production incident | **`INC-001` = `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION`**. Finding **`INC-001-F1` P1 / CONFIRMED**. Generic TORCOVKA delete `CONTAINED IN PRODUCTION`. Package data **not** corrected. `ARCH-P1-001` unrelated to INC-001. |
| `production_cost_flow` | inactive (delivery state; see `PROJECT.md`) |
| `ARCH-P1-001` | **OPEN / CONFIRMED**. Scope = `production_cost_flow` **ACTIVE** UPAKOVKA quantity-edit path. Inactive `prepareUpakovkaEdit` already unions old ∪ current refs. Not fixed. |

Always verify current `main` HEAD before relying on SHAs above.

`08.01` = current-system architecture audit. `08.02` = forward-looking primary-system readiness architecture. They answer different questions. Do not treat 08.02 as a reopen of AUDIT 1.

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

Status vocabulary: `ACTIVE`, `COMPLETE`, `COMPLETE / REVIEWED`, `IMPLEMENTED`, `CLOSED`, `DEFERRED BY OWNER`, `DESIGN RISK`, `SUPERSEDED`, `HISTORICAL`, `PLAN`, `NEXT`, `BLOCKED`, `UNKNOWN — NEEDS REVIEW`, `PROPOSED / INDEPENDENT REVIEW REQUIRED`.

Canonical? = this path is the living copy in `/audit` on `main`.

### D.0 Index and recovery

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/AUDIT-INDEX.md` | Program | Index | `71a01b4` app / this cycle | `ACTIVE` | YES | Master registry. Update in the same cycle as any audit-file change. |
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

`08.01` and `08.02` are **not** the same audit. `08.01` classifies current-system defects. `08.02` defines primary-system readiness (PSR-*) before Stell22 can be the only warehouse/production SoT. Do not reopen AUDIT 1 defect counts from 08.02.

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/08.01-audit-1-system-architecture.md` | Whole system | Architecture audit | Repo `d1f46e46232499b61f55e754b0bd70ddc5924bca`; app `d9f940e8540801bdb27dd72210193f5e4ab038c3` | `COMPLETE / REVIEWED` | YES | ChatGPT adversarial review accepted. New P0=0. New P1=`ARCH-P1-001` (OPEN / CONFIRMED; ACTIVE-path scope). New P2/P3=0. Simplify=`ARCH-SIMPLIFY-001`. **Do not reopen.** AUDIT 2 is a later finance audit, not started. |
| `audit/08.02-primary-system-readiness-architecture.md` | Primary-system readiness | Architecture draft | Repo/app `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` | `PROPOSED / INDEPENDENT REVIEW REQUIRED` | YES | ARCH-2. Physical `InventoryMovement` + projections. PSR-MUST-001…007. Not a reopen of AUDIT 1. No valuation journal. Generic `CommandExecution` not mandatory. |

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

Status: `PROPOSED / INDEPENDENT REVIEW REQUIRED`

Artifact: `audit/08.02-primary-system-readiness-architecture.md`

BASE: `71a01b40008cf6da7cbc843b3b0dbaa31cf01853`.

Forward-looking foundation so Stell22 can become the only warehouse/production operational source of truth. PSR-MUST / PSR-DESIGN / PSR-DEFER / PSR-REJECT namespace. **Not** a new AUDIT 1 defect register.

NEXT: independent adversarial review of `audit/08.02` before accepting implementation packages.

### INC-001 — TORCOVKA whole-package production incident

Status: `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION`

Artifact: `audit/INC-001-torcovka-whole-package-production-incident.md`

Finding: `INC-001-F1` (P1) — after TORCOVKA delete, no application path to restore falsely consumed `RailLot`. Generic delete path is `CONTAINED IN PRODUCTION` (first at `3608b36`; still present on running `71a01b4`). Proper `cancelErroneousTorcovka` `NOT IMPLEMENTED`. Damaged package `NOT CORRECTED`. Scenario A vs B still requires physical facts. Employee not recoverable. ARCH-2 does **not** close INC-001.

### AUDIT 2 — FINANCE & MONEY INTEGRITY

Status: `NOT STARTED` (`NEXT AFTER INC-001`)

ARCH-2 / `08.02` does **not** silently start AUDIT 2. Audit-only when started. Do not open as a file until INC-001 production correction is decided. High-level scope: CashFlow, Account/balance, Statement/import, Deal allocations, transfers, Payment/payroll money, corrections/voids, transaction boundaries, idempotency, confirmed/unconfirmed money, reconciliation, Sale vs money where relevant.
