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

`71a01b40008cf6da7cbc843b3b0dbaa31cf01853`

`Merge pull request #1 from Mr-Pinkerton/integration/p2025-di020`

This SHA is the current production **application** checkpoint on GitHub `origin/main` and was deployed (Production Deploy `34635510843` SUCCESS). A later documentation merge of ARCH-2 does **not** change this application SHA and is **not** a production application deploy. Always verify current `main` before relying on it.

## ARCH-2 — Primary-System Readiness

Canonical architecture: `audit/08.02-primary-system-readiness-architecture.md`

Status: **`ACCEPTED / REVIEWED`**.

Independent Review #1 = REQUEST CHANGES (R1…R6 CLOSED/PASS). Independent Review #2 = REQUEST CHANGES (R7…R8 CLOSED/PASS). Independent Review #3 = **PASS / ACCEPT** (new blockers = 0).

`ACCEPTED / REVIEWED` means the architecture **contract** is accepted. It does **not** mean PSR implementation complete, primary-system readiness achieved, ledger deployed, paper removable, or `production_cost_flow` active.

**NEXT = PSR-P0** — pre-schema contracts / design closure. Not InventoryMovement schema. Do not start PSR-P0 automatically from this acceptance.

Historical documentation recovery checkpoint (no longer current on main):

`6dec426b25b25c663ec26ea5ac1debeabe570dc4`

Last pre-incident application-code checkpoint:

`d9f940e8540801bdb27dd72210193f5e4ab038c3`

`fix: enforce prisadka inventory boundary`

INC-001 containment SHA (still in the running tree):

`3608b36bd324a5118f4ba5b1bbb21462cc0723d9`

## Current work mode

The project on `main`: production application at `71a01b4`; AUDIT 1 complete; ARCH-2 architecture **ACCEPTED / REVIEWED**; INC-001 open; AUDIT 2 not started.

**NEXT = PSR-P0** (pre-schema contracts). Not started. Do not implement InventoryMovement / dual-write / cutover until PSR-P0 closes the schema-shaping questions.

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
