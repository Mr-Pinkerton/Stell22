# Stell22 Audit — Index

Updated: 2026-09-20

This is the canonical audit navigation and **master registry** for Stell22.

Business domain: ERP/MES for **rack/shelving manufacturing (производство стеллажей)**.
Do not import Woodveri door-manufacturing entities or workflows.

---

## A. CURRENT CHECKPOINT

| | |
| --- | --- |
| Repository | `Mr-Pinkerton/Stell22` |
| Branch | `main` is canonical. |
| Application-code checkpoint | `69e0f53993d5b02f27f0fc03682cef492c02d685` — Production Deploy `35510094974` SUCCESS (raw SHADOW writers **DEPLOYED DORMANT / SHADOW INACTIVE**; all nine connected writers **DEPLOYED DORMANT / SHADOW INACTIVE**). Prior prod SHA `0cc8382` (deploy `35502770382`, raw identity prerequisite **DEPLOYED / POST-DEPLOY VERIFIED**) is **historical**. Prior prod SHA `eb02b17` (deploy `35337215903`, R-06 **DEPLOYED / POST-DEPLOY VERIFIED**) is **historical**. Prior `27538a5` (deploy `35329071777`, R-05 **DEPLOYED**) is **historical**. Prior `c14a586` (deploy `35314440036`, R-04 **DEPLOYED**) is **historical**. Prior `de2e1c0` (deploy `35257469956`, PSR-P2 general preconditions **DEPLOYED DORMANT**) is **historical**. Prior `92532e8` (deploy `35228794988`, PSR-P1 empty SHADOW) is **historical**. Containment SHA `3608b36` remains in the running tree. Always verify current `main` HEAD. A later docs-only merge may advance `main`; that merge SHA is **not** a production application SHA. |
| Docs on `main` | AUDIT 1 artifact `08.01` (`COMPLETE / REVIEWED`). ARCH-2 artifact `08.02` (`ACCEPTED / REVIEWED`). PSR-P0-CORR artifact `08.03` (`ACCEPTED DESIGN / NOT IMPLEMENTED`). PSR-P0-CORE artifact `08.04` (`ACCEPTED DESIGN / NOT IMPLEMENTED`). PSR-P1 schema contract `08.05` (**ACCEPTED DESIGN**; historical **NOT IMPLEMENTED** at contract creation preserved). PSR-P1 closeout `08.06` (`COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY`). PSR-P2 general preconditions `08.07` (`ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main`; package **DEPLOYED DORMANT** at `de2e1c0`; Canonical? **YES**). PSR-P2 R-04 `08.08` (`ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED`; Production Deploy `35314440036`). PSR-P2 R-05 identity `08.09` (`ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED`; production `27538a5`; Production Deploy `35329071777`). PSR-P2 R-06 `08.10` (`ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED`; production `eb02b17`; Production Deploy `35337215903`). PSR-P2 P2-GUARD/CI `08.12` (historical **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; current runtime **DEPLOYED DORMANT**; PR #18; merge `643c796`). PSR-P2 Inventory writer prerequisite `08.13` (`IMPLEMENTED / MERGED / DEPLOYED DORMANT`; PR #20). PSR-P2 Inventory SHADOW writer `08.14` (`DEPLOYED DORMANT / SHADOW INACTIVE`; PR #22). PSR-P2 terminal production SHADOW writers `08.15` (`DEPLOYED DORMANT / SHADOW INACTIVE`; PR #24). PSR-P2 R-05 correction SHADOW writer `08.16` (`DEPLOYED DORMANT / SHADOW INACTIVE`; PR #26). PSR-P2 Supply writer prerequisite `08.17` (`COMPLETE / DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED`). PSR-P2 raw identity prerequisite `08.19` (`IMPLEMENTED / MERGED / DEPLOYED / POST-DEPLOY VERIFIED`; Production Deploy `35502770382`). Always verify current `main` HEAD. |
| ARCH-2 | `audit/08.02-primary-system-readiness-architecture.md` — **`ACCEPTED / REVIEWED`**. Independent Review #1 = REQUEST CHANGES (R1…R6 CLOSED/PASS). Independent Review #2 = REQUEST CHANGES (R7…R8 CLOSED/PASS). Independent Review #3 = **PASS / ACCEPT** (new blockers = 0). Architecture contract accepted; **not** full PSR implementation complete. `PSR-Q-001` / `Q2` / `Q5` / `Q7` / `Q8` = **CLOSED / ACCEPTED** in `08.04` (design only). |
| PSR-P0 | **COMPLETE / ACCEPTED** as an architecture/design contract only (`08.03` + `08.04`). Not runtime. Correction Center **not** implemented. Cancellation **DEFERRED / NOT IMPLEMENTED**. |
| PSR-P1 | **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`08.06`). Schema contract `08.05` remains **ACCEPTED DESIGN** (do not rewrite its historical **NOT IMPLEMENTED** header). Empty unused SHADOW-capable table; production row count at P1 closeout = **0**; no runtime writers. |
| PSR-P2 general preconditions | `PSR-Q-004` / R-07 / R-10 / R-11 remain **DEPLOYED DORMANT** (`audit/08.07`; Canonical? **YES**; first deployed at `de2e1c0`, run `35257469956`). R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.08`; Canonical? **YES**; Production Deploy `35314440036`). R-05 identity = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.09`; Canonical? **YES**; production `27538a5`; Production Deploy `35329071777`). R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`; Canonical? **YES**; production `eb02b17`; Production Deploy `35337215903`). P2-GUARD/CI historical implementation status = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; current runtime = **DEPLOYED DORMANT** (`audit/08.12`; PR #18; merge `643c796`). Inventory writer prerequisite historical implementation status = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; current runtime = prerequisite code **DEPLOYED DORMANT** (`audit/08.13`). Inventory SHADOW writer = **DEPLOYED DORMANT / SHADOW INACTIVE** (`audit/08.14`). Terminal production SHADOW writers = `audit/08.15` (**DEPLOYED DORMANT / SHADOW INACTIVE**). R-05 correction writer = `audit/08.16` (**DEPLOYED DORMANT / SHADOW INACTIVE**). Supply writer prerequisite = `audit/08.17` (**COMPLETE / DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**; latest rerun `35502680346`). Supply SHADOW writer = `audit/08.18` (**DEPLOYED DORMANT / SHADOW INACTIVE**). Raw identity prerequisite = `audit/08.19` (**IMPLEMENTED / MERGED / DEPLOYED / POST-DEPLOY VERIFIED**; Production Deploy `35502770382`). Raw SHADOW writers = `audit/08.20` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**; PR #36 merge `0bf2c77`; Production Deploy `35510094974`; deployed application `69e0f53`; source/`main` contours **9**; production dormant contours **9**). Remaining mutation / destructive discovery = `audit/08.21` (**ARCHITECTURE ACCEPTED / REVIEWED**; no implementation). **NEXT = PSR-P2 SAFE DESTRUCTIVE GUARDS IMPLEMENTATION PACKAGE**. Dual-write **NOT STARTED**. |
| Audit program | STEP 0 recovery **COMPLETE**. **AUDIT 1 = COMPLETE / REVIEWED** (not reopened). **ARCH-2 = ACCEPTED / REVIEWED** (architecture contract). Not a new AUDIT 1 defect count. **AUDIT 2 is NOT started.** |
| Production incident | **`INC-001` = `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION`**. Finding **`INC-001-F1` P1 / CONFIRMED**. Generic TORCOVKA delete `CONTAINED IN PRODUCTION`. Package data **not** corrected. `ARCH-P1-001` unrelated to INC-001. |
| `production_cost_flow` | inactive (delivery state; see `PROJECT.md`) |
| `ARCH-P1-001` | **OPEN / CONFIRMED**. Scope = `production_cost_flow` **ACTIVE** UPAKOVKA quantity-edit path. Inactive `prepareUpakovkaEdit` already unions old ∪ current refs. Not fixed. |

Always verify current `main` HEAD before relying on git SHA. Production **application** checkpoint = `69e0f53993d5b02f27f0fc03682cef492c02d685` (Production Deploy `35510094974`). Historical production checkpoints include `0cc8382` (run `35502770382`, raw identity prerequisite), `eb02b17` (run `35337215903`), `27538a5` (run `35329071777`), `c14a586` (run `35314440036`), `de2e1c0` (run `35257469956`), `92532e8` (run `35228794988`), `0686d00`, `71a01b4`. Historical merge/docs SHAs `3f89fff` (PR #9) / `394f753` / `bd82aa0` / `b11c37d` / `2f8ec8d` are not rewritten. A later docs-only merge may advance `main`; that merge SHA is **not** a production application SHA.

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
| `audit/AUDIT-INDEX.md` | Program | Index | `eb02b17` app / this cycle | `ACTIVE` | YES | Master registry. Update in the same cycle as any audit-file change. |
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

`08.01` and `08.02` are **not** the same audit. `08.01` classifies current-system defects. `08.02` defines primary-system readiness (PSR-*) before Stell22 can be the only warehouse/production SoT. `08.03` is the PSR-P0-CORR production correction-history contract. `08.04` is the PSR-P0-CORE remainder (Q1 remainder, Q2, Q5, Q7, Q8). `08.05` is the PSR-P1 InventoryMovement schema contract. `08.06` is the PSR-P1 implementation/deployment closeout. `08.07` is the PSR-P2 general pre-dual-write preconditions (Q4 / R-07 / R-10 / R-11). `08.08` is the PSR-P2 R-04 Supply cycle-identity prerequisite. `08.09` is the PSR-P2 R-05 TORCOVKA correction-identity prerequisite. `08.10` is the PSR-P2 R-06 Inventory physical-identity prerequisite. `08.11` is the accepted PSR-P2 SHADOW writer contract. `08.12` is the P2-GUARD/CI implementation package. `08.13` is the Inventory SHADOW writer prerequisite implementation (merged; not deployed; writer not started at that closeout). `08.14` is the Inventory SHADOW writer implementation (merged to main; CI verified; not deployed; SHADOW not activated). `08.15` is the terminal production SHADOW writer implementation (merged to main; CI verified; not deployed; SHADOW not activated). `08.16` is the R-05 TORCOVKA correction SHADOW writer implementation (merged to main; CI verified; not deployed; SHADOW not activated). `08.17` is the Supply writer prerequisite implementation (feature branch; not merged; not deployed; production preflight not completed; Supply writer not started). `08.21` is the remaining mutation / destructive contours discovery (AWAITING HEAD REVIEW; no implementation). Do not reopen AUDIT 1 defect counts from 08.02/08.03/08.04/08.05/08.06/08.07/08.08/08.09/08.10/08.11/08.12/08.13/08.14/08.15/08.16/08.17/08.18/08.19/08.20/08.21.

| File | Area | Type | BASE/Snapshot | Status | Canonical? | Notes |
| ---- | ---- | ---- | ------------- | ------ | ---------- | ----- |
| `audit/08.01-audit-1-system-architecture.md` | Whole system | Architecture audit | Repo `d1f46e46232499b61f55e754b0bd70ddc5924bca`; app `d9f940e8540801bdb27dd72210193f5e4ab038c3` | `COMPLETE / REVIEWED` | YES | ChatGPT adversarial review accepted. New P0=0. New P1=`ARCH-P1-001` (OPEN / CONFIRMED; ACTIVE-path scope). New P2/P3=0. Simplify=`ARCH-SIMPLIFY-001`. **Do not reopen.** AUDIT 2 is a later finance audit, not started. |
| `audit/08.02-primary-system-readiness-architecture.md` | Primary-system readiness | Architecture contract | App BASE at acceptance `71a01b4` (**historical**). Current prod app `0cc8382`. | `ACCEPTED / REVIEWED` | YES | ARCH-2. Review #1 REQUEST CHANGES → R1…R6 CLOSED/PASS. Review #2 REQUEST CHANGES → R7…R8 CLOSED/PASS. Review #3 **PASS / ACCEPT** (new blockers = 0). Architecture contract accepted; **not** full PSR implementation complete. PSR-P0-CORR addendum §24.1. PSR-P0-CORE addendum §24.2. PSR-P1 schema addendum §24.3 (historical). PSR-P1 deploy closeout addendum §24.4. R-05 deploy closeout addendum §24.9. R-06 deploy closeout addendum §24.11. Generic `CommandExecution` not used. |
| `audit/08.03-psr-p0-correction-history-contract.md` | Production correction history | Architecture contract | App `0686d00`; GitHub main at 08.03 merge `bd82aa0` | `ACCEPTED DESIGN / NOT IMPLEMENTED` | YES | PSR-P0-CORR. Target = `ProductionOperationMutation`. **At 08.03 acceptance:** global `PSR-Q-001` / `PSR-DESIGN-001` = **OPEN / PARTIALLY RESOLVED**. **Subsequently CLOSED / ACCEPTED** by `08.04`. Do not rewrite 08.03 as if it closed global Q1. v1 HOURS delete **must be blocked**. v1 TORCOVKA line-qty **must reject frozen batch**. Schema **not** implemented. Correction Center **not** implemented. Cancellation **DEFERRED**. INC-001 remains OPEN. |
| `audit/08.04-psr-p0-core-contract.md` | PSR-P0 remaining PRE-SCHEMA | Architecture contract | App `0686d00`; GitHub main at creation `bd82aa0` | `ACCEPTED DESIGN / NOT IMPLEMENTED` | YES | PSR-P0-CORE. Closes Q1 remainder, Q2, Q5, Q7, Q8 and DESIGN-001/002. PSR-P0 **COMPLETE / ACCEPTED** as design contract only. Canonical design; **not** runtime implementation. |
| `audit/08.05-psr-p1-inventory-movement-schema-contract.md` | PSR-P1 InventoryMovement schema | Architecture contract | App `0686d00` at contract creation; GitHub main at creation `b11c37d` | `ACCEPTED DESIGN` (historical **NOT IMPLEMENTED** header preserved) | YES | PSR-P1 schema contract. Independent Review #1 = **PASS WITH NON-BLOCKING FINDINGS** (P0=0, P1=0). Exact enums/model/no-FK/partial indexes/CHECKs/snapshots. AUTHORITATIVE-only opening UNIQUEs. SHADOW may carry rehearsal `epochId`. Do not rewrite contract-creation **NOT IMPLEMENTED**. Current implementation/deploy: `08.06`. |
| `audit/08.06-psr-p1-deployment-closeout.md` | PSR-P1 InventoryMovement SHADOW deploy | Closeout / evidence | App/main `92532e8`; deploy `35228794988` | `COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY` | YES | PR #7 merged. Migration `20260917150000_psr_p1_inventory_movement_shadow` applied. Table exists. Row count = 0. No runtime writers. Historical P1 closeout. Later general preconditions: `08.07`. |
| `audit/08.07-psr-p2-pre-dual-write-general-preconditions.md` | PSR-P2 general preconditions | Contract + implementation | App `92532e8`; PR #9 implementation merge checkpoint `3f89fff`. Historical pre-merge main `394f753`. | `ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / NOT DEPLOYED` | YES | PR #9 **MERGED**. Post-merge CI **SUCCESS** `35250490823`. Closes architecture for `PSR-Q-004`, R-07, R-10, R-11. Package later **DEPLOYED** at `de2e1c0` (run `35257469956`). Dual-write **NOT STARTED**. R-04 later: `08.08`. Production not queried in the 08.07 cycle. |
| `audit/08.08-psr-p2-r04-supply-cycle-identity.md` | PSR-P2 R-04 Supply cycle identity | Contract + implementation + deploy closeout | App/production `c14a586`; PR #11 merge `c14a586`; deploy `35314440036` | `ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED` | YES | Historical PR-#11 review status **NOT DEPLOYED** is preserved in §9. Current runtime **DEPLOYED**. Long-lived Supply + generation/open. One-shot shortfall unchanged. Ozon cancel closes Δ=0 cycles. WB consume-only; DI-011 still deferred. No InventoryMovement writer. Dual-write **NOT STARTED**. Later R-05: `08.09`. |
| `audit/08.09-psr-p2-r05-correction-identity.md` | PSR-P2 R-05 TORCOVKA correction identity | Contract + implementation + deploy closeout | App/production `27538a5`; PR #13 merge `27538a5`; deploy `35329071777` | `ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED` | YES | Historical PR-#13 review status **NOT DEPLOYED** is preserved in §8. Current runtime **DEPLOYED**. Narrow `ProductionOperationCorrection` for `correctTorcovkaRailsTaken`. `requestId` UNIQUE. expected-old CAS. Idempotent replay. No FK/CASCADE. No InventoryMovement writer. No historical backfill. Dual-write **NOT STARTED**. Full `ProductionOperationMutation` **not** implemented. Later R-06: `08.10`. |
| `audit/08.10-psr-p2-r06-inventory-identity.md` | PSR-P2 R-06 Inventory physical identity | Contract + implementation + deploy closeout | App/production `eb02b17`; PR #15 merge `eb02b17`; deploy `35337215903` | `ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED` | YES | Historical implementation/review status **NOT DEPLOYED** is preserved in §11. Current runtime **DEPLOYED**. First-class BLANK InventoryLine. No-prisadka DETAIL excluded from new drafts. DETAIL ready aggregate + deterministic bucket effects. UNIQUE(inventoryId, refType, refId) **LIVE**. Legacy DRAFT fail-closed `LEGACY_INVENTORY_DRAFT_RECREATE`. No InventoryMovement writer. Dual-write **NOT STARTED**. Not full MUST-008. Rollback window **PHASE A**. Later writer contract: `08.11`. |
| `audit/08.11-psr-p2-shadow-writer-contract.md` | PSR-P2 SHADOW writer contract | Architecture contract | Starting main `2eb4f6a`; accepted on `7118286` (PR #17) | `ACCEPTED / REVIEWED` | YES | Writer contract only. Dual-write **NOT STARTED**. SHADOW **NOT ACTIVATED**. §15.1 splits P2-GUARD/CI infrastructure tests from writer-specific tests. |
| `audit/08.12-psr-p2-guard-ci.md` | PSR-P2 P2-GUARD/CI | Implementation + current runtime | PR #18 merge `643c796`; accepted head `91c7e3e`; current prod app `0cc8382` | historical `IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED`; current runtime `DEPLOYED DORMANT` | YES | Historical closeout **NOT DEPLOYED** preserved. Current runtime: gateway/guard infrastructure **DEPLOYED DORMANT**. SHADOW inactive. Dual-write **NOT STARTED**. |
| `audit/08.13-psr-p2-inventory-writer-prerequisite.md` | PSR-P2 Inventory writer prerequisite | Implementation + current runtime | PR #20 merge `4dfaae2`; accepted head `1f8b1d6`; current prod app `0cc8382` | `IMPLEMENTED / MERGED / DEPLOYED DORMANT` | YES | Historical closeout **NOT DEPLOYED / INVENTORY WRITER NOT STARTED** preserved. Current runtime: prerequisite code is in production application `0cc8382`. Writer itself is `08.14` **DEPLOYED DORMANT / SHADOW INACTIVE**. |
| `audit/08.14-psr-p2-inventory-shadow-writer.md` | PSR-P2 Inventory SHADOW writer | Implementation + current runtime | PR #22 merge `2fd138e`; accepted head `c58131c`; current prod app `0cc8382` | `DEPLOYED DORMANT / SHADOW INACTIVE` | YES | Historical closeout **NOT DEPLOYED** preserved. Current runtime: Inventory conduct writer **DEPLOYED DORMANT**. SHADOW inactive. Dual-write **NOT STARTED**. |
| `audit/08.15-psr-p2-terminal-production-shadow-writers.md` | PSR-P2 terminal production SHADOW writers | Implementation + current runtime | PR #24 merge `853db69`; accepted head `1367e30`; current prod app `0cc8382` | `DEPLOYED DORMANT / SHADOW INACTIVE` | YES | Historical closeout **NOT DEPLOYED** preserved. Current runtime: normal TORCOVKA / PRISADKA / UPAKOVKA writers **DEPLOYED DORMANT**. SHADOW inactive. Dual-write **NOT STARTED**. |
| `audit/08.16-psr-p2-r05-correction-shadow-writer.md` | PSR-P2 R-05 TORCOVKA correction SHADOW writer | Implementation + current runtime | PR #26 merge `debafda`; accepted head `c9d3c0b`; current prod app `0cc8382` | `DEPLOYED DORMANT / SHADOW INACTIVE` | YES | Historical closeout **NOT DEPLOYED** preserved. Current runtime: R-05 correction writer **DEPLOYED DORMANT**. SHADOW inactive. Dual-write **NOT STARTED**. |
| `audit/08.17-psr-p2-supply-prerequisite.md` | PSR-P2 Supply writer prerequisite | Implementation + current runtime | PR #28 merge `5fe5f40`; accepted HEAD `8e92dd6`; latest preflight `35502680346` | `COMPLETE / DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED` | YES | Historical closeout **NOT DEPLOYED** preserved. Current runtime: hardening is in production `0cc8382`. Latest preflight TOTAL=0 / D=0 / S=0 / O=0 / `SUPPLY_DATA_BLOCKER=NO`. |
| `audit/08.18-psr-p2-supply-shadow-writer.md` | PSR-P2 Supply SHADOW writer | Implementation + current runtime | PR #31 merge `164ffca`; accepted head `2e90060`; current prod app `0cc8382` | `DEPLOYED DORMANT / SHADOW INACTIVE` | YES | Historical closeout **NOT DEPLOYED** preserved. Current runtime: Supply deduct / Ozon restore writer **DEPLOYED DORMANT**. SHADOW inactive. Dual-write **NOT STARTED**. |
| `audit/08.19-psr-p2-raw-identity-prerequisite.md` | PSR-P2 raw receipt / write-off identity | Implementation + deploy closeout | PR #33 merge `76131ca`; accepted head `919a427`; historical identity deploy `35502770382` / `0cc8382`; current prod `69e0f53` / `35510094974` | `IMPLEMENTED / MERGED / DEPLOYED / POST-DEPLOY VERIFIED` | YES after this closeout merge | Historical implementation **NOT DEPLOYED** preserved. Identity deploy `35502770382` first made tables live. Current production is later application SHA `69e0f53`. Migration APPLIED; tables LIVE / EMPTY AT CUTOVER; historical backfill NO. Connected writers **DEPLOYED DORMANT**. Dual-write **NOT STARTED**. Later writers: `08.20`. |
| `audit/08.20-psr-p2-raw-shadow-writers.md` | PSR-P2 raw receipt / write-off SHADOW writers | Implementation + deploy closeout | PR #36 merge `0bf2c77`; accepted head `424f119`; Production Deploy `35510094974`; prod app `69e0f53` | `IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE` | YES | Source/`main` contours **9**. Production dormant contours **9**. Application deploy / no new migration. No activation. P2 **NOT COMPLETE**. P3 **NOT STARTED**. Later discovery: `08.21`. |
| `audit/08.21-psr-p2-remaining-mutation-destructive-adjudication.md` | PSR-P2 remaining mutation / destructive contours | Discovery + HEAD architecture + independent review | Starting main `289979b0`; discovery HEAD `6f11e38`; adjudicated HEAD `a9567b6`; app `69e0f53` | `DISCOVERY COMPLETE / ARCHITECTURE ACCEPTED / REVIEWED / NO IMPLEMENTATION` | NO until this review merge | Exhaustive A–H **PASS**. Independent Opus **PASS** P0=0 / P1=0 / P2=4 informational. Architecture unchanged. No runtime. P2 **NOT COMPLETE**. NEXT = Package 1 guards. |

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

`08.06` is **PSR-P1 SHADOW schema deployment closeout**. Status = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY**. Empty unused table. No runtime writers. Historical P1 closeout; do not rewrite.

`08.07` is **PSR-P2 general pre-dual-write preconditions**, canonical on GitHub `main` after PR #9 (Canonical? **YES**). Architecture for `PSR-Q-004` / R-07 / R-10 / R-11 = **CLOSED**. Historical merge-time status **VERIFIED / MERGED TO main / NOT DEPLOYED** is preserved in that file. Package later **DEPLOYED DORMANT** at `de2e1c0` (run `35257469956`). Dual-write **NOT STARTED**.

`08.08` is **PSR-P2 R-04 Supply cycle identity**. Status = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED**. Production Deploy `35314440036`. Historical PR-#11 review status **NOT DEPLOYED** is preserved in §9. Dual-write **NOT STARTED**.

`08.09` is **PSR-P2 R-05 TORCOVKA correction identity**. Status = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED**. Production `27538a5`; Production Deploy `35329071777`. Historical PR-#13 review status **NOT DEPLOYED** is preserved in §8. Dual-write **NOT STARTED**. Full `ProductionOperationMutation` **not** implemented.

`08.10` is **PSR-P2 R-06 Inventory physical identity**. Status = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED**. Production `eb02b17`; Production Deploy `35337215903`. Historical implementation/review status **NOT DEPLOYED** is preserved in §11. Dual-write **NOT STARTED**. Rollback window immediately after deploy = **PHASE A**.

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

Application/main BASE at ARCH-2 acceptance: `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` (**historical**; **not** a later production application SHA rewrite). Current production application: `eb02b17`.

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

`PSR-Q-004` remains **DEPLOYED DORMANT** (`audit/08.07`, Canonical? **YES**; first deployed at `de2e1c0`). `PSR-Q-003` / `Q6` remain later-timing (`Q3` before physical recon / P4; `Q6` before FINAL epoch / P6).

Correction Center **not** implemented. Cancellation **DEFERRED / NOT IMPLEMENTED**.

PSR-P1 empty SHADOW table is **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`08.06`). Not dual-write, not authoritative, not paper removal, not `production_cost_flow` activation, not Correction Center. AUDIT 2 not started.

### PSR-P1 — INVENTORY MOVEMENT SHADOW SCHEMA

Status: **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY**. Schema contract `08.05` remains **ACCEPTED DESIGN** (historical **NOT IMPLEMENTED** at contract creation preserved). Independent Review #1 = **PASS WITH NON-BLOCKING FINDINGS** (P0=0, P1=0).

Artifacts: `audit/08.05-psr-p1-inventory-movement-schema-contract.md` (exact schema) and `audit/08.06-psr-p1-deployment-closeout.md` (implementation/deploy evidence). Production table exists. Row count = **0**. No runtime writers.

`PSR-Q-004` / R-07 / R-10 / R-11 remain **DEPLOYED DORMANT** (`audit/08.07`, Canonical? **YES**; first deployed at `de2e1c0`). R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.08`; Production Deploy `35314440036`). R-05 identity = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.09`; production `27538a5`; Production Deploy `35329071777`). R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`; production `eb02b17`; Production Deploy `35337215903`). P2-GUARD/CI historical implementation status = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; current runtime = **DEPLOYED DORMANT** (`audit/08.12`). Inventory writer prerequisite historical implementation status = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; current runtime = prerequisite code **DEPLOYED DORMANT** (`audit/08.13`). Inventory SHADOW writer = **DEPLOYED DORMANT / SHADOW INACTIVE** (`audit/08.14`). Terminal production SHADOW writers = `audit/08.15` (**DEPLOYED DORMANT / SHADOW INACTIVE**). R-05 correction writer = `audit/08.16` (**DEPLOYED DORMANT / SHADOW INACTIVE**). Supply writer prerequisite = `audit/08.17` (**COMPLETE / DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**). Supply SHADOW writer = `audit/08.18` (**DEPLOYED DORMANT / SHADOW INACTIVE**). Raw identity prerequisite = `audit/08.19` (**IMPLEMENTED / MERGED / DEPLOYED / POST-DEPLOY VERIFIED**). Raw SHADOW writers = `audit/08.20` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**; PR #36 merge `0bf2c77`; Production Deploy `35510094974`; deployed application `69e0f53`). Remaining mutation / destructive discovery = `audit/08.21` (**ARCHITECTURE ACCEPTED / REVIEWED**; no implementation). **NEXT = PSR-P2 SAFE DESTRUCTIVE GUARDS IMPLEMENTATION PACKAGE**. PSR-P2 dual-write **NOT STARTED**. Not dual-write, not OPENING_BALANCE data, not AUTHORITATIVE rows, not Correction Center.

