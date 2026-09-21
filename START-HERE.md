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

`2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf`

This SHA is the current production **application** checkpoint and was deployed (Production Deploy `35616829882` SUCCESS). Package 3 quantity-edit SHADOW writers = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE** (`audit/08.24`). Package 2 quantity-edit identity remains **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.23`). Migration `20260920180000_psr_p2_production_quantity_edit_identity` **APPLIED**. `ProductionOperationQuantityEdit` **LIVE**. Read-only Package 3 verifier run `35619733266` **PASS** (`PACKAGE3_PRODUCTION_POST_DEPLOY_VERIFY_OK`). `P2_ROW_COUNT=0` at that checkpoint is observational. `InventoryMovement` remains empty (0). `inventory_movement_shadow_write` remains **ABSENT**. `production_cost_flow` remains **ABSENT**. Package 1 safe destructive guards remain **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.22`). Source/`main` connected physical writer contours = **12**. Production deployed dormant contours = **12** (all **DEPLOYED DORMANT / SHADOW INACTIVE**). Remaining enabled uncovered physical contours = **0**. PSR-P2 dual-write **NOT STARTED**. Ledger **NOT AUTHORITATIVE**. PSR-P2 **NOT COMPLETE**. PSR-P3 **NOT STARTED**. Current pre-PR-#49 GitHub `main` is `231026601cdbaa0ff1a8a80411f90a33b92eaef8`, the PR #48 control-plane merge. It is **not** a production application SHA. Historical PR #46 verifier merge `49aa1209e7815d8545b6c45f42ca0770a26a767b` is historical only. A later docs-only PR #49 merge will also **not** become a production application deployment. Production application remains `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf`. Always verify current GitHub `main` HEAD.

Prior production application checkpoint (**historical**, do not rewrite):

`b033cfad88f01d9231f7b892fcce290244f48130`

Production Deploy `35536089109` SUCCESS. Package 2 quantity-edit identity **DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.23`).

Prior production application checkpoint (**historical**, do not rewrite):

`4508ee1c5d242e679f18e331c35efc679e37c10c`

Production Deploy `35524416936` SUCCESS. Package 1 safe destructive guards **DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.22`).

Prior production application checkpoint (**historical**, do not rewrite):

`69e0f53993d5b02f27f0fc03682cef492c02d685`

Production Deploy `35510094974` SUCCESS. Raw SHADOW writers **DEPLOYED DORMANT / SHADOW INACTIVE** (`audit/08.20`).

Prior production application checkpoint (**historical**, do not rewrite):

`0cc8382f307ac1ff7fa881012033f5105e689a23`

Production Deploy `35502770382` SUCCESS. Raw identity prerequisite **DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.19`).

Prior production application checkpoint (**historical**, do not rewrite):

`eb02b17f488ef9ec13a11dcf158fc169b78e3e37`

Production Deploy `35337215903` SUCCESS. R-06 Inventory physical identity **DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`).

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

