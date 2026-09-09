# Local audit recovery (STEP 0)

**Status:** `RECOVERY COMPLETE / HISTORICAL REFERENCE`  
**Canonicalization:** 2026-09-09 — this report is a historical recovery artifact, not a living findings register. After recovery, `origin/main` fast-forwarded `d9f940e` → `86992a8` (`START-HERE.md`, `PROJECT.md`, `audit/AUDIT-INDEX.md`, `.cursor/rules/audit-truth.mdc`). The four recovered `02.01` / `02.02` / `02.03` / `02.05` files remain in `/audit` and are indexed. AUDIT 1 (`08.01-audit-1-system-architecture.md`) was **not** found: `NOT PREVIOUSLY CREATED / RERUN REQUIRED`.

**Mode:** DISCOVERY / RECOVERY ONLY.  
**Date:** 2026-09-09.  
**Charter:** `.cursor/rules/audit-truth.mdc` + `audit/00-audit-principles.md`.  
**This file is the only new artifact from this pass.** No files were moved, deleted, overwritten, merged, committed, pushed, or deployed. Application code was not changed.

---

## 1. Recovery metadata

| | |
| --- | --- |
| Task | Restore locally available Stell22 audit/review/remediation documents and classify them |
| Requested canonical entrypoints | `START-HERE.md`, `PROJECT.md`, `audit/AUDIT-INDEX.md` |
| Entrypoints found | **NONE** (not in current repo, other worktrees, temp clones, Desktop/Documents/Downloads, Cursor plans, or Claude app data) |
| File contract actually used | `audit/00-audit-principles.md` + `.cursor/rules/audit-truth.mdc` (the only existing charter) |
| New AUDIT 1 created | **NO** |
| Files moved / deleted / overwritten | **NO** |
| `PROJECT.md` / `AUDIT-INDEX.md` edited | **NO** (they do not exist) |

The requested new-program files (`START-HERE.md`, `PROJECT.md`, `audit/AUDIT-INDEX.md`, `08.01-audit-1-system-architecture.md`) were **never found on this machine**. What exists is the older `audit/00*`–`audit/03*` program already in `D:\dev\St`.

---

## 2. Current repository state

```text
REPO_ROOT=D:/dev/St
BRANCH=main
HEAD=d9f940e8540801bdb27dd72210193f5e4ab038c3
       fix: enforce prisadka inventory boundary
origin/main=d9f940e8540801bdb27dd72210193f5e4ab038c3  (up to date)
WORKTREE=dirty (untracked only; no staged/modified tracked files)
```

### Worktree before this report

Dirty = **untracked files only**. Tracked files matched `HEAD`.

Untracked in `/audit`:

- `audit/02.01-torcovka-terminal-ui-review.md`
- `audit/02.02-torcovka-terminal-ui-plan.md`
- `audit/02.03-terminal-functional-ux-review.md`
- `audit/02.05-terminal-ui-commit-regression-review.md`

Untracked review artifacts at repo root (patches/zips/bundles/reports):

- `cost-freeze-delta.patch`
- `data-integrity-master-normalization-review.patch`
- `di-007-008-repro-report.txt`
- `di-007-008-review.patch`
- `di-009-review-bundle.zip` + `di-009-review-bundle/`
- `di-009-review-fix.patch`, `di-009-review-fix2.patch`, `di-009-review.patch`
- `di-014-master-close-review.patch`
- `di-014-payment-operation-unique-review.patch`
- `di-015-master-close-review.patch`
- `di-015-rate-snapshot-review.patch`
- `di-016-review.patch`
- `di-020-review-bundle.zip` + `di-020-review-bundle/`
- `di-020-review-fix.patch`
- `p1-review-bundle.zip`
- `terminal-02.04-p2-only-review.patch`
- `terminal-draft-ci-lint-fix.patch`
- `terminal-draft-persistence-review.patch`
- `terminal-final-p3-review.patch`
- `terminal-owner-decisions-review.patch`
- `terminal-pin-existing-change.patch`
- `terminal-pin-flow-review.patch`
- `terminal-ui-p2-final-review.patch`
- `terminal-ux-p2-review.patch`
- `torcovka-admin-approval-review.patch`
- `torcovka-ui-step1-review.patch`

After this pass, one additional untracked file exists: `audit/00-local-audit-recovery.md` (this report).

---

## 3. Locations scanned

Targeted recovery. **Not** a full `C:` scan. Skipped `node_modules`, `.git` working copies (except read-only `fsck`/`cat-file`), `.next`, package caches, Windows system directories.

