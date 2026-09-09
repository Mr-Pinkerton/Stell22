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

## Mandatory audit file discipline

All persistent audit artifacts must live under:

`<repo>/audit/`

The only canonical project-control files outside `audit/` are:

- `START-HERE.md`
- `PROJECT.md`

Do not keep canonical audit/review/remediation/findings documents in the repo root, `.cursor/`, sibling folders, Downloads/Documents/Desktop, temporary folders or arbitrary Cursor workspaces.

Whenever an audit document is created, completed, renamed, moved, superseded, or changes status, **this `audit/AUDIT-INDEX.md` must be updated in the same working cycle**.

An audit task is not DONE if its artifact exists but this index does not reflect the current path/status.

Before committing audit work, verify:

- all persistent audit artifacts are under `audit/`;
- there are no newly-created audit documents outside `audit/`;
- this index is synchronized;
- internal links point to existing canonical paths.

Cursor/chat-only output or an unindexed local file is `UNVERIFIED / NOT CANONICAL`.

The always-on Cursor rule is `.cursor/rules/audit-truth.mdc`.

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

A Cursor/chat-only result is not canonical. Completed audit work must be written to `audit/*.md`, indexed here, then committed/pushed.

Every patch headed to production requires a separate final adversarial review in Cursor using **Claude**. If Claude causes code changes, rerun Claude review on the new final diff before deploy.

## Local audit recovery status

Status: `REQUIRED BEFORE AUDIT 1 RERUN`

Reason:

Previous Cursor sessions may have created Stell22 audit documents outside the repository or outside `<repo>/audit/` on the local PC. GitHub therefore cannot be assumed to contain the complete historical audit corpus.

Recovery procedure:

1. Cursor scans the accessible local PC for Stell22 audit/review/remediation/findings documents.
2. Produce a factual inventory with absolute paths, modified times, sizes, titles and probable canonical relationship.
3. Do not delete, overwrite or move external files during discovery.
4. Compare recovered files with current `<repo>/audit/` contents.
5. Classify each recovered file: `CANONICAL-CANDIDATE`, `DUPLICATE`, `OLDER VERSION`, `CONFLICTING VERSION`, `UNRELATED`.
6. ChatGPT reviews the inventory.
7. Only after review, consolidate approved material into `<repo>/audit/`.
8. Update this index with every recovered canonical artifact and status.

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

`UNVERIFIED HISTORICAL DRAFT / POSSIBLY LOCAL`

Do not discard it and do not rerun it yet. First perform the local recovery scan described above. If the original file is recovered, compare and review it before deciding whether AUDIT 1 must be rerun.

## Current audit queue

### STEP 0 — LOCAL AUDIT RECOVERY

Status: `NEXT`

Find and inventory all historical Stell22 audit artifacts on the local PC. No application-code changes. No deletion. No commit/push until ChatGPT reviews the recovery inventory.

### AUDIT 1 — SYSTEM ARCHITECTURE

Status: `BLOCKED BY LOCAL RECOVERY`

Expected canonical artifact if a rerun is ultimately required:

`audit/08.01-audit-1-system-architecture.md`

Do not rerun until recovered local audit artifacts have been inventoried and reviewed.

### Subsequent audits

Define `08.02`, `08.03`, etc. only after recovery and AUDIT 1 status are resolved. Avoid inventing a long fixed sequence before the evidence warrants it.
