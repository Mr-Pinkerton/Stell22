# Stell22 Audit — Index

Updated: 2026-09-09

## Purpose

This is the canonical audit navigation file for Stell22.

Business domain: ERP/MES for **rack/shelving manufacturing (производство стеллажей)**.
Do not import Woodveri door-manufacturing entities or workflows.

## Source-of-truth rule

1. GitHub `main`: current code and committed audit documents.
2. `../PROJECT.md`: current owner decisions, package/deploy/activation status and next step.
3. This file: audit structure/status.
4. Library `/Projects/Stell22`: cross-chat snapshot/cache.
5. Chat/Cursor transcript: working evidence only.

If a Library/chat/Cursor result conflicts with GitHub `main`, GitHub wins after factual verification.

## Audit constitution

Primary rule file:

`audit/00-audit-principles.md`

Audit loop:

`find -> prove -> classify -> record -> continue audit`

Do not automatically patch every finding. Group confirmed findings into remediation packages after a logical audit section.

## Main existing audit control files

- `audit/00-audit-backlog.md`
- `audit/00-audit-principles.md`
- `audit/00-business-flows.md`
- `audit/00-data-model.md`
- `audit/00-invariants.md`
- `audit/00-project-map.md`
- `audit/00.5-findings.md`
- `audit/00.5-remediation-classification.md`
- `audit/00.5-security-boundaries.md`
- `audit/01-data-integrity-findings.md`
- `audit/01-data-integrity-invariants.md`
- `audit/01-data-integrity-map.md`
- `audit/01.1-p1-remediation-plan.md`
- later `audit/01.*` reviews/remediation plans
- `audit/02.*` terminal audits/remediation
- `audit/03.01-production-cost-truth-map.md`
- `audit/03.02-production-cost-flow-architecture.md`

Use the repository directory itself to establish the exact current file list; this index is navigation, not a substitute for GitHub contents.

## Cursor + ChatGPT operating protocol

Cursor is the primary repository workstation.

ChatGPT reviews Cursor evidence, finds errors/omissions, maintains architectural continuity and prepares the next Cursor task.

Every substantial Cursor result must identify BASE SHA, branch/HEAD state, changed files, evidence, checks/tests and blockers.

A Cursor/chat-only result is not canonical. Completed audit work must be written to `audit/*.md` and committed/pushed.

Every patch headed to production requires a separate final adversarial review in Cursor using **Claude**. If Claude causes code changes, rerun Claude review on the new final diff before deploy.

## Cross-chat protocol

At the start of any Stell22 audit chat:

1. read `START-HERE.md`;
2. read `PROJECT.md`;
3. read this `audit/AUDIT-INDEX.md`;
4. establish actual GitHub `main` HEAD;
5. inspect current `audit/00-*` control files;
6. inspect relevant later `01.*`, `02.*`, `03.*` docs;
7. do not restart closed work without new evidence;
8. continue from the first genuinely unfinished audit area.

## Previous reported AUDIT 1

A previous Cursor session reported:

`audit/08.01-audit-1-system-architecture.md`

but this artifact was absent from GitHub `main`, and its reported BASE SHA could not be verified.

Status:

`UNVERIFIED HISTORICAL DRAFT / NOT CANONICAL`

Do not use it as the formal continuation point.

## Current audit queue

### AUDIT 1 — SYSTEM ARCHITECTURE

Status: `NEXT / RERUN REQUIRED`

Run in Cursor from actual current `main`.
Audit only. No application-code fixes.

Expected artifact:

`audit/08.01-audit-1-system-architecture.md`

The artifact must be reviewed in ChatGPT before commit/push unless the owner explicitly changes the workflow.

### Subsequent audits

Define `08.02`, `08.03`, etc. only after AUDIT 1 establishes the system-level map and the next logical audit areas. Avoid inventing a long fixed sequence before the evidence warrants it.