| # | Root | Result |
| --- | --- | --- |
| 1 | `D:/dev/St` (current repo) | Canonical `audit/` + historical `docs/AUDIT-*` + untracked review patches |
| 2 | `D:/dev/St-di-015` | Linked git worktree `di-015-rate-snapshot` @ `13eacea` |
| 3 | `D:/dev/St-di-015-docs` | Linked git worktree detached @ `1af5a2a` |
| 4 | `D:/dev` siblings | Review patches + `stell22-review-archive/`; empty `_stell22*_tmp` dirs; no other Stell22 clone |
| 5 | `C:/Users/bocma/Desktop` | Empty of audit docs |
| 6 | `C:/Users/bocma/Documents` | Codex folder empty of Stell22 audit |
| 7 | `C:/Users/bocma/Downloads` | No Stell22 audit docs (noise: `*preview*` images) |
| 8 | `C:/Users/bocma/OneDrive/Рабочий стол` | `Stell22.txt` (credentials/deploy notes — **UNRELATED**, secrets not copied here); no `08.01` |
| 9 | `C:/Users/bocma/OneDrive/St`, `Stell`, `Stella`, `stellage`, `ERP-Stellage`, `ERP-NEW` | **Paths do not exist** (Cursor project names are historical) |
| 10 | `C:/Users/bocma/.cursor/plans` | July 2026 ERP audit plan; Sep 3 security-boundary plan |
| 11 | `C:/Users/bocma/.cursor/projects/d-dev-St` | Uploaded copies of the July ERP plan; agent transcripts (current recovery query only mentions `08.01`) |
| 12 | `C:/Users/bocma/AppData/Local/Temp` | `stell22-p2-base-o5019cwg` (full tree snapshot @ ~2026-09-06); empty `stell22-review-bundles`; small logs |
| 13 | `C:/Users/bocma/AppData/Roaming/Claude` | No `08.01` / `START-HERE` / `AUDIT-INDEX` |
| 14 | `C:/Users/bocma/AppData/Roaming/Cursor/User` | No matching audit markdown |
| 15 | `D:/Downloads`, `D:/Telegram Downloads` | No matching audit docs |
| 16 | `D:/dev/ERP TEST`, `D:/dev/TK` | No Stell22 `audit/` program |
| 17 | Git object DB of `D:/dev/St` | No blob/path named `08.01*`, `START-HERE.md`, `AUDIT-INDEX.md`; unreachable historical markdown blobs for existing `audit/` files |

**Count of important roots:** 17 scanned families.  
**Other Stell22 clones:** 0 independent clones. **Linked worktrees:** 2. **Temp snapshot tree:** 1.

---

## 4. Canonical repo audit inventory

All existing files under `D:/dev/St/audit/**` (39 markdown files). No subdirectories.

SHA column = first 40-char commit hash found in the file body (document BASE / HEAD / review base), not git blob hash.