**NEXT = PRODUCTION ENVIRONMENT REF-POLICY HARDENING**. Purpose: make GitHub Environment `production` refuse deployment and use from non-canonical refs before any SHADOW activation is considered. This NEXT is not authorization to change that environment, not authorization to activate SHADOW, and not authorization to deploy. Owner decision **CHANGE HEAD AFTER PACKAGE 3** = **FULFILLED**. The current HEAD may proceed only according to the canonical NEXT after this closeout is merged. This does not authorize the Environment mutation inside PR #49. Package 3 = `audit/08.24` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**). Package 2 = `audit/08.23` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED**). `08.21` = **DISCOVERY COMPLETE / ARCHITECTURE ACCEPTED / REVIEWED / NO IMPLEMENTATION**. Canonical? **YES**. `08.22` = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED**. Do not activate SHADOW from this file. Raw SHADOW writers = `audit/08.20` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**; PR #36 accepted head `424f119`; merge `0bf2c77`; Production Deploy `35510094974`; deployed application `69e0f53`; source/`main` contours **9**; production dormant contours **9**; SHADOW **NOT ACTIVATED**). Raw identity prerequisite = `audit/08.19` (**IMPLEMENTED / MERGED / DEPLOYED / POST-DEPLOY VERIFIED**; Production Deploy `35502770382`; PR #33 accepted head `919a427`; merge `76131ca`). Schema/migration **APPLIED** in production. Tables LIVE / EMPTY AT CUTOVER. Supply SHADOW writer = `audit/08.18` (**DEPLOYED DORMANT / SHADOW INACTIVE**; PR #31; accepted head `2e90060`; merge `164ffca`). HEAD review **PASS**. Findings **P0=0 / P1=0 / P2=0**. P1-01 **CLOSED**. P2-01 **CLOSED**. Independent Opus **SKIPPED BY OWNER COST POLICY**. R-05 correction SHADOW writer = `audit/08.16` (**DEPLOYED DORMANT / SHADOW INACTIVE**; PR #26; accepted head `c9d3c0b`; merge `debafda`). HEAD review **PASS**. Findings **P0=0 / P1=0 / P2=0**. Independent Opus **SKIPPED BY OWNER COST POLICY**. Terminal production SHADOW writers = `audit/08.15` (**DEPLOYED DORMANT / SHADOW INACTIVE**; PR #24; accepted head `1367e30`; merge `853db69`). Inventory SHADOW writer on `main` = **DEPLOYED DORMANT / SHADOW INACTIVE** (`audit/08.14`; PR #22; accepted head `c58131c`; merge `2fd138e`). Inventory writer prerequisite historical implementation status = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; current runtime = **DEPLOYED DORMANT** (`audit/08.13`; PR #20; accepted head `1f8b1d6`; merge `4dfaae2`). Inventory writer itself remains separately **DEPLOYED DORMANT / SHADOW INACTIVE** (`audit/08.14`). P2-GUARD/CI historical implementation status = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; current runtime = **DEPLOYED DORMANT** (`audit/08.12`; PR #18; accepted head `91c7e3e`; merge `643c796`). R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`; Production Deploy `35337215903`). Source/`main` connected physical InventoryMovement contours = **12**: Inventory conduct; normal TORCOVKA; normal PRISADKA; normal UPAKOVKA; R-05 correction; Supply deduction / Ozon restore; `createBatch` receipt; `writeOffBatchRemainder` adjustment; `createSimplePurchase` receipt; TORCOVKA quantity edit; PRISADKA quantity edit; UPAKOVKA quantity edit. Production deployed dormant contours = **12**: the same twelve, all **DEPLOYED DORMANT / SHADOW INACTIVE**. Remaining enabled uncovered physical contours = **0**. Production Supply preflight = **COMPLETE / TRUSTED** (rerun `35452435411`; TOTAL=0 / D=0 / S=0 / O=0; `SUPPLY_DATA_BLOCKER=NO`). This is **not** SHADOW activation, **not** dual-write activation, **not** Correction Center / full `ProductionOperationMutation`, and **not** AUDIT 2. R-05 identity prerequisite remains **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.09`; Production Deploy `35329071777`). R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.08`; Production Deploy `35314440036`). PSR-P1 schema contract = **ACCEPTED DESIGN** (`audit/08.05`; historical contract-creation status **ACCEPTED DESIGN / NOT IMPLEMENTED** is preserved there). Current P1 implementation/deploy = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`). `PSR-Q-004` / R-07 / R-10 / R-11 remain **DEPLOYED DORMANT** (`audit/08.07`). PSR-P2 dual-write **NOT STARTED**. PSR-P2 globally **NOT COMPLETE**. PSR-P3 **NOT STARTED**. PSR-P0 = **COMPLETE / ACCEPTED** as an architecture/design contract only (`audit/08.03` + `audit/08.04`). `PSR-Q-003` remains before P4. `PSR-Q-006` remains before P6. Does **not** mean dual-write, authoritative ledger, paper removal, `production_cost_flow` activation, or Correction Center. Do not implement remaining mutation/destructive contours from this file. Do not implement Correction Center / `ProductionOperationMutation` / dual-write from this file alone.

Historical documentation recovery checkpoint (no longer current on main):