### INC-001 — TORCOVKA whole-package production incident

Status: `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION`

Artifact: `audit/INC-001-torcovka-whole-package-production-incident.md`

Finding: `INC-001-F1` (P1) — after TORCOVKA delete, no application path to restore falsely consumed `RailLot`. Generic delete path is `CONTAINED IN PRODUCTION` (first at `3608b36`; still present on running `0cc8382`). Proper `cancelErroneousTorcovka` `NOT IMPLEMENTED`. Damaged package `NOT CORRECTED`. Scenario A vs B still requires physical facts. Employee not recoverable. ARCH-2 / `08.03` / `08.04` / `08.06` / `08.09` / `08.10` do **not** close INC-001. Cancellation remains deferred.

### AUDIT 2 — FINANCE & MONEY INTEGRITY

Status: `NOT STARTED` (`NEXT AFTER INC-001`)

ARCH-2 / `08.02` does **not** silently start AUDIT 2. Audit-only when started. Do not open as a file until INC-001 production correction is decided. High-level scope: CashFlow, Account/balance, Statement/import, Deal allocations, transfers, Payment/payroll money, corrections/voids, transaction boundaries, idempotency, confirmed/unconfirmed money, reconciliation, Sale vs money where relevant.

---
### 08.11 — PSR-P2 SHADOW writer contract