| Rel path | Size | Modified | Git | Heading | Doc SHA | Stage |
| --- | ---: | --- | --- | --- | --- | --- |
| `audit/00-audit-backlog.md` | 27952 | 2026-09-04 18:07 | tracked | Этап 0: очередь глубокого аудита | — | 00 backlog |
| `audit/00-audit-principles.md` | 4491 | 2026-09-04 09:40 | tracked | Устав аудита Stell22 | — | 00 charter |
| `audit/00-business-flows.md` | 12525 | 2026-09-03 20:03 | tracked | Этап 0: бизнес-процессы и state machines | — | 00 map |
| `audit/00-data-model.md` | 17427 | 2026-09-03 20:22 | tracked | Этап 0: модель данных Prisma | — | 00 map |
| `audit/00-invariants.md` | 15531 | 2026-09-04 09:41 | tracked | Этап 0: инварианты, уже выраженные в коде | — | 00 map |
| `audit/00-project-map.md` | 21453 | 2026-09-03 20:22 | tracked | Этап 0: карта проекта и архитектуры Stell22 | `f3ebbef4…` | 00 map |
| `audit/00.5-findings.md` | 8431 | 2026-09-03 20:23 | tracked | Этап 0.5: Security Findings | `f3ebbef4…` | 00.5 |
| `audit/00.5-remediation-classification.md` | 4820 | 2026-09-03 20:40 | tracked | Этап 0.5: целевая классификация Server Actions | — | 00.5 |
| `audit/00.5-security-boundaries.md` | 24318 | 2026-09-03 20:23 | tracked | Этап 0.5: Security Boundaries | `f3ebbef4…` | 00.5 |
| `audit/01-data-integrity-findings.md` | 84728 | 2026-09-09 11:52 | tracked | Этап 1: Data Integrity findings | `4809c0cf…` | 01 register |
| `audit/01-data-integrity-invariants.md` | 13699 | 2026-09-04 16:52 | tracked | Этап 1: инварианты Data Integrity | — | 01 |
| `audit/01-data-integrity-map.md` | 21461 | 2026-09-04 16:37 | tracked | Этап 1: карта WRITE PATHS | `9b5ed66d…` | 01 |
| `audit/01.1-p1-remediation-plan.md` | 66745 | 2026-09-04 16:23 | tracked | P1 Data Integrity Remediation Plan | `5479580b…` | 01 plan |
| `audit/01.2-cost-freeze-review.md` | 32192 | 2026-09-04 16:52 | tracked | Этап 1.2: BatchCost freeze / recalc | `9b5ed66d…` | 01 review |
| `audit/01.3-cost-freeze-remediation-plan.md` | 27235 | 2026-09-04 18:07 | tracked | Cost-Freeze Remediation Plan | `9b5ed66d…` | 01 plan |
| `audit/01.4-torcovka-input-safety-review.md` | 53274 | 2026-09-04 18:56 | tracked | Этап 1.4: TORCOVKA input safety | `cc571f50…` | 01 review |
| `audit/01.5-torcovka-input-safety-remediation-plan.md` | 29173 | 2026-09-04 20:36 | tracked | TORCOVKA Input Safety Remediation Plan (DI-020) | `cc571f50…` | 01 plan |
| `audit/01.6-inventory-provenance-review.md` | 69139 | 2026-09-05 09:40 | tracked | Этап 01.6: Inventory / provenance (DI-009) | `931efe87…` | 01 review |
| `audit/01.7-inventory-integrity-remediation-plan.md` | 43505 | 2026-09-05 09:40 | tracked | Inventory Integrity Remediation Plan (DI-009) | `931efe87…` | 01 plan |
| `audit/01.8-inventory-draft-uniqueness-review.md` | 61341 | 2026-09-05 15:50 | tracked | Этап 01.8: DI-016 DRAFT uniqueness | `1f411e5e…` | 01 review |
| `audit/01.9-inventory-draft-uniqueness-remediation-plan.md` | 64344 | 2026-09-05 16:14 | tracked | Этап 01.9: DI-016 remediation | `1f411e5e…` | 01 plan |
| `audit/01.10-terminal-idempotency-review.md` | 38587 | 2026-09-05 17:53 | tracked | Этап 01.10: DI-007 / DI-008 | `16015d5e…` | 01 review |
| `audit/01.11-terminal-draft-persistence-review.md` | 41609 | 2026-09-05 17:53 | tracked | Этап 01.11: Terminal draft persistence | `16015d5e…` | 01 review |
| `audit/01.12-terminal-draft-persistence-remediation-plan.md` | 18320 | 2026-09-05 19:36 | tracked | Этап 01.12: draft persistence plan | `16015d5e…` | 01 plan |
| `audit/01.13-terminal-idempotency-remediation-plan.md` | 35419 | 2026-09-05 18:56 | tracked | Этап 01.13: DI-007 / DI-008 plan | `16015d5e…` | 01 plan |
| `audit/01.14-torcovka-admin-approval-review.md` | 28903 | 2026-09-05 22:03 | tracked | Этап 01.14: TORCOVKA EXTREME admin approval | `327b4ae6…` | 01 review |
| `audit/01.15-torcovka-admin-approval-remediation-plan.md` | 27647 | 2026-09-05 22:38 | tracked | Этап 01.15: TORCOVKA admin approval plan | `4db2c96e…` | 01 plan |
| `audit/01.18-payment-operation-uniqueness-review.md` | 30550 | 2026-09-06 00:01 | tracked | Этап 01.18: DI-014 | `8240f4d6…` | 01 review |
| `audit/01.19-payroll-rate-snapshot-review.md` | 37692 | 2026-09-06 20:11 | tracked | Этап 01.19: DI-015 | `4809c0cf…` | 01 review |
| `audit/01.20-payroll-rate-snapshot-remediation-plan.md` | 23945 | 2026-09-06 20:11 | tracked | Payroll rate snapshot — remediation plan (DI-015) | `4809c0cf…` | 01 plan |
| `audit/02.01-torcovka-terminal-ui-review.md` | 24204 | 2026-09-09 11:52 | **untracked** | Этап 02.01: TORCOVKA terminal UI | `4809c0cf…` | 02 review |
| `audit/02.02-torcovka-terminal-ui-plan.md` | 22068 | 2026-09-09 11:52 | **untracked** | Этап 02.02: TORCOVKA terminal UI plan | `4809c0cf…` | 02 plan |
| `audit/02.03-terminal-functional-ux-review.md` | 39772 | 2026-09-09 11:52 | **untracked** | Этап 02.03: Terminal functional UX | `06e9e273…` | 02 review |
| `audit/02.04-terminal-functional-ux-remediation-plan.md` | 9352 | 2026-09-07 08:52 | tracked | Этап 02.04: Terminal P2 UX plan | `06e9e273…` | 02 plan |
| `audit/02.05-terminal-ui-commit-regression-review.md` | 24471 | 2026-09-09 11:52 | **untracked** | Этап 02.05: Terminal UI committed-regression | `06e9e273…` | 02 review |
| `audit/02.06-terminal-owner-decisions-plan.md` | 6990 | 2026-09-07 15:42 | tracked | 02.06 — Terminal owner decisions | `50469508…` | 02 plan |
| `audit/02.07-terminal-final-p3-review.md` | 6122 | 2026-09-07 16:21 | tracked | 02.07 — Terminal final P3 UX review | `f738c572…` | 02 review |
| `audit/03.01-production-cost-truth-map.md` | 49551 | 2026-09-07 19:44 | tracked | 03.01 Production cost truth map | `1bf91090…` | 03 map |
| `audit/03.02-production-cost-flow-architecture.md` | 57397 | 2026-09-08 20:23 | tracked | 03.02 Production cost flow architecture | `1bf91090…` | 03 architecture |