`6dec426b25b25c663ec26ea5ac1debeabe570dc4`

Last pre-incident application-code checkpoint:

`d9f940e8540801bdb27dd72210193f5e4ab038c3`

`fix: enforce prisadka inventory boundary`

INC-001 containment SHA (still in the running tree):

`3608b36bd324a5118f4ba5b1bbb21462cc0723d9`

## Current work mode

The project on `main`: production application = `2d2cbcbd` (Production Deploy `35616829882`). Current GitHub `main` `231026601cdbaa0ff1a8a80411f90a33b92eaef8` is the PR #48 control-plane merge and is **not** a production application SHA. Historical PR #46 verifier merge `49aa1209` is also **not** a production application SHA. Always verify the current GitHub `main` HEAD before relying on a branch SHA. AUDIT 1 complete; ARCH-2 architecture **ACCEPTED / REVIEWED**; PSR-P0-CORR **ACCEPTED DESIGN / NOT IMPLEMENTED**; PSR-P0-CORE = **ACCEPTED DESIGN / NOT IMPLEMENTED** (`audit/08.04`); PSR-P1 schema contract = **ACCEPTED DESIGN** (`audit/08.05`; historical **NOT IMPLEMENTED** at contract creation preserved); PSR-P1 implementation/deploy = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`); PSR-P0 **COMPLETE / ACCEPTED** as design contract only; `PSR-Q-004` / R-07 / R-10 / R-11 remain **DEPLOYED DORMANT** (`audit/08.07`); R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.08`); R-05 identity = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.09`); R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`); source/`main` connected contours **12**; production deployed dormant contours **12** (all twelve **DEPLOYED DORMANT / SHADOW INACTIVE**); remaining enabled uncovered contours **0**; PSR-P2 dual-write **NOT STARTED**; INC-001 open; AUDIT 2 not started.

**NEXT = PRODUCTION ENVIRONMENT REF-POLICY HARDENING**. Purpose: make GitHub Environment `production` refuse deployment and use from non-canonical refs before any SHADOW activation is considered. This NEXT is not authorization to change that environment, not authorization to activate SHADOW, and not authorization to deploy. Owner decision **CHANGE HEAD AFTER PACKAGE 3** = **FULFILLED**. The current HEAD may proceed only according to the canonical NEXT after this closeout is merged. This does not authorize the Environment mutation inside PR #49. Package 3 = `audit/08.24` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**). Package 2 = `audit/08.23` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED**). `08.21` = **DISCOVERY COMPLETE / ARCHITECTURE ACCEPTED / REVIEWED / NO IMPLEMENTATION**. Canonical? **YES**. `08.22` = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED**. Do not activate SHADOW from this file. Raw SHADOW writers = `audit/08.20` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**; PR #36 accepted head `424f119`; merge `0bf2c77`; Production Deploy `35510094974`; deployed application `69e0f53`; source/`main` contours **9**; production dormant contours **9**; SHADOW **NOT ACTIVATED**). Raw identity prerequisite = `audit/08.19` (**IMPLEMENTED / MERGED / DEPLOYED / POST-DEPLOY VERIFIED**; Production Deploy `35502770382`; PR #33 accepted head `919a427`; merge `76131ca`). Schema/migration **APPLIED** in production. Tables LIVE / EMPTY AT CUTOVER. Supply SHADOW writer = `audit/08.18` (**DEPLOYED DORMANT / SHADOW INACTIVE**; PR #31; accepted head `2e90060`; merge `164ffca`). HEAD review **PASS**. Findings **P0=0 / P1=0 / P2=0**. P1-01 **CLOSED**. P2-01 **CLOSED**. Independent Opus **SKIPPED BY OWNER COST POLICY**. R-05 correction writer = `audit/08.16` (**DEPLOYED DORMANT / SHADOW INACTIVE**). Terminal production writers = `audit/08.15` (**DEPLOYED DORMANT / SHADOW INACTIVE**). Inventory SHADOW writer on `main` = **DEPLOYED DORMANT / SHADOW INACTIVE** (`audit/08.14`). Inventory writer prerequisite current runtime = **DEPLOYED DORMANT** (`audit/08.13`; historical implementation status **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**). P2-GUARD/CI current runtime = **DEPLOYED DORMANT** (`audit/08.12`; historical implementation status **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**). Supply prerequisite = `audit/08.17` (**COMPLETE / DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**). This is **not** SHADOW activation, **not** dual-write activation, **not** Correction Center / full `ProductionOperationMutation`, and **not** AUDIT 2. Do not start remaining mutation/destructive implementation from this file. Do not activate SHADOW. Do not implement dual-write or Correction Center schema from this file.

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
- production application checkpoint is now `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf` (Production Deploy `35616829882`). Historical Package 2 application `b033cfad88f01d9231f7b892fcce290244f48130` and Package 1 application `4508ee1c5d242e679f18e331c35efc679e37c10c` are **not** current.