- File: `audit/08.11-psr-p2-shadow-writer-contract.md`
- Scope: architecture/contract only; exhaustive physical-writer matrix; common SHADOW writer/gateway contract; gate/lock ordering; effectKey v1; actor/time/snapshot/retry/diagnostic/CI contracts; phased implementation order.
- Starting main: `2eb4f6a6d769900481a5c3fd33a76240789d953d`.
- Status: **ACCEPTED / REVIEWED** architecture/contract only.
- Runtime dual-write: **NOT STARTED**.
- SHADOW activation: **NO**.
- Production deploy/mutation: **NO / NO**.
- Review disposition: independent adversarial review returned REQUEST CHANGES; accepted findings were closed in the contract; final HEAD review accepted the corrected contract.
- NEXT after acceptance: **P2-GUARD/CI IMPLEMENTATION PACKAGE** (historical; now completed in `audit/08.12`).

### 08.12 — PSR-P2 P2-GUARD/CI

- File: `audit/08.12-psr-p2-guard-ci.md`
- Scope: common SHADOW gateway skeleton, INSERT/gate-read/TRUNCATE static guards, actor/time/identity infrastructure, disposable PostgreSQL CI.
- Exact accepted implementation HEAD: `91c7e3e91f956f9fc2d4959cb83c105d4979f96d`.
- Merge commit: `643c7966a4f03670747517050031843eac1b5013` (PR #18).
- Accepted PR CI: `35372711310` SUCCESS. Post-merge CI: `35373616566` SUCCESS.
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**.
- Current runtime: **DEPLOYED DORMANT**.
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`.
- SHADOW: **INACTIVE**.
- Dual-write: **NOT STARTED**.
- NEXT: **PSR-P2 INVENTORY WRITER PREREQUISITE PACKAGE** (historical; now completed in `audit/08.13`).

### 08.13 — PSR-P2 Inventory writer prerequisite

- File: `audit/08.13-psr-p2-inventory-writer-prerequisite.md`
- Scope: SHADOW gate-first Inventory transaction, temporary SHADOW-active fail-closed, dual-active fail-closed, global BlankStock lock plan, retained USER actor, PostgreSQL prerequisite tests.
- Exact accepted implementation HEAD: `1f8b1d64e7d4d7828606514f728c4603f1281244`.
- Merge commit: `4dfaae26471188db04d76262d9776336aada854a` (PR #20).
- Accepted PR CI: `35379385996` SUCCESS. Post-merge CI: `35422069460` SUCCESS.
- HEAD review: **PASS**. Independent Opus: **PASS**. P0=0 / P1=0 / P2=5 (non-blocking; dispositioned in `08.13` §10).
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / INVENTORY WRITER NOT STARTED**.
- Current runtime: prerequisite code **DEPLOYED DORMANT**. Writer itself is `audit/08.14`.
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`.
- Dual-write: **NOT STARTED**.
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Historical closeout next was Inventory writer (`audit/08.14`).

### 08.14 — PSR-P2 Inventory SHADOW writer

- File: `audit/08.14-psr-p2-inventory-shadow-writer.md`
- Scope: first physical InventoryMovement writer for Inventory `conductInventory`; `InventoryPhysicalEffect[]` mapping; gate-first TX; P2-02/P2-03/P2-05; writer PostgreSQL proofs; W1/W4 fail-closed/exhaustive mapping.
- Exact accepted implementation HEAD: `c58131c02484ae49897fa0259ad623af65708b9e`.
- Merge commit: `2fd138e2c7195b63c2e943d0f85f2b9b0050740c` (PR #22).
- Accepted PR CI: `35427250317` SUCCESS. Post-merge CI: `35427681739` SUCCESS.
- HEAD review: **PASS**. Independent Opus: **PASS — P0=0 / P1=0 / P2=4**. W1 CLOSED. W2 accepted non-blocking. W3 accepted pre-existing/non-blocking. W4 CLOSED.
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**.
- Current runtime: **DEPLOYED DORMANT / SHADOW INACTIVE**.
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`.
- Dual-write: **NOT STARTED**.
- Runtime P2 global completeness: **NOT COMPLETE**.
- P3: **NOT STARTED**.
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Historical closeout next was terminal writers (`audit/08.15`).

### 08.15 — PSR-P2 terminal production SHADOW writers

- File: `audit/08.15-psr-p2-terminal-production-shadow-writers.md`
- Scope: SHADOW writers for normal `submitTorcovka` / `submitPrisadka` / `submitUpakovka`; gate-first TX; retained EMPLOYEE actor; UPAKOVKA global lock; PostgreSQL retry/atomicity/concurrency proofs.
- Exact accepted implementation HEAD: `1367e306f4c5e0be77137cf005e7396bf110ae33`.
- PR #24 merge: `853db69b00485f5201c2fd1046cc68b07ac69ded`.
- Exact-head CI: `35439899641` SUCCESS. Post-merge CI: `35440444019` SUCCESS.
- HEAD final review: **PASS**. Independent Opus: **SKIPPED BY OWNER COST POLICY**.
- Initial findings: **P0=0 / P1=2 / P2=1**. P1-01 CLOSED. P1-02 CLOSED. P2-01 CLOSED.
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**.
- Current runtime: **DEPLOYED DORMANT / SHADOW INACTIVE**.
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`.
- Dual-write: **NOT STARTED**.
- Runtime P2 global completeness: **NOT COMPLETE**.
- P3: **NOT STARTED**.
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Historical closeout next was R-05 writer (`audit/08.16`).

### 08.16 — PSR-P2 R-05 TORCOVKA correction SHADOW writer

- File: `audit/08.16-psr-p2-r05-correction-shadow-writer.md`
- Scope: SHADOW writer for `correctTorcovkaRailsTaken`; explicit READ COMMITTED; gate-first TX; retained USER actor; no-backfill replay; PostgreSQL RC/gate-flip/rollback/time proofs.
- Exact accepted implementation HEAD: `c9d3c0b62894d505987685ee399fa99c69ce3126`
- PR #26 merge: `debafdae9510acab7182e334fcfe1a5b00608e0d`
- Exact-head CI: `35443727340` SUCCESS. Post-merge CI: `35444256886` SUCCESS.
- HEAD final review: **PASS**. Findings: **P0=0 / P1=0 / P2=0**. Independent Opus: **SKIPPED BY OWNER COST POLICY**.
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**
- Current runtime: **DEPLOYED DORMANT / SHADOW INACTIVE**
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`
- Dual-write: **NOT STARTED**.
- Runtime P2 global completeness: **NOT COMPLETE**.
- P3: **NOT STARTED**.
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Historical closeout next was Supply prerequisite (`audit/08.17`).

### 08.17 — PSR-P2 Supply writer prerequisite

- File: `audit/08.17-psr-p2-supply-prerequisite.md`
- Scope: read-only production edge query, Ozon null-product fail-closed, deterministic global Supply/ProductStock lock order. No InventoryMovement writer.
- Merge: PR #28 `5fe5f40572ce9259c3725a93516a76f9533f07ab` (accepted HEAD `8e92dd62caf063914e56d4105d550fb2fe1505af`). Parser-fix PR #29 `eb79b261ed8c2dfe423ba9207d48e7d29e14dbd8` (accepted HEAD `7795e88d9bf250c330db3cc3b360b780a18148c5`).
- Historical implementation status (preserved): **COMPLETE / NOT DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**. P1-01/P1-02 **CLOSED**. `SUPPLY-PREFLIGHT-PARSER-001` **CLOSED**. P2-01 **CLOSED**.
- Current runtime: **COMPLETE / DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**
- Production preflight: historical trusted `35452435411`; latest rerun `35502680346` TOTAL=0 / D=0 / S=0 / O=0 / `SUPPLY_DATA_BLOCKER=NO`
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`
- Dual-write: **NOT STARTED**.
- Runtime P2 global completeness: **NOT COMPLETE**.
- P3: **NOT STARTED**.
- Supply writer: now `audit/08.18` **DEPLOYED DORMANT / SHADOW INACTIVE**
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Not SHADOW activation.

### 08.18 — PSR-P2 Supply SHADOW writer

- File: `audit/08.18-psr-p2-supply-shadow-writer.md`
- Scope: Supply ProductStock deduction + Ozon positive restore SHADOW writer. Gate-first marketplace TX. Retained USER actor. No schema/migration.
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**
- Current runtime: **DEPLOYED DORMANT / SHADOW INACTIVE**
- Accepted HEAD: `2e90060d145bac9fc9eb6b2fcaef4253fbfe877b`
- Merge: `164ffca49d5200af0b442de05c8966fc3b5c70ed`
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`
- Dual-write: **NOT STARTED**.
- Runtime P2 global completeness: **NOT COMPLETE**.
- P3: **NOT STARTED**.
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Not SHADOW activation.

### 08.19 — PSR-P2 raw receipt / write-off identity prerequisite

- File: `audit/08.19-psr-p2-raw-identity-prerequisite.md`
- Scope: retained request/lifecycle identities for `createBatch`, `writeOffBatchRemainder`, `createSimplePurchase`. No InventoryMovement writers.
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**
- Current status: **IMPLEMENTED / MERGED / DEPLOYED / POST-DEPLOY VERIFIED**
- Canonical?: **YES** after this closeout merge
- Accepted HEAD: `919a427e187f60c83b09658a8ad4a8ecafbd2d82`
- Merge: `76131ca1a77b8c20d920055be66361bd0ab9f4c4`
- Historical identity-prerequisite Production Deploy: `35502770382` SUCCESS
- Historical identity-prerequisite application: `0cc8382f307ac1ff7fa881012033f5105e689a23`
- Current production application: `69e0f53993d5b02f27f0fc03682cef492c02d685`
- Current Production Deploy: `35510094974` SUCCESS
- Schema / migration: **APPLIED**. Identity tables LIVE / EMPTY AT CUTOVER. Historical backfill: **NO**.
- Connected writers: **DEPLOYED DORMANT / SHADOW INACTIVE**
- Dual-write: **NOT STARTED**.
- Runtime P2 global completeness: **NOT COMPLETE**.
- P3: **NOT STARTED**.
- NEXT: **PSR-P2 SAFE DESTRUCTIVE GUARDS IMPLEMENTATION PACKAGE**. Not started in this PR. Not SHADOW activation.

### 08.20 — PSR-P2 raw receipt / write-off SHADOW writers

- File: `audit/08.20-psr-p2-raw-shadow-writers.md`
- Scope: SHADOW writers for `createBatch`, `writeOffBatchRemainder`, `createSimplePurchase`.
- Status: **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**
- Canonical?: **NO** until this closeout merge
- Accepted HEAD: `424f1191f093bafda5a8d98a387d0b7da2822324`
- Implementation PR: #36
- Merge: `0bf2c77f25b76c183d86bd571ad685e679c577da`
- Production Deploy: `35510094974` SUCCESS
- Deployed application: `69e0f53993d5b02f27f0fc03682cef492c02d685`
- Exact-head CI: `35507221861` SUCCESS
- Post-merge CI: `35507868236` SUCCESS
- HEAD review: **PASS** — P0=0 / P1=0 / P2=0
- Schema / migration: **NO** — **NO NEW MIGRATION**
- Source/`main` contours: **9**
- Production dormant contours: **9**
- Dual-write: **NOT STARTED**.
- Runtime P2 global completeness: **NOT COMPLETE**.
- P3: **NOT STARTED**.
- NEXT: **PSR-P2 SAFE DESTRUCTIVE GUARDS IMPLEMENTATION PACKAGE**. Not started in this PR. Not SHADOW activation.

### 08.21 — PSR-P2 remaining mutation / destructive contours

- File: `audit/08.21-psr-p2-remaining-mutation-destructive-adjudication.md`
- Scope: discovery + HEAD-adjudicated architecture for remaining enabled physical mutation / destructive contours after the accepted nine writers.
- Status: **DISCOVERY COMPLETE / ARCHITECTURE ACCEPTED / REVIEWED / NO IMPLEMENTATION**
- Canonical?: **NO** until this review merge
- Starting `origin/main`: `289979b091dab5b77b4e988ae98b94a281afdfdb`
- Initial audit HEAD: `6f11e38ac972685488f88c9015119c043aee4e7d`
- HEAD-adjudication commit: `a9567b6bcfb6fb5b1761aa618d33cee1cd2c60fc`
- HEAD review: **REQUEST CHANGES** — P0=0 / P1=1 / P2=0. Discovery/exhaustiveness **PASS**. P1-01 closed by HEAD (net ADJUSTMENT per physical target).
- Independent Opus: **PASS** — Claude Opus (`claude-opus-5-thinking-high`); reviewed `a9567b6`; 2026-09-20; P0=0 / P1=0 / P2=4 informational; architecture unchanged.
- Schema / migration / runtime: **NO**
- Production access / mutation / deploy: **NO / NO / NO**
- SHADOW activation: **NO**
- Dual-write: **NOT STARTED**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 SAFE DESTRUCTIVE GUARDS IMPLEMENTATION PACKAGE**. Not started in this PR. Not SHADOW activation.