**Tracked:** 35. **Untracked in `/audit`:** 4.  
**Missing numbers in the 01.xx series:** `01.16`, `01.17` (never present in this repo or git history).

All listed document SHAs exist locally (`git cat-file -e <sha>^{commit}` succeeded for the hashes checked in §8).

---

## 5. Audit-like files inside repo but outside `/audit`

### 5.1 Historical audit documents (tracked)

| Path | Size | Git | Heading | Classification |
| --- | ---: | --- | --- | --- |
| `docs/AUDIT-ERP-2026-07-12.md` | 23124 | tracked | Аудит ERP Stell22 — итоговый отчёт | HISTORICAL |
| `docs/AUDIT-FIX-CHECKLIST.md` | 18987 | tracked | План работ по аудиту (2026-07-12) | HISTORICAL |

July 2026 audit @ commit `5268259` (exists locally). Uses v2 as source of truth — **superseded** by `audit/00-audit-principles.md` (2026-09-04). Checklist A1–A23 is marked done.

### 5.2 Review patches / bundles (untracked, repo root)

These are review-round artifacts, not the living register. Classification: **HISTORICAL** / **NEEDS REVIEW** before any copy into `/audit`.

Same filenames also appear in git stash `stash@{0}` untracked commit `b8e3ffe`.

### 5.3 Application / test files named *audit* / *integrity* (not audit documents)

`src/server/audit.ts`, `src/server/integrity/*`, `src/server/internal/inventory-integrity.ts`, `scripts/audit-cost-freeze-readonly.sh`, `vitest.integrity.config.ts`.

Classification: **UNRELATED** as audit documents (they are product code / tests). Do not move into `/audit`.

### 5.4 Copies inside `di-009-review-bundle/current/audit/`

- `01.6-inventory-provenance-review.md` — byte-identical to canonical `audit/01.6-…` (size 69139)
- `01.7-inventory-integrity-remediation-plan.md` — **older** (40454 vs canonical 43505)

---

## 6. External / local audit candidates

### 6.1 Linked worktrees (same git repo, older checkouts)

| Worktree | HEAD | Audit files | Notes |
| --- | --- | --- | --- |
| `D:/dev/St-di-015` | `13eacea` `di-015-rate-snapshot` | 31 md (no `02.*` / `03.*`) | Almost all `00*`/`01*` files are **CRLF duplicates** of current `D:/dev/St` (same text after `\r\n`→`\n`). Exceptions: `01-data-integrity-findings.md` is a **real older content**. `01.19`/`01.20` match current after newline-normalize. Untracked: `di-015-rate-snapshot-review.patch` |
| `D:/dev/St-di-015-docs` | `1af5a2a` detached | 31 md | `01-data-integrity-findings.md` **same hash as current St**. Other files CRLF copies. No `02.*`/`03.*` |

