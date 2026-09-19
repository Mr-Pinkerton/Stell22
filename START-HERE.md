# Stell22 — START HERE

This is the persistent cross-chat entry point for Stell22.

## Domain

Stell22 is an ERP/MES for **manufacturing shelving/rack systems (стеллажи)**.

It is a separate business domain from Woodveri door manufacturing.
Never import door-specific entities, routes, WIP assumptions, or business rules unless the owner explicitly asks.

## Read order

1. `PROJECT.md`
2. `audit/AUDIT-INDEX.md`
3. GitHub current `main`
4. GitHub `audit/00-audit-principles.md`
5. GitHub `audit/00-audit-backlog.md`
6. GitHub `audit/00-project-map.md`
7. GitHub `audit/00-business-flows.md`
8. GitHub `audit/00-data-model.md`
9. GitHub `audit/00-invariants.md`
10. relevant later `audit/01.*`, `02.*`, `03.*`

## Application / main checkpoint

`eb02b17f488ef9ec13a11dcf158fc169b78e3e37`

This SHA is the current production **application** checkpoint and was deployed (Production Deploy `35337215903` SUCCESS). R-06 Inventory physical identity = **DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`). Migration `20260918130000_psr_p2_r06_inventory_line_identity` **APPLIED**. Index `InventoryLine_inventoryId_refType_refId_key` **LIVE**. `InventoryMovement` exists and is empty. Production has **no deployed runtime writers**. Source/main Inventory `conductInventory` writer is **CONNECTED / MERGED / NOT DEPLOYED**. `inventory_movement_shadow_write` remains ABSENT in production. `production_cost_flow` remains INACTIVE. PSR-P2 dual-write **NOT STARTED**. Always verify current GitHub `main` HEAD. A later docs-only merge may advance `main`; that merge SHA is **not** a production application SHA.

Prior production application checkpoint (**historical**, do not rewrite):

`27538a5d5777d33fb87d060963a6d07a189cf044`

Production Deploy `35329071777` SUCCESS. R-05 TORCOVKA correction identity **DEPLOYED** (`audit/08.09`).

Prior production application checkpoint (**historical**, do not rewrite):

`c14a58641d57dfabfce223b2c213db9c86167ca4`

Production Deploy `35314440036` SUCCESS. R-04 Supply cycle identity **DEPLOYED** (`audit/08.08`).

Prior production application checkpoint (**historical**, do not rewrite):

`de2e1c015423e7b848f0583c0e75b2abb12733d9`

Production Deploy `35257469956` SUCCESS. PSR-P2 general preconditions (`PSR-Q-004` / R-07 / R-10 / R-11) **DEPLOYED DORMANT** (`audit/08.07`).

Always verify current `main` HEAD.

Prior production application checkpoint (**historical**, do not rewrite):

`92532e818df41160b434caac2c6d94933e93d810`

`Merge pull request #7 from Mr-Pinkerton/feat/psr-p1-inventory-movement-shadow-schema`

Production Deploy `35228794988` SUCCESS. PSR-P1 = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`).

Prior production application checkpoint (**historical**, do not rewrite):

`0686d0036da52cc32aaff531c91f1dd2ded899ec`

`Merge pull request #3 from Mr-Pinkerton/feat/ops-corr-01-traceability-v1`

Production Deploy `35204366279` SUCCESS (2026-09-17). GitHub `main` later received PSR-P0-CORE (`b11c37d`) and PSR-P1 schema-contract (`08.05`) docs merges before the PSR-P1 implementation merge `92532e8`. Those docs merges did **not** themselves deploy application code.

Earlier production application checkpoint (**historical**, do not rewrite):

`71a01b40008cf6da7cbc843b3b0dbaa31cf01853`

`Merge pull request #1 from Mr-Pinkerton/integration/p2025-di020`

Production Deploy `34635510843` SUCCESS (2026-09-11). A later ARCH-2 documentation merge did **not** change that then-current application SHA.