P2-GUARD/CI historical implementation status = **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**; current runtime = **DEPLOYED DORMANT** (`audit/08.12`). Inventory writer prerequisite current runtime = **DEPLOYED DORMANT** (`audit/08.13`; historical implementation status **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**). Inventory writer itself remains separately **DEPLOYED DORMANT / SHADOW INACTIVE** (`audit/08.14`). Terminal production writers = `audit/08.15` (**DEPLOYED DORMANT / SHADOW INACTIVE**). R-05 correction writer = `audit/08.16` (**DEPLOYED DORMANT / SHADOW INACTIVE**). Supply prerequisite = `audit/08.17` (**COMPLETE / DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**). Supply SHADOW writer = `audit/08.18` (**DEPLOYED DORMANT / SHADOW INACTIVE**). Raw identity prerequisite = `audit/08.19` (**IMPLEMENTED / MERGED / DEPLOYED / POST-DEPLOY VERIFIED**; Production Deploy `35502770382`). Raw SHADOW writers = `audit/08.20` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**; PR #36 merge `0bf2c77`; Production Deploy `35510094974`; deployed application `69e0f53`). Remaining mutation / destructive discovery = `audit/08.21` (**ARCHITECTURE ACCEPTED / REVIEWED**; Canonical? **YES**; no implementation in that file). Safe destructive guards = `audit/08.22` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED**; historical Package 1 Production Deploy `35524416936`; historical Package 1 application `4508ee1`). Quantity-edit identity = `audit/08.23` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED**). Quantity-edit SHADOW writers = `audit/08.24` (**IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**). **NEXT = PRODUCTION ENVIRONMENT REF-POLICY HARDENING**. Purpose: make GitHub Environment `production` refuse deployment and use from non-canonical refs before any SHADOW activation is considered. This NEXT is not authorization to change that environment, not authorization to activate SHADOW, and not authorization to deploy.

---
## 08.13 — PSR-P2 Inventory writer prerequisite closeout

- File: `audit/08.13-psr-p2-inventory-writer-prerequisite.md`
- Exact accepted implementation HEAD: `1f8b1d64e7d4d7828606514f728c4603f1281244`
- PR #20 merge: `4dfaae26471188db04d76262d9776336aada854a`
- Accepted PR CI: `35379385996` SUCCESS. Post-merge CI: `35422069460` SUCCESS.
- HEAD review: **PASS**. Independent Opus: **PASS**. P0=0 / P1=0 / P2=5 (non-blocking; dispositioned in `08.13` §10).
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / INVENTORY WRITER NOT STARTED**.
- Current runtime after 2026-09-20 application deploy: prerequisite code **DEPLOYED DORMANT**. Writer itself is `audit/08.14`.
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`.
- SHADOW activation: **NO**.
- Dual-write: **NOT STARTED**.
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Not SHADOW activation.

---
## 08.14 — PSR-P2 Inventory SHADOW writer

- File: `audit/08.14-psr-p2-inventory-shadow-writer.md`
- Exact accepted implementation HEAD: `c58131c02484ae49897fa0259ad623af65708b9e`
- PR #22 merge: `2fd138e2c7195b63c2e943d0f85f2b9b0050740c`
- Accepted PR CI: `35427250317` SUCCESS. Post-merge CI: `35427681739` SUCCESS.
- HEAD review: **PASS**. Independent Opus: **PASS — P0=0 / P1=0 / P2=4**. W1/W4 CLOSED; W2/W3 accepted.
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**.
- Current runtime: **DEPLOYED DORMANT / SHADOW INACTIVE**.
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`.
- Dual-write: **NOT STARTED**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Not SHADOW activation.