### 6.2 Temp snapshot (not a worktree)

`C:/Users/bocma/AppData/Local/Temp/stell22-p2-base-o5019cwg/` — full project tree dated 2026-09-06 21:38. Audit dir matches `St-di-015-docs` (CRLF copies + same findings as current). Also contains `docs/AUDIT-ERP-2026-07-12.md` / `AUDIT-FIX-CHECKLIST.md`.

Empty dirs: `D:/dev/_stell22_review_tmp`, `D:/dev/_stell22-tmp-review-bundles`, `D:/dev/_st-review-bundles-tmp`, `C:/Users/bocma/AppData/Local/Temp/stell22-review-bundles`.

### 6.3 Parent directory review patches (not in current repo)

| Path | Size | Modified | Classification |
| --- | ---: | --- | --- |
| `D:/dev/stell22-package1-foundation-review.patch` | 90506 | 2026-09-07 21:17 | HISTORICAL |
| `D:/dev/stell22-package1-foundation-review-v2.patch` | 105754 | 2026-09-07 21:36 | HISTORICAL |
| `D:/dev/stell22-package1-final-delta.patch` | 59275 | 2026-09-09 11:52 | HISTORICAL |
| `D:/dev/stell22-package2-torcovka-review.patch` | 92616 | 2026-09-07 23:18 | HISTORICAL |
| `D:/dev/stell22-package2-review-fixes.patch` | 78555 | 2026-09-08 12:05 | HISTORICAL |
| `D:/dev/stell22-package3-downstream-review.patch` | 214135 | 2026-09-08 20:28 | HISTORICAL |
| `D:/dev/stell22-package3.1-inventory-boundary-review.patch` | 8760 | 2026-09-08 21:50 | HISTORICAL |
| `D:/dev/torcovka-ui-before-main-sync.patch` | 25825 | 2026-09-06 20:11 | HISTORICAL |
| `D:/dev/stell22-review-archive/cost-freeze-review-bundle.zip` | 43153 | 2026-09-06 20:12 | HISTORICAL |

### 6.4 Cursor plans / uploads

| Path | Size | Classification |
| --- | ---: | --- |
| `C:/Users/bocma/.cursor/plans/erp_audit_report_79f324a7.plan.md` | 32858 | HISTORICAL (July 2026; source of `docs/AUDIT-ERP-2026-07-12.md`) |
| `C:/Users/bocma/.cursor/projects/d-dev-St/uploads/erp_audit_report_79f324a7.plan-L1-L239-0.md` | 32848 | DUPLICATE of plan |
| `C:/Users/bocma/.cursor/plans/security-boundary-remediation_5588ad06.plan.md` | 7409 | HISTORICAL (00.5 follow-up) |

### 6.5 UNRELATED but name-matched

| Path | Classification |
| --- | --- |
| `C:/Users/bocma/OneDrive/Рабочий стол/Stell22.txt` | UNRELATED — deploy host notes / credentials. **Do not copy into `/audit`.** |
| Cursor MCP `*audit*.json`, icon `*architecture*`, WordPress `*preview*` | UNRELATED |

---

## 7. Duplicate / version groups

### GROUP 1 — Этап 0 / 00.5 / most 01.* across worktrees + temp

Canonical repo version: `D:/dev/St/audit/<name>` (LF).

Other versions: `D:/dev/St-di-015/audit/<name>`, `D:/dev/St-di-015-docs/audit/<name>`, `…/Temp/stell22-p2-base-o5019cwg/audit/<name>`.

Relationship: **exact duplicate after newline normalization** (worktrees stored CRLF). Byte hashes differ; text does not.

Important differences: line endings only.

Recommended canonical candidate: `D:/dev/St/audit/<name>` (already tracked on `main`).

Not moved.

### GROUP 2 — `01-data-integrity-findings.md`

Canonical repo version: `D:/dev/St/audit/01-data-integrity-findings.md` (84728 bytes, hash `c87ebb0081a85ac9`, last commit `1af5a2a`).

Other versions:

- `D:/dev/St-di-015-docs/audit/01-data-integrity-findings.md` — **exact duplicate**
- temp clone — **exact duplicate**
- `D:/dev/St-di-015/audit/01-data-integrity-findings.md` — **older** (82021 bytes). `git diff 13eacea origin/main -- audit/01-data-integrity-findings.md` = +67 / −21 (DI-015 close / production status). Unreachable blob `0d238698…` is an even older heading snapshot @ `9b5ed66`.

Relationship: older vs newer; not conflicting conclusions — later commit closed DI-015 in the register.