## ARCH-2 — Primary-System Readiness

Canonical architecture: `audit/08.02-primary-system-readiness-architecture.md`

Status: **`ACCEPTED / REVIEWED`**.

Independent Review #1 = REQUEST CHANGES (R1…R6 CLOSED/PASS). Independent Review #2 = REQUEST CHANGES (R7…R8 CLOSED/PASS). Independent Review #3 = **PASS / ACCEPT** (new blockers = 0).

`ACCEPTED / REVIEWED` means the architecture **contract** is accepted. It does **not** mean PSR implementation complete, primary-system readiness achieved, ledger deployed, paper removable, or `production_cost_flow` active.

**NEXT = HEAD RE-REVIEW OF SUPPLY PREREQUISITE FIX PR**. R-05 correction SHADOW writer = `audit/08.16` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**; PR #26; accepted head `c9d3c0b`; merge `debafda`; exact-head CI `35443727340`; post-merge CI `35444256886`). HEAD review **PASS**. Findings **P0=0 / P1=0 / P2=0**. Independent Opus **SKIPPED BY OWNER COST POLICY**. Terminal production SHADOW writers = `audit/08.15` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**; PR #24; accepted head `1367e30`; merge `853db69`; exact-head CI `35439899641`; post-merge CI `35440444019`). Inventory SHADOW writer on `main` = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED** (`audit/08.14`; PR #22; accepted head `c58131c`; merge `2fd138e`; accepted CI `35427250317`; post-merge CI `35427681739`). Inventory writer prerequisite = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED** (`audit/08.13`; PR #20; accepted head `1f8b1d6`; merge `4dfaae2`; post-merge CI `35422069460`). P2-GUARD/CI = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED** (`audit/08.12`; PR #18; accepted head `91c7e3e`; merge `643c796`; post-merge CI `35373616566`). R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`; Production Deploy `35337215903`). Source/`main` connected physical InventoryMovement contours = **Inventory conduct + normal TORCOVKA / PRISADKA / UPAKOVKA + R-05 `correctTorcovkaRailsTaken`**. Production writer currently live = **NO**. Supply writer = **NOT STARTED**. Production Supply preflight = **NOT COMPLETED**. This is **not** SHADOW activation, **not** dual-write activation, **not** Correction Center / full `ProductionOperationMutation`, and **not** AUDIT 2. R-05 identity prerequisite remains **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.09`; Production Deploy `35329071777`). R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.08`; Production Deploy `35314440036`). PSR-P1 schema contract = **ACCEPTED DESIGN** (`audit/08.05`; historical contract-creation status **ACCEPTED DESIGN / NOT IMPLEMENTED** is preserved there). Current P1 implementation/deploy = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`). `PSR-Q-004` / R-07 / R-10 / R-11 remain **DEPLOYED DORMANT** (`audit/08.07`). PSR-P2 dual-write **NOT STARTED**. PSR-P2 globally **NOT COMPLETE**. PSR-P3 **NOT STARTED**. PSR-P0 = **COMPLETE / ACCEPTED** as an architecture/design contract only (`audit/08.03` + `audit/08.04`). `PSR-Q-003` remains before P4. `PSR-Q-006` remains before P6. Does **not** mean dual-write, authoritative ledger, paper removal, `production_cost_flow` activation, or Correction Center. Do not implement Correction Center / `ProductionOperationMutation` / dual-write from this file alone.

Historical documentation recovery checkpoint (no longer current on main):

`6dec426b25b25c663ec26ea5ac1debeabe570dc4`

Last pre-incident application-code checkpoint:

`d9f940e8540801bdb27dd72210193f5e4ab038c3`

`fix: enforce prisadka inventory boundary`

INC-001 containment SHA (still in the running tree):

`3608b36bd324a5118f4ba5b1bbb21462cc0723d9`

## Current work mode