---
## 08.15 — PSR-P2 terminal production SHADOW writers

- File: `audit/08.15-psr-p2-terminal-production-shadow-writers.md`
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**
- Exact accepted implementation HEAD: `1367e306f4c5e0be77137cf005e7396bf110ae33`
- PR #24 merge: `853db69b00485f5201c2fd1046cc68b07ac69ded`
- Exact-head CI: `35439899641` SUCCESS. Post-merge CI: `35440444019` SUCCESS.
- Current runtime: **DEPLOYED DORMANT / SHADOW INACTIVE**
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`
- Dual-write: **NOT STARTED**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Historical closeout next was R-05 writer (`audit/08.16`).

---
## 08.16 — PSR-P2 R-05 TORCOVKA correction SHADOW writer

- File: `audit/08.16-psr-p2-r05-correction-shadow-writer.md`
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**
- Exact accepted implementation HEAD: `c9d3c0b62894d505987685ee399fa99c69ce3126`
- PR #26 merge: `debafdae9510acab7182e334fcfe1a5b00608e0d`
- Current runtime: **DEPLOYED DORMANT / SHADOW INACTIVE**
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`
- Dual-write: **NOT STARTED**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Historical closeout next was Supply prerequisite (`audit/08.17`).

---
## 08.17 — PSR-P2 Supply writer prerequisite