Recommended canonical candidate: `D:/dev/St/audit/01-data-integrity-findings.md`.

### GROUP 3 — `02.01-torcovka-terminal-ui-review.md`

Canonical repo version: `D:/dev/St/audit/02.01-torcovka-terminal-ui-review.md` (untracked, CRLF, 24204).

Other versions: git stash untracked `b8e3ffe:audit/02.01-…` (LF, 23835).

Relationship: **exact duplicate after newline normalization** (369 CR bytes = 369 lines).

Recommended canonical candidate: working-tree file in `/audit` (already in the right folder; needs `git add` later, not this pass).

### GROUP 4 — `02.02-torcovka-terminal-ui-plan.md`

Same as GROUP 3: stash LF vs working-tree CRLF, **newline-identical**.

### GROUP 5 — `03.02-production-cost-flow-architecture.md` drafts in git object DB

Canonical repo version: `D:/dev/St/audit/03.02-production-cost-flow-architecture.md` (57397 bytes = `HEAD` blob `1f6b8dbb…`).

Other versions: unreachable blobs sized 50696, 50722, 52404, 56098, 56252, 56874 (all start with the same heading / `ARCHITECTURE ONLY`).

Relationship: **older drafts** left by resets (`reflog` shows many `reset: moving to HEAD` on 2026-09-08 during Package 3). Not in any branch tip.

Recommended canonical candidate: current tracked file on `main`.

### GROUP 6 — July 2026 ERP audit report

Canonical (historical) repo version: `docs/AUDIT-ERP-2026-07-12.md`.

Other versions: Cursor plan `erp_audit_report_79f324a7.plan.md` + two uploads under `.cursor/projects/d-dev-St/uploads/`. Same commit `5268259`, same title.

Relationship: plan/export vs checked-in copy. Treat repo `docs/` as the saved historical copy.

### GROUP 7 — DI-009 bundle copies of 01.6 / 01.7

Canonical: `audit/01.6-…`, `audit/01.7-…`.

Other: `di-009-review-bundle/current/audit/`. 01.6 exact duplicate; 01.7 older (40454 vs 43505).

### GROUP 8 — Cost-freeze bundle copy of 01.3

`D:/dev/stell22-review-archive/…/audit-01.3-cost-freeze-remediation-plan.md` (27742) vs canonical 27235. Likely CRLF or review-round copy. Canonical remains `audit/01.3-…`.

**Duplicate groups counted:** 8.  
**Conflicting groups (incompatible current conclusions):** **0**.

---

## 8. Recovered AUDIT 1 information

**Target:** `AUDIT 1 — SYSTEM ARCHITECTURE`, especially `08.01-audit-1-system-architecture.md`.

| Field | Result |
| --- | --- |
| File found | **NO** |
| Absolute path | NONE |
| Modified / size | N/A |
| BASE SHA inside file | NONE |
| Branch recorded | NONE |
| Findings IDs | NONE |
| P0/P1/P2/P3 | NONE |
| Status / conclusion | N/A |
| Ever inside this Git repo | **NO** — `git log --all --full-history -- '*08.01*' '*system-architecture*' '*AUDIT-INDEX*' '*START-HERE.md'` empty; `git rev-list --all --objects` has no such path; `git log -S '08.01-audit-1-system-architecture'` empty |
| `git log --all -- <path>` | N/A (path never existed) |
| BASE SHA exists locally | N/A (no SHA to test from that document) |
| Clone/worktree | Not present in `St`, `St-di-015`, `St-di-015-docs`, or temp snapshot |

Closest **existing** architecture-like documents (these are **not** AUDIT 1):

| Path | What it is |
| --- | --- |
| `audit/00-project-map.md` | Этап 0 system map @ `f3ebbef4`, 2026-09-03 |
| `audit/03.02-production-cost-flow-architecture.md` | Production **cost-flow** architecture (Package 3), not whole-system AUDIT 1. Snapshot SHA `1bf91090`. Package 3 review BASE `77ee6af9`. Both exist locally and are on `origin/main` |
| `docs/AUDIT-ERP-2026-07-12.md` | July 2026 whole-product audit with an architecture mermaid; historical |

`03.02` owner decisions: BD-COST-NEW-01…05 closed; unresolved owner decisions **NONE**. That document must not be renamed into `08.01` without an explicit new-program decision.

---

## 9. Local git / reflog / worktree findings

### Branches

`git branch -a` shows `main` plus many local `feat/*`, `fix/a*`, `docs/a17-defer`, `test/audit-pure-cores`, `di-015-rate-snapshot`.