The project on `main`: production application = `eb02b17` (Production Deploy `35337215903`). Always verify the current GitHub `main` HEAD before relying on a branch SHA. A later docs-only merge may advance `main`; that merge SHA is **not** a production application SHA. AUDIT 1 complete; ARCH-2 architecture **ACCEPTED / REVIEWED**; PSR-P0-CORR **ACCEPTED DESIGN / NOT IMPLEMENTED**; PSR-P0-CORE = **ACCEPTED DESIGN / NOT IMPLEMENTED** (`audit/08.04`); PSR-P1 schema contract = **ACCEPTED DESIGN** (`audit/08.05`; historical **NOT IMPLEMENTED** at contract creation preserved); PSR-P1 implementation/deploy = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`); PSR-P0 **COMPLETE / ACCEPTED** as design contract only; `PSR-Q-004` / R-07 / R-10 / R-11 remain **DEPLOYED DORMANT** (`audit/08.07`); R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.08`); R-05 identity = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.09`); R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`); source/main Inventory + terminal + R-05 writers **CONNECTED / MERGED / NOT DEPLOYED**; PSR-P2 dual-write **NOT STARTED**; INC-001 open; AUDIT 2 not started.

**NEXT = HEAD RE-REVIEW OF SUPPLY PREREQUISITE FIX PR**. R-05 correction writer = `audit/08.16` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**). Terminal production writers = `audit/08.15` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**). Inventory SHADOW writer on `main` = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED** (`audit/08.14`). Inventory writer prerequisite remains **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED** (`audit/08.13`). Supply prerequisite = `audit/08.17` (**IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / PRODUCTION PREFLIGHT NOT COMPLETED**). This is **not** SHADOW activation, **not** dual-write activation, **not** Correction Center / full `ProductionOperationMutation`, and **not** AUDIT 2. Do not start the Supply writer from this file. Do not implement dual-write, Correction Center schema, or a production deploy from this file.

AUDIT 1 remains `COMPLETE / REVIEWED`. Do not reopen it.

`AUDIT 2 — FINANCE & MONEY INTEGRITY` is **not started**.

INC-001 remains open (containment deployed; production data not corrected). Do not treat architecture docs as a production-data fix.

Do not fix every finding immediately.

Audit lane:
`find -> prove -> classify -> record -> continue`

Delivery lane:
implement only already-approved remediation packages.

For package/deploy/activation state, `PROJECT.md` is the first project-level source.
For actual implementation, GitHub `main` is authoritative.

## Canonical working workflow

The owner prefers to work primarily in **Cursor**. Cursor is the implementation/audit workstation; ChatGPT is the review/orchestration layer.

Normal loop:

1. Establish actual GitHub `main` HEAD and clean/dirty state in Cursor.
2. ChatGPT prepares a precise Cursor task.
3. Cursor performs the audit or implementation and returns evidence: BASE SHA, changed files, diff summary, tests/checks, blockers, and proposed next step.
4. ChatGPT reviews the Cursor result, looks for contradictions/omissions, and either accepts it or sends a correction/follow-up task.
5. A completed audit must be written to `audit/*.md` and committed/pushed. A Cursor/chat-only result is `UNVERIFIED / NOT CANONICAL`.
6. A deployable patch must receive a **separate adversarial review in Cursor using Claude** before deploy.
7. If Claude requests code changes, apply them and run Claude review again on the final diff.
8. Deploy only after the final Claude verdict is PASS/GO and the project journal records the package state.

Source-of-truth hierarchy:

`GitHub main code + committed audit docs` -> `PROJECT.md` -> `AUDIT-INDEX.md` -> Library snapshot -> chat/Cursor transcript.

Chat and Cursor transcripts are working evidence, never the final source of truth.

---
## PSR-P2 writer contract accepted — 2026-09-18

