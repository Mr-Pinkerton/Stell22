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

## Current documentation checkpoint

`6dec426b25b25c663ec26ea5ac1debeabe570dc4`

This checkpoint includes the canonical `PROJECT.md` and `audit/AUDIT-INDEX.md` recovery documents.
Always verify current `main` before relying on this SHA because later commits may exist.

Last verified application-code checkpoint before the recovery-doc commits:

`d9f940e8540801bdb27dd72210193f5e4ab038c3`

`fix: enforce prisadka inventory boundary`

## Current work mode

The project is in a **system audit** phase.

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