Every local branch is **0 commits ahead of `origin/main`** (they are behind). No unpublished unique branch tips.

### Worktrees

```text
D:/dev/St              d9f940e [main]
D:/dev/St-di-015       13eacea [di-015-rate-snapshot]
D:/dev/St-di-015-docs  1af5a2a (detached HEAD)
```

`13eacea` and `1af5a2a` are ancestors of `origin/main`. Docs worktree commit message: `docs: close DI-015 in production`.

### Reflog (relevant)

- 2026-09-08: multiple `reset: moving to HEAD` during cost-flow / Package 3 — explains unreachable `03.02` draft blobs.
- 2026-09-06 20:11: `stash` created `torcovka-ui-before-di015-main-sync`, then `pull --ff-only origin main`.

### Stash (read-only)

```text
stash@{0}: On main: torcovka-ui-before-di015-main-sync
```

Tracked hunk: `audit/01-data-integrity-findings.md` + torcovka UI components.  
Untracked commit `b8e3ffe` contains 02.01/02.02 and many review bundles (same family as current untracked root files). **No `08.01`.**

### Local-only commits

| ID | Kind |
| --- | --- |
| `6146387`, `b0dff2b`, `b8e3ffe` | stash commits (`git log --all --not --remotes`) |
| `a34539eb` | dangling commit `feat: вход в терминал по одному PIN…` (2026-09-03) — application, not audit |

### Unreachable audit blobs

`git fsck --unreachable --no-reflogs` (read-only) found markdown blobs for existing audit titles (`01-data-integrity-findings`, `01.13`, `01.15`, `01.19`, `01.20`, `02.06`, `03.02`, `DI-020` plan). These are leftover drafts from resets/stash, not a lost AUDIT 1 file.

### Document SHAs vs object database

Checked and **present locally** (also on current history unless noted):

`d9f940e`, `77ee6af9`, `1bf91090`, `4809c0cf`, `060629ea`, `1af5a2a`, `13eacea`, `9b5ed66`, `f3ebbef4`, `5268259`.

There is **no** “GitHub-missing BASE SHA from AUDIT 1” to recover, because the AUDIT 1 file was not found.

---

## 10. Missing expected artifacts

| Expected | Status |
| --- | --- |
| `START-HERE.md` | MISSING everywhere scanned |
| `PROJECT.md` | MISSING |
| `audit/AUDIT-INDEX.md` | MISSING |
| `08.01-audit-1-system-architecture.md` | MISSING |
| New-program AUDIT 1 findings register | MISSING |
| `audit/01.16*`, `audit/01.17*` | Never existed in this repo |
| Independent second Stell22 clone with extra audit | NOT FOUND |

---

## 11. Conflicting documents

No pair of **current** documents asserts incompatible closed findings for the same ID.

Tension to record (not a merge conflict):

- July 2026 `docs/AUDIT-ERP-*` treats v2 as calculation source of truth.
- September 2026 `audit/00-audit-principles.md` forbids treating v2 drift as an automatic bug.
- `audit/00-project-map.md` HEAD snapshot is `f3ebbef4` (2026-09-03), far behind current `d9f940e`.
- `03.01` / `03.02` snapshot SHA `1bf91090` is also behind current HEAD (expected: frozen architecture snapshot).

Worktree `St-di-015` findings file is simply **older**, not a rival register.

---

## 12. Recommended consolidation plan

Do **not** execute in this pass. For ChatGPT / owner:

1. Keep `D:/dev/St/audit/` on `main` @ `d9f940e` as the living September 2026 audit tree.
2. Create the missing new-program files (`START-HERE.md`, `PROJECT.md`, `audit/AUDIT-INDEX.md`) only after the owner confirms the new numbering scheme. **Do not** invent AUDIT 1 by renaming `00-project-map.md` or `03.02`.
3. Track the four untracked `02.01` / `02.02` / `02.03` / `02.05` files already sitting in `/audit`.
4. Leave root `*.patch` / `*-review-bundle*` and `D:/dev/stell22-*.patch` as historical review debris; do not merge them into markdown.
5. Keep `docs/AUDIT-ERP-2026-07-12.md` + checklist as **historical** (July). Point AUDIT-INDEX at them as superseded.
6. Ignore worktree/temp CRLF copies; they are the same git content.
7. Do not copy `Stell22.txt` or any credential file into `audit/`.
8. Optional later: `git stash show` / drop only after 02.01–02.02 are committed, so the stash is not the only backup of those untracked docs.