Accepted contract artifact: `audit/08.11-psr-p2-shadow-writer-contract.md` (PR #17).

The contract is **ACCEPTED / REVIEWED** as architecture/contract only.

It freezes the exhaustive physical-writer matrix, gate-first transaction contract, effectKey v1, actor/time/snapshot rules, retry/idempotency requirements, reconciliation diagnostics, mandatory PostgreSQL CI, and evidence-driven P2 implementation sequence.

Runtime status remains:

- **WRITER CONTRACT ONLY**
- **DUAL-WRITE NOT STARTED**
- **SHADOW NOT ACTIVATED**
- `production_cost_flow` **INACTIVE**
- production application checkpoint remains `eb02b17f488ef9ec13a11dcf158fc169b78e3e37`

P2-GUARD/CI is **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**. Inventory writer prerequisite is **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED** (`audit/08.13`; PR #20; merge `4dfaae2`; post-merge CI `35422069460`). Inventory SHADOW writer = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED** (`audit/08.14`; PR #22; accepted head `c58131c`; merge `2fd138e`; accepted CI `35427250317`; post-merge CI `35427681739`). Terminal production writers = `audit/08.15` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**; PR #24; merge `853db69`; post-merge CI `35440444019`). R-05 correction writer = `audit/08.16` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**; PR #26; accepted head `c9d3c0b`; merge `debafda`; exact-head CI `35443727340`; post-merge CI `35444256886`). Supply prerequisite = `audit/08.17` (**IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / PRODUCTION PREFLIGHT NOT COMPLETED**). **NEXT = HEAD RE-REVIEW OF SUPPLY PREREQUISITE FIX PR**. No SHADOW activation. No deploy. Do not start the Supply writer from this file.

---
## 08.13 — PSR-P2 Inventory writer prerequisite closeout

- File: `audit/08.13-psr-p2-inventory-writer-prerequisite.md`
- Exact accepted implementation HEAD: `1f8b1d64e7d4d7828606514f728c4603f1281244`
- PR #20 merge: `4dfaae26471188db04d76262d9776336aada854a`
- Accepted PR CI: `35379385996` SUCCESS. Post-merge CI: `35422069460` SUCCESS.
- HEAD review: **PASS**. Independent Opus: **PASS**. P0=0 / P1=0 / P2=5 (non-blocking; dispositioned in `08.13` §10).
- Status: **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / INVENTORY WRITER NOT STARTED**.
- Runtime InventoryMovement physical writers: **0**.
- Schema / migration: **NONE**.
- SHADOW activation: **NO**.
- Dual-write: **NOT STARTED**.
- Production access/mutation/deploy: **NO / NO / NO**.
- Production application checkpoint remains `eb02b17f488ef9ec13a11dcf158fc169b78e3e37`. The merge SHA is **not** a production application SHA.
- NEXT: **PSR-P2 INVENTORY SHADOW WRITER IMPLEMENTATION PACKAGE**. Not started. Not SHADOW activation. Not deploy.

---
## 08.14 — PSR-P2 Inventory SHADOW writer

- File: `audit/08.14-psr-p2-inventory-shadow-writer.md`
- Exact accepted implementation HEAD: `c58131c02484ae49897fa0259ad623af65708b9e`
- PR #22 merge: `2fd138e2c7195b63c2e943d0f85f2b9b0050740c`
- Accepted PR CI: `35427250317` SUCCESS. Post-merge CI: `35427681739` SUCCESS.
- HEAD review: **PASS**. Independent Opus: **PASS — P0=0 / P1=0 / P2=4**. W1/W4 CLOSED; W2/W3 accepted.
- Status: **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**.
- Source connected physical InventoryMovement contours: **Inventory conduct only**.
- Production application checkpoint remains `eb02b17f488ef9ec13a11dcf158fc169b78e3e37`. Production writer currently live = **NO**.
- Schema / migration: **NONE**
- SHADOW activation: **NO**
- Dual-write: **NOT STARTED**
- Production access/mutation/deploy: **NO / NO / NO**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 NORMAL TERMINAL PRODUCTION SHADOW WRITERS PACKAGE**. Not started. Not SHADOW activation. Not deploy.

---
## 08.15 — PSR-P2 terminal production SHADOW writers

- File: `audit/08.15-psr-p2-terminal-production-shadow-writers.md`
- Status: **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**
- Exact accepted implementation HEAD: `1367e306f4c5e0be77137cf005e7396bf110ae33`
- PR #24 merge: `853db69b00485f5201c2fd1046cc68b07ac69ded`
- Exact-head CI: `35439899641` SUCCESS. Post-merge CI: `35440444019` SUCCESS.
- HEAD final review: **PASS**. Independent Opus: **SKIPPED BY OWNER COST POLICY**. Initial findings P0=0 / P1=2 / P2=1. P1-01 / P1-02 / P2-01 **CLOSED**.
- Connected on source/main: Inventory conduct + normal TORCOVKA / PRISADKA / UPAKOVKA submits
- Production application checkpoint remains `eb02b17f488ef9ec13a11dcf158fc169b78e3e37`. Production writer currently live = **NO**. The merge SHA is **not** a production application SHA.
- Schema / migration: **NONE**
- SHADOW activation: **NO**
- Dual-write: **NOT STARTED**
- Production access/mutation/deploy: **NO / NO / NO**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 R-05 TORCOVKA CORRECTION SHADOW WRITER PACKAGE** (historical closeout next; this branch implements it in `audit/08.16`).

---
## 08.16 — PSR-P2 R-05 TORCOVKA correction SHADOW writer

- File: `audit/08.16-psr-p2-r05-correction-shadow-writer.md`
- Status: **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**
- Exact accepted implementation HEAD: `c9d3c0b62894d505987685ee399fa99c69ce3126`
- PR #26 merge: `debafdae9510acab7182e334fcfe1a5b00608e0d`
- Exact-head CI: `35443727340` SUCCESS. Post-merge CI: `35444256886` SUCCESS.
- HEAD final review: **PASS**. Findings: **P0=0 / P1=0 / P2=0**. Independent Opus: **SKIPPED BY OWNER COST POLICY**.
- Connected on source/main: Inventory conduct + normal TORCOVKA / PRISADKA / UPAKOVKA + R-05 `correctTorcovkaRailsTaken`
- Production application checkpoint remains `eb02b17f488ef9ec13a11dcf158fc169b78e3e37`. Production writer currently live = **NO**. The merge SHA is **not** a production application SHA.
- Schema / migration: **NONE**
- SHADOW activation: **NO**
- Dual-write: **NOT STARTED**
- Production access/mutation/deploy: **NO / NO / NO**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 SUPPLY PREREQUISITE FIX PACKAGE**. Not started. Not SHADOW activation. Not deploy. Do not start Supply from this file.

---
## 08.17 — PSR-P2 Supply writer prerequisite

- File: `audit/08.17-psr-p2-supply-prerequisite.md`
- Status: **IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / SUPPLY WRITER NOT STARTED**. HEAD `96558c6` **REQUEST CHANGES P0=0 / P1=2 / P2=0**. P1-01/P1-02 implemented on branch / **NOT CLOSED**.
- Base `origin/main`: `f740dbcc3a0838df85ad3a83a3a061e503368a4d`
- Production application checkpoint remains `eb02b17f488ef9ec13a11dcf158fc169b78e3e37`. Production writer currently live = **NO**.
- Production preflight: **NOT COMPLETED** (`SUPPLY_PREREQUISITE_PRODUCTION_QUERY_NOT_RUN`)
- Schema / migration: **NONE**
- SHADOW activation: **NO**
- Dual-write: **NOT STARTED**
- Production mutation/deploy: **NO / NO**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **HEAD RE-REVIEW OF SUPPLY PREREQUISITE FIX PR**. Not merge. Not deploy. Not SHADOW activation. Not Supply writer.
