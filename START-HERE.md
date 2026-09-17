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

`92532e818df41160b434caac2c6d94933e93d810`

`Merge pull request #7 from Mr-Pinkerton/feat/psr-p1-inventory-movement-shadow-schema`

This SHA is the current production **application** checkpoint and was deployed (Production Deploy `35228794988` SUCCESS). PSR-P1 = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`). `InventoryMovement` exists and is empty (row count = 0). No runtime writers. `production_cost_flow` remains INACTIVE (existing canonical delivery state; no fresh live query in this closeout).

Always verify current `main` HEAD.

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

**NEXT = PSR-P2 GENERAL PRECONDITIONS — PRODUCTION PREFLIGHT / DEPLOYMENT DECISION.** This NEXT is **not** dual-write. Separate production preflight and owner authorization are required before deploy. PSR-P1 schema contract = **ACCEPTED DESIGN** (`audit/08.05`; historical contract-creation status **ACCEPTED DESIGN / NOT IMPLEMENTED** is preserved there). Independent Review #1 = **PASS WITH NON-BLOCKING FINDINGS**, P0=0, P1=0. Current implementation/deploy = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`). Empty unused SHADOW-capable table; last verified P1 production row count = **0** (historical closeout evidence; not reverified here); no runtime writers. `PSR-Q-004` / R-07 / R-10 / R-11 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / NOT DEPLOYED** (`audit/08.07`; Canonical? **YES**; PR #9 merge `3f89fff`). PSR-P2 dual-write **NOT STARTED**. PSR-P0 = **COMPLETE / ACCEPTED** as an architecture/design contract only (`audit/08.03` + `audit/08.04`). `PSR-Q-001` / `Q2` / `Q5` / `Q7` / `Q8` and `PSR-DESIGN-001` / `002` = **CLOSED / ACCEPTED**. Remaining: R-04/R-05/R-06 OPEN before their contour dual-write. `PSR-Q-003` remains before P4. `PSR-Q-006` remains before P6. Does **not** mean dual-write, authoritative ledger, paper removal, `production_cost_flow` activation, or Correction Center. Do not implement Correction Center / `ProductionOperationMutation` / dual-write from this file alone.

Historical documentation recovery checkpoint (no longer current on main):

`6dec426b25b25c663ec26ea5ac1debeabe570dc4`

Last pre-incident application-code checkpoint:

`d9f940e8540801bdb27dd72210193f5e4ab038c3`

`fix: enforce prisadka inventory boundary`

INC-001 containment SHA (still in the running tree):

`3608b36bd324a5118f4ba5b1bbb21462cc0723d9`

## Current work mode

The project on `main`: PR #9 implementation merge checkpoint = `3f89fffb8dc5842027420095bd3c85a07a85e284`; always verify the current GitHub `main` HEAD before relying on a branch SHA. Production application remains `92532e8` (intentionally behind GitHub `main` until a separately authorized deploy); AUDIT 1 complete; ARCH-2 architecture **ACCEPTED / REVIEWED**; PSR-P0-CORR **ACCEPTED DESIGN / NOT IMPLEMENTED**; PSR-P0-CORE = **ACCEPTED DESIGN / NOT IMPLEMENTED** (`audit/08.04`); PSR-P1 schema contract = **ACCEPTED DESIGN** (`audit/08.05`; historical **NOT IMPLEMENTED** at contract creation preserved); PSR-P1 implementation/deploy = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`); PSR-P0 **COMPLETE / ACCEPTED** as design contract only; `PSR-Q-004` / R-07 / R-10 / R-11 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / NOT DEPLOYED** (`audit/08.07`; Canonical? **YES**); PSR-P2 dual-write **NOT STARTED**; INC-001 open; AUDIT 2 not started.

**NEXT = PSR-P2 GENERAL PRECONDITIONS — PRODUCTION PREFLIGHT / DEPLOYMENT DECISION.** This NEXT is **not** dual-write and is **not** a deploy from this file. Separate production preflight and owner authorization are required before deploy. R-04 / R-05 / R-06 remain OPEN. Do not implement dual-write, Correction Center schema, or a production deploy from this file.

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