---

## 13. Files that should probably move into `/audit`

Already in `/audit` (only need to be tracked later):

- `audit/02.01-torcovka-terminal-ui-review.md`
- `audit/02.02-torcovka-terminal-ui-plan.md`
- `audit/02.03-terminal-functional-ux-review.md`
- `audit/02.05-terminal-ui-commit-regression-review.md`

Nothing external needs a physical move to recover content. Worktree copies are inferior (CRLF / older).

---

## 14. Files that should probably remain historical

- `docs/AUDIT-ERP-2026-07-12.md`
- `docs/AUDIT-FIX-CHECKLIST.md`
- All repo-root and `D:/dev` `*review*.patch` / `*-review-bundle*`
- Cursor `erp_audit_report_*.plan.md` and uploads
- `stell22-review-archive/`
- Temp `stell22-p2-base-o5019cwg`
- Unreachable git blobs / stash, once living `/audit` files are committed
- July 2026 architecture section inside `docs/AUDIT-ERP-*` (do not treat as AUDIT 1)

---

## 15. Open questions

1. Were `START-HERE.md` / `PROJECT.md` / `AUDIT-INDEX.md` / `08.01-…` only ever in a ChatGPT conversation and never written to disk on this PC?
2. Should the new audit program be an **index over the existing `audit/00*`–`03*` tree**, or a separate numbering that starts at AUDIT 1 from scratch?
3. If AUDIT 1 must be redone: is the intended BASE `d9f940e` (current `origin/main`), or an older SHA named in ChatGPT that we still do not have as a filename?
4. Should untracked `02.01`–`02.05` be committed to `main` as part of canonicalization, or left untracked until the new index exists?
5. Is `03.02` in-scope as “architecture” for the new AUDIT 1, or must AUDIT 1 be whole-system (auth, terminal, warehouse, payroll, cost) and therefore new work?
6. `00-project-map.md` is stale vs HEAD — refresh as AUDIT 0 map, or freeze as historical snapshot @ `f3ebbef4`?

---

## Appendix A — What was already really done (living tree)

Not a new audit. Snapshot of the recovered September program:

| Band | Status on disk |
| --- | --- |
| 00 maps + charter + backlog | Present, tracked |
| 00.5 security | Present, tracked |
| 01 Data Integrity DI-001…DI-021 | Register present. Closed in production except DI-011/DI-017 **DEFERRED BY OWNER**, DI-012 **DESIGN RISK** |
| 01.2–01.20 reviews/plans | Present (01.16/01.17 never existed) |
| 02 terminal UX | 02.04/02.06/02.07 tracked; 02.01/02.02/02.03/02.05 present but untracked |
| 03 production cost | 03.01 truth map + 03.02 cost-flow architecture tracked; code landed through Package 3.1 on `d9f940e` |
| AUDIT 1 system architecture (new program) | **Not found** |

## Appendix B — Candidate table (compact)

IDs below are recovery IDs, not finding IDs.

| ID | Absolute path | Inside current repo? | Git tracked? | Classification |
| -- | --- | --- | --- | --- |
| R001–R039 | `D:/dev/St/audit/*.md` (see §4) | YES | 35 yes / 4 no | CANONICAL (untracked 02.01/02.02/02.03/02.05 = CANONICAL-CANDIDATE) |
| R040–R041 | `D:/dev/St/docs/AUDIT-ERP-2026-07-12.md`, `AUDIT-FIX-CHECKLIST.md` | YES | YES | HISTORICAL |
| R042+ | `D:/dev/St/*.patch`, `*-review-bundle*` | YES | NO | HISTORICAL |
| W1 | `D:/dev/St-di-015/audit/*` | NO (linked worktree) | at that HEAD | DUPLICATE (CRLF) / OLDER VERSION (findings) |
| W2 | `D:/dev/St-di-015-docs/audit/*` | NO (linked worktree) | at that HEAD | DUPLICATE (CRLF) |
| T1 | `C:/Users/bocma/AppData/Local/Temp/stell22-p2-base-o5019cwg/audit/*` | NO | N/A | DUPLICATE |
| P1–P8 | `D:/dev/stell22-package*.patch` etc. | NO | N/A | HISTORICAL |
| C1 | Cursor `erp_audit_report_*.plan.md` | NO | N/A | HISTORICAL / DUPLICATE of R040 |
| X1 | `C:/Users/bocma/OneDrive/Рабочий стол/Stell22.txt` | NO | N/A | UNRELATED |

This report does not move any of the above.