- File: `audit/08.17-psr-p2-supply-prerequisite.md`
- Historical implementation status (preserved): **COMPLETE / NOT DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**. P1-01/P1-02 **CLOSED**. `SUPPLY-PREFLIGHT-PARSER-001` **CLOSED**. P2-01 **CLOSED**.
- Current runtime: **COMPLETE / DEPLOYED / PRODUCTION PREFLIGHT COMPLETE / TRUSTED**. Latest preflight rerun `35502680346` TOTAL=0 / D=0 / S=0 / O=0 / `SUPPLY_DATA_BLOCKER=NO`.
- Accepted implementation HEAD `8e92dd62caf063914e56d4105d550fb2fe1505af`. PR #28 merge `5fe5f40572ce9259c3725a93516a76f9533f07ab`. Exact-head CI `35449013808` SUCCESS. Post-merge CI `35449670249` SUCCESS.
- Initial HEAD review `96558c66...` REQUEST CHANGES P0=0 / P1=2 / P2=0. Final implementation HEAD review **PASS**.
- Parser-fix PR #29 accepted HEAD `7795e88d9bf250c330db3cc3b360b780a18148c5`. Exact-head CI `35451478137` SUCCESS. HEAD final re-review **PASS** P0=0 / P1=0 / P2=0. Merge `eb79b261ed8c2dfe423ba9207d48e7d29e14dbd8`. Post-merge CI `35452147190` SUCCESS.
- Historical failed preflight `35449877592` (`SUPPLY-PREFLIGHT-PARSER-001`; no trusted counts). Trusted rerun `35452435411` SUCCESS: TOTAL=0 / DEDUCTED_POSITIVE=0 / SHORTFALL_ONLY=0 / OPEN_DEDUCTED_POSITIVE=0 / `SUPPLY_DATA_BLOCKER=NO`.
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`.
- Supply writer: now recorded in `audit/08.18` as **DEPLOYED DORMANT / SHADOW INACTIVE**
- Dual-write: **NOT STARTED**
- `production_cost_flow`: **INACTIVE**
- Ledger authoritative: **NO**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Not SHADOW activation.

---
## 08.18 — PSR-P2 Supply SHADOW writer

- File: `audit/08.18-psr-p2-supply-shadow-writer.md`
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**
- Accepted HEAD: `2e90060d145bac9fc9eb6b2fcaef4253fbfe877b`
- Merge: `164ffca49d5200af0b442de05c8966fc3b5c70ed`
- Current runtime: **DEPLOYED DORMANT / SHADOW INACTIVE**
- Production application checkpoint: `0cc8382f307ac1ff7fa881012033f5105e689a23`
- Dual-write: **NOT STARTED**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Not SHADOW activation.

---
## 08.19 — PSR-P2 raw receipt / write-off identity prerequisite

- File: `audit/08.19-psr-p2-raw-identity-prerequisite.md`
- Historical implementation status (preserved): **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**
- Accepted HEAD: `919a427e187f60c83b09658a8ad4a8ecafbd2d82`
- Merge: `76131ca1a77b8c20d920055be66361bd0ab9f4c4`
- Current status: **IMPLEMENTED / MERGED / DEPLOYED / POST-DEPLOY VERIFIED**
- Historical identity-prerequisite Production Deploy: `35502770382` SUCCESS
- Historical identity-prerequisite application: `0cc8382f307ac1ff7fa881012033f5105e689a23`
- Current production application: `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf`
- Current Production Deploy: `35616829882` SUCCESS
- Target migration: **APPLIED**
- Identity tables: LIVE / EMPTY AT CUTOVER
- Historical backfill: **NO**
- InventoryMovement writers from this package: **NO**. Historical state at identity-prerequisite closeout: connected contours **6** and **DEPLOYED DORMANT / SHADOW INACTIVE**. Historical state after `audit/08.20` deploy: connected contours **9**. Current source/`main` after `audit/08.24` deploy: connected contours **12**. Current production: deployed dormant contours **12**.
- Dual-write: **NOT STARTED**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- Historical NEXT, superseded: **NEW HEAD TAKEOVER / PSR-P2 SHADOW ACTIVATION & DUAL-WRITE START READINESS REVIEW**. Historical 08.19 closeout NEXT was Package 2 identity. Current implementation: `audit/08.24` **DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**. Not SHADOW activation.

## 08.20 — PSR-P2 raw receipt / write-off SHADOW writers

- File: `audit/08.20-psr-p2-raw-shadow-writers.md`
- Status: **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**
- Accepted HEAD: `424f1191f093bafda5a8d98a387d0b7da2822324`
- Implementation PR: #36
- Merge: `0bf2c77f25b76c183d86bd571ad685e679c577da`
- Historical / package Production Deploy: `35510094974` SUCCESS
- Historical / package deployment application: `69e0f53993d5b02f27f0fc03682cef492c02d685`
- Current production application: `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf`
- Current Production Deploy: `35616829882` SUCCESS
- Exact-head CI: `35507221861` SUCCESS
- Post-merge CI: `35507868236` SUCCESS
- HEAD review: **PASS** — P0=0 / P1=0 / P2=0
- Historical package source/`main` contours: **9**
- Current source/`main` contours: **12**
- Current production dormant contours: **12**
- Schema / migration: **NO** — **NO NEW MIGRATION**
- SHADOW activation: **NO**
- Dual-write: **NOT STARTED**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- Historical NEXT, superseded: **NEW HEAD TAKEOVER / PSR-P2 SHADOW ACTIVATION & DUAL-WRITE START READINESS REVIEW**. Historical 08.20 closeout NEXT was Package 2 identity. Current implementation: `audit/08.24` **DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**. Not SHADOW activation.

## 08.21 — PSR-P2 remaining mutation / destructive contours

- File: `audit/08.21-psr-p2-remaining-mutation-destructive-adjudication.md`
- Status: **DISCOVERY COMPLETE / ARCHITECTURE ACCEPTED / REVIEWED / NO IMPLEMENTATION**
- Canonical?: **YES**
- Starting `origin/main`: `289979b091dab5b77b4e988ae98b94a281afdfdb`
- Initial audit HEAD: `6f11e38ac972685488f88c9015119c043aee4e7d`
- HEAD-adjudication commit: `a9567b6bcfb6fb5b1761aa618d33cee1cd2c60fc`
- HEAD review: **REQUEST CHANGES** — P0=0 / P1=1 / P2=0. Discovery/exhaustiveness **PASS**. P1-01 closed by HEAD (net ADJUSTMENT).
- Independent Opus: **PASS** — Claude Opus (`claude-opus-5-thinking-high`); reviewed `a9567b6`; 2026-09-20; P0=0 / P1=0 / P2=4 informational; architecture unchanged.
- Schema / migration / runtime: **NO**
- Production access: **NO**
- SHADOW activation: **NO**
- Dual-write: **NOT STARTED**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 PRODUCTION QUANTITY-EDIT IDENTITY PREREQUISITE**. Historical 08.21 closeout NEXT. Current implementation: `audit/08.23` identity + `audit/08.24` writers.

## 08.22 — PSR-P2 Package 1 safe destructive guards

- File: `audit/08.22-psr-p2-safe-destructive-guards.md`
- Status: **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED**
- Starting `origin/main`: `6c858db0cc21a456e7d6c10825b9aaad002cae72`
- Implementation PR: #40
- Accepted exact PR HEAD: `e4023281879316a3a809e6f0358827671aca760d`
- Final accepted exact-head CI: `35518350211` SUCCESS
- Merge: `4508ee1c5d242e679f18e331c35efc679e37c10c`
- Post-merge CI: `35523711293` SUCCESS
- Production Deploy: `35524416936` SUCCESS
- Deployed application: `4508ee1c5d242e679f18e331c35efc679e37c10c`
- Previous production application: `69e0f53993d5b02f27f0fc03682cef492c02d685`
- HEAD review: **PASS** — P0=0 / P1=0 / P2=2 informational
- Schema / migration: **NO CHANGE / NO NEW MIGRATION**
- InventoryMovement writer added: **NO**
- SHADOW activation: **NO**
- Remaining enabled uncovered physical contours in production: **A / B / C = 3**
- Source/`main` connected contours: **9** (unchanged)
- Production dormant writers: **9**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- Independent Opus: **SKIPPED BY OWNER COST POLICY**
- NEXT: **PSR-P2 PRODUCTION QUANTITY-EDIT IDENTITY PREREQUISITE**. Historical 08.22 closeout NEXT. Current implementation: `audit/08.23`.

## 08.23 — PSR-P2 Package 2 production quantity-edit identity

- File: `audit/08.23-psr-p2-production-quantity-edit-identity.md`
- Status: **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED**
- Starting `origin/main`: `fb22ab7ce2e55cf9ee4aee8026298f488107698c`
- Implementation PR: [#42](https://github.com/Mr-Pinkerton/Stell22/pull/42). Accepted exact HEAD `e143e22b6f805c9d4d053d761b5629fa5a325d9b`. Accepted exact-head CI `35534868456` SUCCESS. Merge `b033cfad88f01d9231f7b892fcce290244f48130`. Post-merge CI `35535532806` SUCCESS.
- Production Deploy: `35536089109` SUCCESS
- Production application: `b033cfad88f01d9231f7b892fcce290244f48130`
- Previous production application: `4508ee1c5d242e679f18e331c35efc679e37c10c`
- Migration: `20260920180000_psr_p2_production_quantity_edit_identity` **APPLIED**
- `ProductionOperationQuantityEdit`: **LIVE / EMPTY AT VERIFICATION**
- Verifier PR: [#43](https://github.com/Mr-Pinkerton/Stell22/pull/43). Merge `6621e875fdb10b720886708c361df13a08c7a471` (**not** a production application SHA)
- Read-only verifier run: `35592291536` **PASS**
- InventoryMovement: **0**
- SHADOW: **ABSENT**
- `production_cost_flow`: **ABSENT**
- InventoryMovement writer added: **NO**
- Dual-write: **NOT STARTED**
- Package 3: **NOT STARTED**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- NEXT: **PSR-P2 PRODUCTION QUANTITY-EDIT SHADOW WRITERS (PACKAGE 3)**. Historical 08.23 closeout NEXT. Current implementation: `audit/08.24` **DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**.

## 08.24 — PSR-P2 Package 3 production quantity-edit SHADOW writers

- File: `audit/08.24-psr-p2-production-quantity-edit-shadow-writers.md`
- Status: **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**
- Implementation PR: [#45](https://github.com/Mr-Pinkerton/Stell22/pull/45). Accepted exact HEAD `7f090e132267edf7e0b6251d65b93b6a3c129a2e`. Accepted candidate tree `3e8fde498c6d542d6dfc04295ede064afb73a0a5`. Final PR merge-ref CI `35612492381` SUCCESS. Merge `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf`. Post-merge CI `35615386224` SUCCESS.
- Production Deploy: `35616829882` SUCCESS
- Production application: `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf`
- Previous production application: `b033cfad88f01d9231f7b892fcce290244f48130`
- Verifier PR: [#46](https://github.com/Mr-Pinkerton/Stell22/pull/46). Merge `49aa1209e7815d8545b6c45f42ca0770a26a767b` (**not** a production application SHA)
- Post-verifier-merge CI: `35619130027` SUCCESS
- Read-only verifier run: `35619733266` **PASS** (`PACKAGE3_PRODUCTION_POST_DEPLOY_VERIFY_OK`)
- InventoryMovement: **0**
- SHADOW: **ABSENT**
- `production_cost_flow`: **ABSENT**
- Schema / migration: **NO / NO**
- Source/`main` connected contours: **12**
- Production dormant contours: **12**
- Remaining enabled uncovered contours: **0**
- Dual-write: **NOT STARTED**
- Runtime P2 global completeness: **NOT COMPLETE**
- P3: **NOT STARTED**
- `ARCH-P1-001`: **OPEN / CONFIRMED**
- Independent Opus: **COMPLETED** — implementation P0=0 / P1=0; initial evidence P2=1 closed by HEAD via PR #45 comment `5762512562`. Final acceptance P0=0 / P1=0 / P2=0.
- Historical NEXT at the Package 3 closeout, superseded: **NEW HEAD TAKEOVER / PSR-P2 SHADOW ACTIVATION & DUAL-WRITE START READINESS REVIEW**. Not SHADOW activation. Not PSR-P3.

## 08.25 — PSR-P2 SHADOW activation control and start verification

- File: `audit/08.25-psr-p2-shadow-activation-control.md`
- Status: **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / POST-MERGE VERIFIED / NOT RUN IN PRODUCTION / SHADOW INACTIVE**
- Canonical?: **YES** after this docs closeout is accepted and merged
- Accepted HEAD: `7e58c3df7836cc46591c682496eef78b83f7d955`
- Accepted tree: `b5c8e5a19904006784fdc8d2018f45f1ec5cb909`
- Candidate PR CI: `35637791430` SUCCESS. Evidence class = **PR MERGE-REF CI / EXACT CANDIDATE-TREE VERIFIED**. Merge-ref `3ba02c69d39bdc3cdd161bd0523e76fce7c57572`.
- Implementation merge: `231026601cdbaa0ff1a8a80411f90a33b92eaef8`. Parents `693a9f12` + `7e58c3df`. Merged tree equals the accepted tree.
- Post-merge CI: `35638837175` SUCCESS (`push`, SHA `231026601cdbaa0ff1a8a80411f90a33b92eaef8`)
- Control plane is merged and is not a separate production application deploy
- Production application pin: `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf` (unchanged)
- `PRODUCTION_ENVIRONMENT_REF_POLICY`: **UNSAFE**
- SHADOW activation: **NO**
- Dual-write: **NOT STARTED**
- Ledger: **NOT AUTHORITATIVE**
- PSR-P2: **NOT COMPLETE**
- PSR-P3: **NOT STARTED**
- `ARCH-P1-001`: **OPEN / CONFIRMED**
- `INC-001`: **OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION**
- AUDIT 1: **COMPLETE / REVIEWED**. AUDIT 2: **NOT STARTED**
- Connected / deployed dormant contours: **12 / 12**. Remaining enabled uncovered contours: **0**
- NEXT: **PRODUCTION ENVIRONMENT REF-POLICY HARDENING**. Not an environment change, not SHADOW activation, and not a deploy.
- This section does not authorize dispatch of the control or post-activation workflows.
