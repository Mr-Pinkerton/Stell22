# Stell22 — Project Journal / Source of Truth

Updated: 2026-10-16

This file answers three questions:

1. what is already decided/done;
2. where the project is now;
3. what happens next.

Statuses: `ACCEPTED`, `IMPLEMENTED`, `TESTED`, `PLANNED`, `BLOCKED`, `OPEN`, `UNVERIFIED`.

## 1. Domain

`ACCEPTED`

Stell22 is an internal ERP/MES for **rack/shelving manufacturing (производство стеллажей)**.

It is a separate domain from Woodveri door manufacturing. Do not import door-specific entities, routes, WIP assumptions, nomenclature, or business rules unless explicitly requested by the owner.

## 2. Product goal

Stell22 should connect the real production flow:

`order -> production -> employee output -> inventory/WIP -> purchases/batches -> cost -> finished goods -> shipment -> money`

The system is not only a status tracker. Production facts must remain reconcilable with material movement, payroll/output, inventory and cost accounting.

## 3. Canonical source hierarchy

1. GitHub `main`: current code + committed audit documents. **This is canonical truth.**
2. This `PROJECT.md`: owner decisions, package/deploy/activation status and current next step — **on `main`**.
3. `audit/AUDIT-INDEX.md`: audit navigation/status.
4. `/Projects/Stell22` Library snapshot: cross-chat recovery/cache.
5. Chat/Cursor transcripts: working evidence only.

If sources conflict, verify the actual GitHub `main` and record the divergence.

A Cursor/chat statement without a committed project artifact is not canonical.

Release checkpoint, 2026-10-24: PR #110 merged as `473c01175df4b334a65a104b3a519e3b34c06234` (tree `cad87d4c3ceeb9739e2106066a0b4b903c7fb0ff`). An independent audit revoked production release authorization. Checkout must keep the server bytes of `scripts/backup-db.sh` and `scripts/restore-db.sh` without `git stash`. Enum ownership is a post-release migration prerequisite, not a P1 blocker. The role transaction and pinned P1 checksum are unchanged. Corrective branch `fix/psr-p3-protected-checkout-r1`. Production release remains **NO-GO**. The sequence is `audit/08.62-psr-p3-release-integration.md`.

## 4. Current verified technical checkpoint

Repository: `Mr-Pinkerton/Stell22`

Branch: `main`

Last verified production application SHA:

`678cbc1d308ddfe568b901ebf53f7e05f9a8c014`

Evidence: Production Deploy `37816537899` SUCCESS (2026-10-08, `workflow_dispatch`). GitHub `main` at the start of `audit/08.27` is `8cb61c8322f68a6a4e4f5997ed966a5b1996513f` (PR #56 pin alignment) and is **not** a new production application SHA. Verified GitHub `main` baseline before the PSR-P3 Slice 1 documentation closeout (PR #61): `df21c3c2a8e943c509ad52c2f70e13066fefe6de` (merge of PR #60). That baseline is **not** a production application deploy. Current PSR-P2 status is `audit/08.27` (**COMPLETE / ALL ENABLED PHYSICAL WRITERS COVERED / SHADOW GATE ACTIVE / REAL DUAL-WRITE OBSERVED / POST-START READ-ONLY VERIFIED**). Ledger **NOT AUTHORITATIVE**. `AUTHORITATIVE_COUNT` = **0**. Final epoch **NOT CREATED**. `OPENING_BALANCE` **NOT CREATED**. `production_cost_flow` **INACTIVE / ABSENT**. PSR-P3 Slice 1 is `audit/08.29` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). Batch receipt discovery `audit/08.30` is **DISCOVERY ACCEPTED / MERGED TO MAIN / POST-MERGE CI VERIFIED / NO IMPLEMENTATION**. Verified GitHub `main` baseline before this status sync: `055dd86743a99ec31518b298d03c286c04d9beb6` (merge of PR #62). That baseline is **not** a production application deploy. Option A is conditional. Option B is an accepted architectural direction only and is not implemented. Architecture contract `audit/08.31` is **ARCHITECTURE ACCEPTED / MERGED TO MAIN / POST-MERGE CI VERIFIED / NOT IMPLEMENTED**. Verified GitHub `main` baseline before this architecture status sync: `d8fa4b017ef9deb9c102c38b72848e48993cf78a` (merge of PR #64). That baseline is **not** a production application deploy. Architecture acceptance is not operational warehouse readiness. Architecture is **ACCEPTED / CANONICAL**. Readiness gate `audit/08.32` remains **ACCEPTED / CANONICAL**. Verified GitHub `main` baseline before this implementation-gate status sync: `25abcde4f221483e2bc20fe03f4ce3a244f93d61` (merge of PR #66). That baseline is **not** a production application deploy. P1 is `audit/08.33` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). Verified GitHub `main` baseline before this P1 closeout: `1b4cfcc5968e31264cfca7371edbc9ce9f236999` (merge of PR #68). That baseline is **not** a production application deploy. P1 production schema migration is **NOT AUTHORIZED / NOT EXECUTED**. P2 is `audit/08.34` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). Verified GitHub `main` baseline before this P2 closeout: `e6110fa142e977b71d58ab898328c39610bf73b1` (merge of PR #70). That baseline is **not** a production application deploy. P2 production deploy is **NOT AUTHORIZED**. P3 is `audit/08.35` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). P3 production deploy is **NOT AUTHORIZED**. Verified GitHub `main` baseline before this P3 closeout: `592375843bab6cd82fe86f62db0ae9b15dcae9bf` (merge of PR #72). That baseline is **not** a production application deploy. Verified GitHub `main` baseline before this readiness assessment: `03121e730ca6afab7751adda10ba69af0ec3fc3e` (merge of PR #73). That baseline is **not** a production application deploy. Production readiness is **NOT YET PROVEN** (`audit/08.36`). Production application is **UNCHANGED**. Invariant A is implemented for Slice 1's three contours and for batch receipt (`audit/08.35`). That is not every physical writer. Invariant B is **NOT_EVALUABLE**. PSR-P3 is **PARTIAL / NOT COMPLETE**. Paper removal **NOT AUTHORIZED**. `SOAK_COMPLETE` = **NO**. `INC-001` remains **OPEN**. `ARCH-P1-001` remains **OPEN / CONFIRMED**. Writer coverage implementation from `audit/08.24` remains connected **12** / deployed **12** / uncovered **0**. That coverage does not prove each contour was exercised in production. SOAK-04 (`37827499555`) snapshot: `SHADOW_COUNT` = **195**, `PRODUCTION_OPS_DISTINCT` = **23**, `SHADOW_GATE_ACTIVATED` = **YES**, `AUTHORITATIVE_COUNT` = **0**, `SOAK_COMPLETE` = **NO**. Gate continuity between snapshots is not claimed. Prior production application `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf` (Production Deploy `35616829882`) is historical; `audit/08.24`, `audit/08.25`, and `audit/08.26` are not rewritten. Journal entries below keep the status of their own closeout.

Prior documented production application SHA:

`b033cfad88f01d9231f7b892fcce290244f48130` — Production Deploy `35536089109` SUCCESS (2026-09-20). Package 2 quantity-edit identity **DEPLOYED / POST-DEPLOY VERIFIED**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`4508ee1c5d242e679f18e331c35efc679e37c10c` — Production Deploy `35524416936` SUCCESS (2026-09-20). Package 1 safe destructive guards **DEPLOYED / POST-DEPLOY VERIFIED**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`69e0f53993d5b02f27f0fc03682cef492c02d685` — Production Deploy `35510094974` SUCCESS (2026-09-20). Raw SHADOW writers **DEPLOYED DORMANT / SHADOW INACTIVE**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`0cc8382f307ac1ff7fa881012033f5105e689a23` — Production Deploy `35502770382` SUCCESS (2026-09-20). Raw identity prerequisite **DEPLOYED / POST-DEPLOY VERIFIED**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`eb02b17f488ef9ec13a11dcf158fc169b78e3e37` — Production Deploy `35337215903` SUCCESS (2026-09-18). R-06 Inventory physical identity **DEPLOYED / POST-DEPLOY VERIFIED**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`27538a5d5777d33fb87d060963a6d07a189cf044` — Production Deploy `35329071777` SUCCESS (2026-09-18). R-05 TORCOVKA correction identity **DEPLOYED**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`c14a58641d57dfabfce223b2c213db9c86167ca4` — Production Deploy `35314440036` SUCCESS (2026-09-18). R-04 Supply cycle identity **DEPLOYED**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`de2e1c015423e7b848f0583c0e75b2abb12733d9` — Production Deploy `35257469956` SUCCESS (2026-09-17). PSR-P2 general preconditions (`PSR-Q-004` / R-07 / R-10 / R-11) **DEPLOYED DORMANT**. **Historical.** Do not rewrite.

Prior documented production application SHA:

`92532e818df41160b434caac2c6d94933e93d810` — `Merge pull request #7 from Mr-Pinkerton/feat/psr-p1-inventory-movement-shadow-schema`. Production Deploy `35228794988` SUCCESS (2026-09-17). PSR-P1 empty SHADOW schema. **Historical.** Do not rewrite.

That deploy includes:

- PSR-P1 empty `InventoryMovement` SHADOW schema (`20260917150000_psr_p1_inventory_movement_shadow`); production row count at that P1 deploy = **0**;
- OPS-CORR-01 Production Traceability v1 (PR #3);
- INC-001 generic TORCOVKA-delete containment (`3608b36`, still in effect);
- UI filter work;
- TORCOVKA BlankStock length canonicalization and railsTaken correction hardening (PR #1).

PSR-P1 closeout = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY**. Row count **0** and no runtime `InventoryMovement` writers are that P1 closeout's facts. Current runtime evidence is `audit/08.27` (SOAK-04 snapshot `SHADOW_COUNT` = **195**, gate **ACTIVE**; continuity not claimed). `PSR-Q-004` / R-07 / R-10 / R-11 package closeout is **DEPLOYED DORMANT** (`audit/08.07`). R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.08`; Production Deploy `35314440036`). R-05 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.09`; Production Deploy `35329071777`). R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`; Production Deploy `35337215903`). Those earlier deploys are not the current PSR-P2 status. Current PSR-P2 status is `audit/08.27`.

Prior documented production application SHA:

`0686d0036da52cc32aaff531c91f1dd2ded899ec` — `Merge pull request #3 from Mr-Pinkerton/feat/ops-corr-01-traceability-v1`. Production Deploy `35204366279` SUCCESS (2026-09-17). **Historical.** Do not rewrite.

Earlier documented production application SHA:

`71a01b40008cf6da7cbc843b3b0dbaa31cf01853` — `Merge pull request #1 from Mr-Pinkerton/integration/p2025-di020`. Production Deploy `34635510843` SUCCESS (2026-09-11). **Historical.** Do not rewrite.

Earlier documented prod SHA (containment-only):

`3608b36bd324a5118f4ba5b1bbb21462cc0723d9` — `fix: block generic torcovka delete`

Earlier pre-incident application checkpoint:

`d9f940e8540801bdb27dd72210193f5e4ab038c3` — `fix: enforce prisadka inventory boundary`

Cost-flow / activation state at the current checkpoint:

- Cost flow Package 2/3: committed / **deployed dormant**;
- `production_cost_flow` **INACTIVE**;
- bootstrap not applied;
- business money initialization not performed;
- activation remains **BLOCKED** (`ARCH-P1-001` OPEN on the ACTIVE path);
- Close Month: **NOT IMPLEMENTED**.

Always establish current HEAD before starting new work.

## 5. Current work mode

`ACTIVE MODE: PSR-P2 COMPLETE / PSR-P3 PARTIAL`. PSR-P2 artifact: `audit/08.27`. PSR-P3 Slice 1 artifact: `audit/08.29` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). Production application is `678cbc1d308ddfe568b901ebf53f7e05f9a8c014` (Production Deploy `37816537899`). Verified GitHub `main` baseline before the PSR-P3 Slice 1 documentation closeout (PR #61): `df21c3c2a8e943c509ad52c2f70e13066fefe6de`. That baseline is **not** a production application deploy. Ledger **NOT AUTHORITATIVE**. `AUTHORITATIVE_COUNT` = **0**. Final epoch **NOT CREATED**. `OPENING_BALANCE` **NOT CREATED**. `production_cost_flow` **INACTIVE / ABSENT**. Invariant A is implemented for R-05, batch remainder write-off, and SimplePurchase. Invariant B is **NOT_EVALUABLE**. PSR-P3 is **PARTIAL / NOT COMPLETE**. Paper removal **NOT AUTHORIZED**. `SOAK_COMPLETE` = **NO**. `INC-001` **OPEN**. `ARCH-P1-001` **OPEN**. Discovery `audit/08.30` is **COMPLETE / ACCEPTED**. Option B's writer is `audit/08.34` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). Architecture `audit/08.31` is **ACCEPTED / CANONICAL**. Readiness gate `audit/08.32` remains **ACCEPTED / CANONICAL**. P1 is `audit/08.33` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). P1 production schema migration is **NOT AUTHORIZED / NOT EXECUTED**. P2 production deploy is **NOT AUTHORIZED**. P3 is `audit/08.35` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). P3 production deploy is **NOT AUTHORIZED**. Production application is **UNCHANGED**. **NEXT = PSR-P3-S2-B-ROLLOUT-GATE-RESOLUTION-01 — Resolve the deployment blocker and the missing production evidence**. Rollout readiness is `audit/08.36` (**CANDIDATE / NOT READY / EVIDENCE INCOMPLETE**). It does not authorize a migration or a deploy. This NEXT is a package name only. It does not authorize a production migration, a deploy, production access, paper removal, or `production_cost_flow`.

`audit/08.37` is **HEAD ACCEPTED AS BOUNDED PROTOTYPE / MERGED TO MAIN / POST-MERGE CI VERIFIED / NOT DEPLOYED / NO PRODUCTION AUTHORIZATION**. PR #77 merged at `2026-10-11T18:16:20Z`. Accepted head `7b3925621ff62dbbace56a3268d0bc044229db56`. Merge `3b9e9ac90f26a3eef4a381acc4d388deee5e0522`, tree `452e6fbf05dbf8df3027474b82920a6b65ff7638`, parents `741d6b221b791345c7653d53ef571addf22f5be3` then `7b3925621ff62dbbace56a3268d0bc044229db56`. Accepted PR CI `38162494962` **SUCCESS**. Post-merge CI `38163111879` **SUCCESS**: verify `114539987865`, disposable restore drill `114539987764`, unit tests **1207 PASS**, integrity tests **564 PASS**, and TypeScript, Lint, security checks, and Build **PASS**. The public CLI does not connect to PostgreSQL and does not spawn Prisma. The live identity probe is **NOT IMPLEMENTED**. The executor depends on injected callbacks. Real disposable runner operation is **NOT VERIFIED**. Old-application integration is **NOT EXECUTED**. The CI restore drill is not that old-application test. Discovery 01B-03-R1 is recorded as HEAD accepted, and Option A is the isolated Prisma runner direction. This merge does not authorize a production migration, a deploy, production access, paper removal, or `production_cost_flow`. Production history remains **UNVERIFIED**. `audit/08.36` is not rewritten and remains **NOT READY**. The NEXT in the paragraph above is unchanged.

`audit/08.38` is **IMPLEMENTED IN MAIN / LIVE DISPOSABLE POSTGRESQL 17 VERIFIED / POST-MERGE CI VERIFIED / PUBLIC APPLY DISABLED / NOT DEPLOYED / NO PRODUCTION AUTHORIZATION**. PR #79 merged at `2026-10-12T10:16:00Z`. Accepted feature HEAD `249447d39e1c9863b17e9093d4fb06b499ee9a9a`, tree `bc3d8966f05d6636e8f9a580136bc4eb21370d8b`. Merge `31d9cd515ed28be90b2c27077cd60778855ba82f`, same tree, parents `d0bc967eb481b9f5bd075cadb4c721764447641a` then `249447d39e1c9863b17e9093d4fb06b499ee9a9a`. Five paths, **+2666 / −1**. Accepted PR CI `38232286012` **SUCCESS**, event `pull_request`, checkout `0763f418b12d782143a6c12848ad1f2c2170a8c3`: verify `114754409162`, disposable restore drill `114754409290`. The dedicated live step passed **5 / 0 skipped**: four fixture-provenance tests and one PostgreSQL 17 integration test. Post-merge CI `38235240319` **SUCCESS**, event `push`, checkout `31d9cd515ed28be90b2c27077cd60778855ba82f`: verify `114764175504`, disposable restore drill `114764175891`, unit tests **1242 passed / 1 skipped**, integrity tests **564 passed**. The dedicated live step was **skipped** on that push, which is the pull-request-only condition, not a failed test. Injected tests are not that live run. The integrity suite and restore drill are not an isolated P1 `prisma migrate deploy`. Container origin remains **NOT_ESTABLISHED**. Full target authentication remains **NOT_CLAIMED**. `applyEnabled` remains `false`. Public CLI apply remains `LIVE_DISPOSABLE_PROBE_NOT_IMPLEMENTED`. `audit/08.37` is not rewritten. `audit/08.36` is not rewritten and remains **NOT READY / EVIDENCE INCOMPLETE**. P1 production migration remains **NOT AUTHORIZED / NOT EXECUTED**. P2 and P3 production deploy remain **NOT AUTHORIZED**. Production application remains `678cbc1d308ddfe568b901ebf53f7e05f9a8c014` (Production Deploy `37816537899`). The NEXT in the paragraph above is unchanged. Independently proven container-origin authentication, isolated P1 migration execution, historical application compatibility, and production authorization are **NOT COMPLETED**.

PR #86 is **MERGED / POST-MERGE CI VERIFIED / NOT DEPLOYED**. Merge `5c4bd2d4b8dc40fd90fab1746d3ca7c3371e9dc5` at `2026-10-14T17:14:39Z`, tree `c2846e1bead973855adc028cadc355c825981574`, parents `05fd1335f9dc176ebe2e10f89f960b657b4d5386` then `bca4e85b3d19b02f05b86e26f8612f12a13a493a`. Post-merge CI `38604993915` **SUCCESS**, event `push`, head `5c4bd2d4b8dc40fd90fab1746d3ca7c3371e9dc5`. That merge is the fail-closed owned SQL binding. It does not deploy the application and does not authorize a production migration.

`audit/08.39` is **READ-ONLY PRE-APPLY GATE MERGED / POST-MERGE CI VERIFIED / NOT DEPLOYED / NO EXECUTION AUTHORIZATION**. PR #87 merged at `2026-10-14T17:53:51Z`. Accepted head `17c8684ff78c82852d09bbf6ec8d56b61a18eaa7`. Implementation `ad4a7cdf30633d965797faccb3419fdf44b524ba`, tree `1358f8fa69bef0833c7fce72294c2e4f6470b62c`, parent `5c4bd2d4b8dc40fd90fab1746d3ca7c3371e9dc5`. Merge `0379b59de28465653b64fa98a6313af74dfcfa35`, tree `02710dd5a55286e8476534db14a906de3b7c57a2`, parents `5c4bd2d4b8dc40fd90fab1746d3ca7c3371e9dc5` then `17c8684ff78c82852d09bbf6ec8d56b61a18eaa7`. PR CI `38609904804` **SUCCESS**. Post-merge CI `38610550791` **SUCCESS**. The gate calls the owned SQL binding and returns a diagnostic. `READY_FOR_DISPOSABLE_APPLY` does not authorize Prisma. `ALREADY_APPLIED` does not authorize another run. Injected SQL is not live PostgreSQL readiness. `containerOrigin` remains **NOT_ESTABLISHED**. `fullTargetAuthentication` remains **NOT_CLAIMED**. `applyEnabled` remains `false`. Public CLI apply remains `LIVE_DISPOSABLE_PROBE_NOT_IMPLEMENTED`. The local fixture read is not `prisma migrate deploy`. Production authentication is **NOT COMPLETE**. Production rollout is **NOT READY**. `audit/08.36` is not rewritten and remains **NOT READY / EVIDENCE INCOMPLETE**. `audit/08.37` and `audit/08.38` are not rewritten. P1 production migration remains **NOT AUTHORIZED / NOT EXECUTED**. P2 and P3 production deploy remain **NOT AUTHORIZED**. PSR-P3 remains **PARTIAL / NOT COMPLETE**. The ledger remains **NOT AUTHORITATIVE**. Invariant B remains **NOT_EVALUABLE**. The NEXT in the paragraph above is unchanged. This merge does not authorize a production migration, a deploy, production access, paper removal, or `production_cost_flow`.

`audit/08.40` is **DISPOSABLE MIGRATION OBSERVED / MERGED / POST-MERGE CI VERIFIED / NOT DEPLOYED / NO PRODUCTION AUTHORIZATION**. PR #88 merged at `2026-10-14T18:40:13Z`. Merge `39055ebaed0fb097730c567cde75de2dc66b20dd`, tree `a2bde68477a59ef50429ae5f48507b23c480426b`, parents `0379b59de28465653b64fa98a6313af74dfcfa35` then `ac5d31141e02839807ca0587a4721a4042ce6a67`. PR CI `38615759557` **SUCCESS**. Post-merge CI `38617113655` **SUCCESS**. It records one PostgreSQL 17 run on a new test-owned container. Historical migrations came from git commit `678cbc1d308ddfe568b901ebf53f7e05f9a8c014` and were applied with Prisma. The read-only gate then returned `diagnostic-ready` / `P1_ABSENT` and did not authorize the spawn. The existing executor then ran `prisma migrate deploy` once from the pinned git bytes. A fresh read was `ALREADY_APPLIED` / `P1_APPLIED`: 46 successful migration rows, the pinned P1 checksum, a nullable JSONB column without a default, the pinned CHECK, function, and enabled trigger. A second executor call did not spawn. The owned container was removed. Injected tests and the older fixture DDL are not that run. Production migration was **NOT EXECUTED**. Public apply stays disabled. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. The NEXT in the paragraph above is unchanged.

`audit/08.41` is a **HISTORICAL APPLICATION COMPATIBILITY CANDIDATE / NOT MERGED / NOT DEPLOYED**. It records one later run of the historical application from commit `678cbc1d308ddfe568b901ebf53f7e05f9a8c014` on a new disposable PostgreSQL 17 database after the same 45 migrations and one pinned P1 apply. The historical `createBatch`, its replay, and `updateBatch` ran. SQL showed one batch, one `BatchCreationCommand`, and `receiptProvenanceSnapshot` as SQL NULL. The public compatibility function still refuses a general call. Production migration was **NOT EXECUTED**. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. The NEXT in the paragraph above is unchanged.

Owner decision on 2026-10-20: during critical work the physical access terminal is disconnected. The trusted maintenance operator may perform controlled work. Other write channels still have to be checked. APPLY and UNFREEZE each need their own later Owner decision. The protocol draft is `audit/08.55` (**DRAFT / NOT APPROVED AS PRODUCTION EXECUTION RUNBOOK / NOT VERIFIED IN PRODUCTION / NO OWNER EXECUTION APPROVAL / PRODUCTION RELEASE NO-GO**). HEAD accepted that R1 text as a documentation candidate. PR #104 is **OPEN** and is not merged. **HEAD ACCEPTED DOCUMENTATION CANDIDATE. PRODUCTION EXECUTION NOT APPROVED.** Physical disconnection is **NOT VERIFIED**. Writer exclusion is **NOT VERIFIED**. Design D is **NOT ACCEPTED**. Role split is **NOT AUTHORIZED**. P1-3 is **NOT IMPLEMENTED**. P1 APPLY is **NOT AUTHORIZED**. This paragraph does not change the production application SHA, the NEXT line, or any earlier closeout.

Later navigation, 2026-10-20: PR #104 merged as `b9aff3e9bdb92ce5e2af4ccb5101e484ec6b0af5`. Post-merge CI `39446970971` SUCCESS. `audit/08.55` is not rewritten and still says that PR is open. `audit/08.56` records one disposable offline-admission run. Gate **FREEZE_PASS_FORBIDDEN**. A transaction opened before the declaration committed afterwards. Synthetic HTTP rejection is not Server Action coverage and is not production writer exclusion. Physical disconnection remains **NOT VERIFIED**. Design D remains **NOT ACCEPTED**. Role split remains **NOT AUTHORIZED**. P1-3 remains **NOT IMPLEMENTED**. P1 APPLY remains **NOT AUTHORIZED**. Production release remains **NO-GO**. This paragraph does not change the production application SHA, the NEXT line, or any earlier closeout.

R1 on PR #105, still 2026-10-20: the pull_request-only disposable live step now includes `admission.live.test.ts`. The FREEZE verdict stays **FREEZE_PASS_FORBIDDEN**. `containerGone` is no longer every non-zero inspect. This paragraph does not change the production application SHA, the NEXT line, or any earlier closeout.

`audit/08.25` remains the control-plane closeout and still records **SHADOW INACTIVE** and dual-write **NOT STARTED** at that date. `audit/08.26` remains the Environment ref-policy closeout and still records **SHADOW INACTIVE** at that date. Neither file is rewritten. Current runtime status is only `audit/08.27`.


AUDIT 1 (system architecture) remains `COMPLETE / REVIEWED`. **Do not change AUDIT 1 status. Do not reopen AUDIT 1.**

`AUDIT 2 — FINANCE & MONEY INTEGRITY` is **NOT STARTED**. It remains `NEXT AFTER INC-001`. ARCH-2 does **not** silently start AUDIT 2.

INC-001 remains `OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION`. Containment is still in the running production tree (first deployed at `3608b36`; still present on current application `678cbc1d308ddfe568b901ebf53f7e05f9a8c014`). Do not treat ARCH-2 / PSR-P0-CORR as a production-data fix. Do not automatically invert INV-047 (generic TORCOVKA delete returning rails).

**ARCH-2 / Primary-System Readiness** (`audit/08.02-primary-system-readiness-architecture.md`): **`ACCEPTED / REVIEWED`**.

Independent Review #1 = REQUEST CHANGES (R1…R6 **CLOSED / PASS**). Independent Review #2 = REQUEST CHANGES (R7…R8 **CLOSED / PASS**). Independent Review #3 = **PASS / ACCEPT**. New blockers = 0.

`ACCEPTED / REVIEWED` means the **architecture contract** is accepted. It does **not** mean PSR implementation complete, primary-system readiness achieved, ledger deployed, paper removable, or `production_cost_flow` active.

PSR-P0-CORR (`audit/08.03-psr-p0-correction-history-contract.md`): **ACCEPTED DESIGN / NOT IMPLEMENTED**. Target = `ProductionOperationMutation` (CommandExecution not used for this contour). Schema **not** implemented. Correction Center **not** implemented. Cancellation **DEFERRED / NOT IMPLEMENTED**.

PSR-P0-CORE = **ACCEPTED DESIGN / NOT IMPLEMENTED** (`audit/08.04`; canonical through the reviewed docs merge). Closes remaining PRE-SCHEMA questions. Canonical design; **not** runtime implementation.

PSR-P1 schema contract = **ACCEPTED DESIGN** (`audit/08.05`; historical contract-creation status **ACCEPTED DESIGN / NOT IMPLEMENTED** is preserved in that file). Independent Review #1 = **PASS WITH NON-BLOCKING FINDINGS** (P0=0, P1=0). PSR-P1 closeout implementation/deploy = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`). At that closeout the SHADOW table was empty and unused; row count **0** is the P1 closeout fact only. Current runtime evidence is `audit/08.27`: SOAK-04 snapshot `SHADOW_COUNT` = **195** and observed gate **ACTIVE**. Gate continuity between snapshots is not claimed. Writer coverage implementation is **12 / 12**. That does not prove each contour was exercised in production.

`PSR-Q-001` / `PSR-Q-002` / `PSR-Q-005` / `PSR-Q-007` / `PSR-Q-008` = **CLOSED / ACCEPTED**.

`PSR-DESIGN-001` / `PSR-DESIGN-002` = **CLOSED / ACCEPTED**.

NEXT = **PSR-P3-S2-B-ROLLOUT-GATE-RESOLUTION-01 — Resolve the deployment blocker and the missing production evidence**. Rollout readiness is `audit/08.36` (**CANDIDATE / NOT READY / EVIDENCE INCOMPLETE**). It does not authorize a migration or a deploy. This NEXT is a package name only. It does not authorize a production migration, a deploy, or production access. Architecture `audit/08.31` remains **ACCEPTED / CANONICAL**. Readiness gate `audit/08.32` remains **ACCEPTED / CANONICAL**. P1 is **IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED** (`audit/08.33`). P1 production schema migration is **NOT AUTHORIZED / NOT EXECUTED**. P2 is **IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED** (`audit/08.34`). P2 production deploy is **NOT AUTHORIZED**. P3 is `audit/08.35` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). P3 production deploy is **NOT AUTHORIZED**. Production application is **UNCHANGED**. Accepted architecture is not operational warehouse readiness. Discovery `audit/08.30` is **COMPLETE / ACCEPTED**. The writer is in `main` and is not deployed. The checker is in `main` and is not deployed (`audit/08.35`). P1 stored the nullable column and the database guard only. Historical reconstruction is **NO**. Production deployment is **NO**. Slice 1 remains `audit/08.29` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). It does not create a final epoch, create `OPENING_BALANCE`, make the ledger authoritative, activate `production_cost_flow`, authorize paper removal, or close `INC-001` or `ARCH-P1-001`. `SOAK_COMPLETE` stays **NO**. PSR-P3 stays **PARTIAL / NOT COMPLETE**. Package closeouts `audit/08.24`, `audit/08.25`, and `audit/08.26` keep their own historical status.

## 5.1 Temporary operational rule — TORCOVKA delete

`ACCEPTED` until an explicit erroneous-cancellation flow exists:

**`DO NOT DELETE TORCOVKA OPERATIONS`**

Reason: generic TORCOVKA delete reverses produced `BlankStock` but **intentionally does not restore** `RailLot` remaining quantity (`INC-001-F1`). That is how `ПАК-40-1280-01-7` vanished from the terminal after the incident op was deleted.

Correction of a **live** TORCOVKA must use existing correction actions (`correctTorcovkaRailsTaken`, line quantity edit), not delete.

This rule remains operational. Application containment is **deployed in production** (first at `3608b36`; still present on current application `678cbc1d308ddfe568b901ebf53f7e05f9a8c014`): the server rejects generic TORCOVKA delete before any mutation. That does **not** restore `ПАК-40-1280-01-7` and does **not** implement `cancelErroneousTorcovka`. Do not treat containment as a production-data fix. Cancellation remains deferred (`audit/08.03` §9).

`ARCH-P1-001` is unrelated to INC-001.

## 6. Cursor / ChatGPT working model

`ACCEPTED`

The owner prefers to work primarily in **Cursor**.

### Cursor

Cursor is the repository workstation. It should:

- inspect the actual checkout;
- establish branch/HEAD/clean state;
- perform audits against the repository;
- implement only approved remediation packages;
- run tests/checks;
- write/update project audit documents.

### ChatGPT

ChatGPT is the review/orchestration layer. It should:

- restore project context;
- inspect Cursor reports and evidence;
- look for errors, missing cases and contradictions;
- challenge architecture/business invariants;
- accept/reject findings and patch results;
- prepare the next precise Cursor prompt;
- maintain continuity across chats.

## 7. Mandatory Cursor evidence contract

Every substantial Cursor audit/patch response must report:

- repository and branch;
- BASE SHA before work;
- resulting HEAD SHA if committed, otherwise `NOT COMMITTED`;
- clean/dirty state;
- exact changed files;
- factual findings/change summary;
- tests/checks run and results;
- schema/migration/bootstrap/gate impact;
- deploy/activation impact;
- blockers/open questions;
- recommended next step.

For an audit, include exact code paths/evidence for material findings.

## 8. Audit completion rule

An audit section is `DONE` only when:

1. it was performed against a real identified BASE SHA;
2. results are written under `audit/*.md` in the repository;
3. the audit artifact is committed and pushed;
4. `audit/AUDIT-INDEX.md` is updated when audit structure/status changes;
5. this `PROJECT.md` is updated when owner decisions, blockers, package/deploy/activation state or next step change.

Cursor-only/chat-only output = `UNVERIFIED / NOT CANONICAL`.

## 9. Delivery / deploy gate

`ACCEPTED`

Before **every production deploy of a patch**:

1. implementation/factual review must be complete;
2. run a separate adversarial review in Cursor using **Claude**;
3. Claude reviews the final deploy candidate, not an obsolete earlier diff;
4. if Claude requests any code change, apply it and repeat Claude review;
5. deploy is allowed only after final Claude verdict `PASS / GO` or equivalent explicit no-blocker conclusion;
6. record Claude review and deploy result here.

The Claude deploy gate is not required for audit-only document work that does not deploy application code.

## 10. Current known cost-flow state

At the last verified application checkpoint:

- Cost flow Package 2: `IMPLEMENTED`;
- Cost flow Package 3: `COMMITTED / DEPLOYED DORMANT`;
- Package 3 architecture/factual review: `PASS`;
- Package 3.1 PRISADKA inventory-boundary hardening: `DEPLOYED DORMANT`;
- PRISADKA inventory-boundary blocker: `CLOSED`;
- cost-flow activation: `BLOCKED`;
- bootstrap: `NOT APPLIED`;
- business money initialization: `NO`;
- Close Month: `NOT IMPLEMENTED`.

Known remaining activation blocker (confirmed in AUDIT 1; scope refined in ARCH-2):

`ARCH-P1-001` — **OPEN / CONFIRMED**. Scope = `production_cost_flow` **ACTIVE** UPAKOVKA quantity-edit path. Activation blocker. **Not fixed.**

Current **inactive** runtime already protects `old refs ∪ current BOM refs` via `prepareUpakovkaEdit`. Do **not** say the inactive path has the same missing union check.

The unresolved finding is specifically the ACTIVE branch:

`snapshot current BOM → reverseActiveUpakovkaOperation(old refs) → apply current BOM`

without a single pre-mutation inventory boundary over old ∪ current refs.

`production_cost_flow` stays **INACTIVE**. Do not activate while this is open.

## 11. Local audit recovery

Status: `COMPLETE`

Local STEP 0 recovery (`audit/00-local-audit-recovery.md`) and STEP 0.5 canonicalization:

- `08.01-audit-1-system-architecture.md` did **not** exist on this PC (repo, worktrees, temp, Cursor folders, stash, reflog, unreachable objects). Status: `NOT PREVIOUSLY CREATED / RERUN REQUIRED`.
- 39 audit markdown files were in `/audit` before canonicalization (35 tracked; four `02.xx` untracked canonical candidates).
- The four recovered files are now part of the canonical tree: `audit/02.01-torcovka-terminal-ui-review.md`, `audit/02.02-torcovka-terminal-ui-plan.md`, `audit/02.03-terminal-functional-ux-review.md`, `audit/02.05-terminal-ui-commit-regression-review.md`.
- Conflicting current audit documents: **0**.
- Independent lost Stell22 clone: **none**.
- Historical copies, patches, and review bundles are **not** source of truth. See recovery report. Do not treat them as living findings.

## 12. AUDIT 1 — SYSTEM ARCHITECTURE

Status: `COMPLETE / REVIEWED`

Artifact: `audit/08.01-audit-1-system-architecture.md`

Repository audit base: `d1f46e46232499b61f55e754b0bd70ddc5924bca`

Application code base: `d9f940e8540801bdb27dd72210193f5e4ab038c3`

Result:

- P0 = 0
- P1 = `ARCH-P1-001`
- P2 = 0
- P3 = 0
- simplify = `ARCH-SIMPLIFY-001` (`TEMPORARY MIGRATION DEBT / REMOVE AFTER CUTOVER`)
- no new missing capabilities after adversarial review
- no unresolved owner questions from AUDIT 1
- existing known states were not reopened as new findings

### `ARCH-P1-001`

Status: `OPEN / CONFIRMED`

Scope: `production_cost_flow` **ACTIVE** UPAKOVKA quantity-edit path. Activation blocker.

Current inactive runtime already protects `old refs ∪ current BOM refs` via `prepareUpakovkaEdit`. The unresolved finding is the ACTIVE branch: snapshot current BOM → reverse old refs → apply current BOM without a single pre-mutation inventory boundary over old ∪ current refs.

Do **not** mark it fixed. Do **not** say the inactive path has the same missing union check. `production_cost_flow` stays INACTIVE. No remediation patch in this documentation cycle.

ChatGPT adversarial review of the 08.01 draft: **accepted**. Recovery had recorded that 08.01 did not previously exist; this cycle created and finalized it. `audit/03.02-production-cost-flow-architecture.md` remains cost-flow architecture only.

## 12.1 ARCH-2 — PRIMARY-SYSTEM READINESS

Status: `ACCEPTED / REVIEWED` (Review #1 R1…R6 CLOSED/PASS; Review #2 R7…R8 CLOSED/PASS; Review #3 **PASS / ACCEPT**; new blockers = 0)

Artifact (canonical on `main` after reviewed merge): `audit/08.02-primary-system-readiness-architecture.md`

Application/main BASE at ARCH-2 acceptance: `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` (**historical**; docs merge ≠ that-cycle production deploy). Current production application: see §4.

Forward-looking architecture so Stell22 can become the only warehouse/production operational source of truth. PSR namespace. **Not** a reopen of AUDIT 1. Architecture contract accepted; **not** full PSR implementation complete.

Correction-history production-correction slice of `PSR-DESIGN-001` / `PSR-Q-001`: **DECIDED / ACCEPTED** 2026-09-17 in `audit/08.03` (`ProductionOperationMutation`). Remainder + `PSR-Q-002` / `Q5` / `Q7` / `Q8` / `PSR-DESIGN-002`: **CLOSED / ACCEPTED** 2026-09-17 in `audit/08.04`. PSR-P0 = **COMPLETE / ACCEPTED** as architecture/design contract only. PSR-P1 schema contract: **ACCEPTED DESIGN** 2026-09-17 in `audit/08.05` (historical **NOT IMPLEMENTED** at contract creation preserved). PSR-P1 implementation/deploy: **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** 2026-09-17 in `audit/08.06`.

## 13. Current next step

NEXT = **PSR-P3-S2-B-ROLLOUT-GATE-RESOLUTION-01 — Resolve the deployment blocker and the missing production evidence**. Rollout readiness is `audit/08.36` (**CANDIDATE / NOT READY / EVIDENCE INCOMPLETE**). It does not authorize a migration or a deploy. This NEXT is a package name only. It does not authorize a production migration, a deploy, or production access. Architecture `audit/08.31` remains **ACCEPTED / CANONICAL**. Readiness gate `audit/08.32` remains **ACCEPTED / CANONICAL**. P1 is **IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED** (`audit/08.33`). P1 production schema migration is **NOT AUTHORIZED / NOT EXECUTED**. P2 is **IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED** (`audit/08.34`). P2 production deploy is **NOT AUTHORIZED**. P3 is `audit/08.35` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). P3 production deploy is **NOT AUTHORIZED**. Production application is **UNCHANGED**. Accepted architecture is not operational warehouse readiness. Discovery `audit/08.30` is **COMPLETE / ACCEPTED**. The writer is in `main` and is not deployed. The checker is in `main` and is not deployed (`audit/08.35`). P1 stored the nullable column and the database guard only. Historical reconstruction is **NO**. Production deployment is **NO**. Slice 1 remains `audit/08.29` (**IMPLEMENTED IN MAIN / POST-MERGE VERIFIED / NOT DEPLOYED**). It does not create a final epoch, create `OPENING_BALANCE`, make the ledger authoritative, activate `production_cost_flow`, authorize paper removal, or close `INC-001` or `ARCH-P1-001`. `SOAK_COMPLETE` stays **NO**. PSR-P3 stays **PARTIAL / NOT COMPLETE**. Package closeouts `audit/08.24`, `audit/08.25`, and `audit/08.26` keep their own historical status.

PSR-P0 = **COMPLETE / ACCEPTED** as an architecture/design contract only (`08.03` + `08.04`). Not runtime.

PSR-P1 = **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`08.06`). That closeout recorded an empty SHADOW-capable `InventoryMovement`. Current gate and row evidence are in `audit/08.27`, not in this P1 sentence.

`PSR-Q-004` / R-07 / R-10 / R-11 package closeout is **DEPLOYED DORMANT** (`audit/08.07`; Canonical? **YES**; first deployed at `de2e1c0`, run `35257469956`). That record is not the current SHADOW gate.

R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.08`; Production Deploy `35314440036`).

R-05 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED** (`audit/08.09`; production `27538a5`; Production Deploy `35329071777`). `ProductionOperationCorrection` is **LIVE** (initial row count **0**; historical backfill **NO**). Full `ProductionOperationMutation` remains later.

R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED** (`audit/08.10`; production `eb02b17`; Production Deploy `35337215903`). First-class BLANK InventoryLine. Unique `(inventoryId, refType, refId)` **LIVE**. Legacy DRAFT recreate. The R-06 closeout recorded no InventoryMovement writer. Rollback window immediately after that deploy = **PHASE A** (`audit/08.10` §12.1).

Does **not** mean dual-write, SHADOW posting, authoritative ledger, `OPENING_BALANCE` data, paper removal, `production_cost_flow` activation, or Correction Center.

This NEXT is **PSR-P3-S2-B-ROLLOUT-GATE-RESOLUTION-01 — Resolve the deployment blocker and the missing production evidence**. Rollout readiness is `audit/08.36` (**CANDIDATE / NOT READY / EVIDENCE INCOMPLETE**). It does not authorize a migration or a deploy. It does not authorize a production migration, a deploy, or production access. P1 is already in `main` and is not deployed (`audit/08.33`). P2 is already in `main` and is not deployed (`audit/08.34`). P3 is already in `main` and is not deployed (`audit/08.35`). The readiness assessment is `audit/08.36` and is not a go decision. Do not start the gate-resolution package from this file. Do not treat a Slice 1 `MATCH_OBSERVED` as proof that a warehouse projection changed, or as authority to remove paper.

Disposable release rehearsal `audit/08.60` is a test-owned command only. It does not change this NEXT. Production role split, production P1 apply, and production deploy remain **NOT AUTHORIZED**. `FREEZE_PASS_FORBIDDEN`. `PRODUCTION RELEASE NO-GO`. The rehearsal does not prove production-wide writer exclusion.

Legacy ownership transition `audit/08.61` is a disposable PostgreSQL rehearsal only. It does not change this NEXT, the production SHA, or any production authorization. Production role split, production P1 apply, and production deploy remain **NOT AUTHORIZED**. `FREEZE_PASS_FORBIDDEN`. `PRODUCTION RELEASE NO-GO`.

Do **not** implement the full `ProductionOperationMutation` schema or Correction Center in this package.

Do **not** start AUDIT 2. AUDIT 2 remains `NOT STARTED` / `NEXT AFTER INC-001`.

INC-001 remains OPEN (containment first deployed at `3608b36` and still in the running tree; physical facts still required before any production-data correction). ARCH-2 / 08.03 / 08.04 / 08.06 / 08.07 / 08.08 / 08.09 do not close it. Cancellation remains deferred.

When AUDIT 2 starts: audit-only; do not auto-patch findings; `production_cost_flow` stays inactive; activation stays `BLOCKED`.

## 14. Journal update rule

After every significant delivery action record:

- date;
- stage/package;
- BASE SHA;
- resulting commit SHA;
- key changes/decisions;
- blockers closed/open;
- tests/review status;
- Claude deploy-gate status when applicable;
- deploy status;
- activation status;
- next step.

## 15. Journal — AUDIT 1 finalization

| | |
| --- | --- |
| Date | 2026-09-09 |
| Stage | AUDIT 1 — system architecture |
| BASE | repo `d1f46e46232499b61f55e754b0bd70ddc5924bca`; app `d9f940e8540801bdb27dd72210193f5e4ab038c3` |
| Result | `COMPLETE / REVIEWED`. P0=0. P1=`ARCH-P1-001` OPEN/CONFIRMED. P2=0. P3=0. Simplify=`ARCH-SIMPLIFY-001`. |
| Blockers | `ARCH-P1-001` remains an activation blocker. `production_cost_flow` inactive. Activation `BLOCKED`. Bootstrap `NOT APPLIED`. |
| Review | ChatGPT adversarial review accepted. No application patch. |
| Claude deploy gate | not required (docs only, no deploy) |
| Deploy | **NO** |
| Activation | unchanged / `BLOCKED` |
| Next | **INC-001** (AUDIT 2 deferred until INC-001 physical facts + correction review) |

## 16. Journal — INC-001 correction design

| | |
| --- | --- |
| Date | 2026-09-09 |
| Stage | INC-001 TORCOVKA whole-package production incident |
| BASE | `b08b98b5f67f7568a18f090c54b362f01c3426ff` (worktree `fix/torcovka-production-incident`); prod app `d9f940e` |
| Result | Delete semantics verified. Downstream NONE. Employee not recoverable. Scenarios A/B designed, not implemented. Finding `INC-001-F1` P1 recorded. |
| Blockers | Physical remaining rails; whether 3843 blanks existed; employee if Scenario B. `ARCH-P1-001` unchanged. |
| Review | Correction design only. No application patch. ChatGPT reviews A vs B before prod write. |
| Claude deploy gate | not required (no deploy) |
| Deploy | **NO** |
| Activation | unchanged / `BLOCKED` |
| Next | **Physical facts → reviewed Scenario A or B.** AUDIT 2 after INC-001. |

## 17. Journal — INC-001 containment deploy

| | |
| --- | --- |
| Date | 2026-09-09 |
| Stage | INC-001 application containment |
| BASE | docs `c1cc3c628e24cbcc6ee8cd290ac361c613e49b9b`; main before `b08b98b5f67f7568a18f090c54b362f01c3426ff` |
| Result | Generic TORCOVKA delete rejected before mutation. SHA `3608b36bd324a5118f4ba5b1bbb21462cc0723d9`. |
| Reviews | ChatGPT PASS; Claude #1 PASS; smoke fix; isolated smoke/integrity PASS; Claude #2 PASS |
| Main CI | `34357390695` SUCCESS |
| Deploy | Production Deploy `34357726641` SUCCESS; health OK; running SHA `3608b36` |
| Schema / migration | NO change; `No pending migrations to apply` |
| `production_cost_flow` | unchanged / INACTIVE (ABSENT) |
| Bootstrap | NOT APPLIED |
| Production data correction | NO |
| Damaged package | `ПАК-40-1280-01-7` remaining=0 unchanged |
| Next | Physical facts → Scenario A/B. AUDIT 2 after INC-001. |

## 18. Journal — origin/main `71a01b4` production deploy

| | |
| --- | --- |
| Date | 2026-09-11 (deploy); recorded 2026-09-12 |
| Stage | Production deploy of current `origin/main` |
| SHA | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` |
| Result | Production Deploy run `34635510843` SUCCESS |
| Includes | INC-001 containment + UI filters + TORCOVKA length/railsTaken hardening (PR #1) |
| Schema / migration | no change claimed in this docs cycle |
| `production_cost_flow` | unchanged / INACTIVE |
| Bootstrap | NOT APPLIED |
| Production data correction | NO |
| INC-001 data | still not corrected |
| Next after deploy | ARCH-2 documentation (this cycle) |

## 19. Journal — ARCH-2 primary-system readiness draft

| | |
| --- | --- |
| Date | 2026-09-12 |
| Stage | ARCH-2 / Primary-System Readiness architecture draft |
| BASE | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` |
| Result | `audit/08.02-primary-system-readiness-architecture.md` created. Status `PROPOSED / INDEPENDENT REVIEW REQUIRED`. |
| Blockers | `ARCH-P1-001` OPEN / CONFIRMED (ACTIVE path). INC-001 OPEN. `production_cost_flow` INACTIVE. |
| Review | Independent adversarial review required before implementation packages |
| Claude deploy gate | not required (docs only, no deploy) |
| Deploy | **NO** |
| Activation | unchanged / `BLOCKED` |
| AUDIT 1 | unchanged `COMPLETE / REVIEWED` |
| AUDIT 2 | **NOT STARTED** |
| Next | Independent adversarial review of `audit/08.02` |

## 20. Journal — ARCH-2 Independent Review #1

| | |
| --- | --- |
| Date | 2026-09-12 |
| Stage | ARCH-2 Independent Review #1 |
| BASE branch commit | `7c1b651e63747912285a5840246c64b9a053844b` |
| Application/main | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` |
| Verdict | **REQUEST CHANGES** |
| Findings | `ARCH2-R1`…`ARCH2-R6` accepted into the draft |
| Result | Draft still `PROPOSED / INDEPENDENT REVIEW REQUIRED`. Review #2 required. ARCH-2 **not accepted**. |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| `ARCH-P1-001` | OPEN / CONFIRMED (ACTIVE path) |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Deploy / merge | **NO** |
| Canonicality | Proposed branch artifact; not main truth until reviewed merge |
| Next | **Independent Review #2** |

## 21. Journal — ARCH-2 Independent Review #2

| | |
| --- | --- |
| Date | 2026-09-12 |
| Stage | ARCH-2 Independent Review #2 |
| BASE branch commit | `3777b68f5340acc20dfa9872346b4c568f5dc886` |
| Application/main | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` |
| Verdict | **REQUEST CHANGES** |
| Findings | `ARCH2-R7` BLOCKER (final epoch before correction); `ARCH2-R8` MAJOR (pre-schema questions). R1…R6 remain CLOSED/PASS. |
| Result | Draft still `PROPOSED / INDEPENDENT REVIEW REQUIRED`. Review #3 required. ARCH-2 **not accepted**. |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| `ARCH-P1-001` | OPEN / CONFIRMED (ACTIVE path) |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Deploy / merge | **NO** |
| Canonicality | Proposed branch artifact; not main truth until reviewed merge |
| Next | **Independent Review #3** |

## 22. Journal — ARCH-2 Independent Review #3

| | |
| --- | --- |
| Date | 2026-09-12 |
| Stage | ARCH-2 Independent Review #3 |
| BASE branch commit | `7b98f79c642e37eb89e14da95839770e57ec9142` |
| Application/main | `71a01b40008cf6da7cbc843b3b0dbaa31cf01853` |
| Verdict | **PASS / ACCEPT** |
| New blockers | **0** |
| Findings | R1…R8 remain **CLOSED / PASS**. No new architecture blockers. |
| Result | ARCH-2 **`ACCEPTED / REVIEWED`**. Architecture contract accepted. **Not** implementation complete. |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| `ARCH-P1-001` | OPEN / CONFIRMED (ACTIVE path) |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Production deploy | **NO** |
| Canonicality | `audit/08.02` on `main` is the canonical ARCH-2 architecture after this reviewed merge |
| Next | **PSR-P0** (not started in that Review #3 cycle). **Historical journal.** Later current next: journal 25 / `audit/08.04`. |

## 23. Journal — origin/main `0686d00` production deploy (Traceability v1)

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | Production deploy of `origin/main` after PR #3 |
| SHA | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Result | Production Deploy run `35204366279` SUCCESS |
| Includes | OPS-CORR-01 Production Traceability v1 (who entered / createdAt); INC-001 containment still in tree |
| Schema / migration | **none** |
| `production_cost_flow` | unchanged / INACTIVE |
| Bootstrap | NOT APPLIED |
| Production data correction | NO |
| INC-001 data | still not corrected |
| Next after deploy | PSR-P0-CORR architecture contract (this cycle) |

## 24. Journal — PSR-P0-CORR correction-history contract

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P0-CORR / history-preserving correction contract |
| BASE | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Result | `audit/08.03-psr-p0-correction-history-contract.md` created. Target = `ProductionOperationMutation`. CommandExecution not used for this contour. **ACCEPTED DESIGN / NOT IMPLEMENTED.** |
| `PSR-Q-001` | **OPEN / PARTIALLY RESOLVED** (production-correction slice DECIDED / ACCEPTED) |
| `PSR-DESIGN-001` | **OPEN / PARTIALLY RESOLVED** (production-correction slice ACCEPTED) |
| PSR-P0 overall | **PARTIAL / NOT COMPLETE** |
| Still open | Q1 remainder (warehouse / inventory / payroll / other writers), `PSR-Q-002`, `Q5`, `Q7`, `Q8`; cancellation; InventoryMovement; INC-001 |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Correction Center / Cancellation | **not implemented** / cancellation **DEFERRED** |
| PSR-P1 | **NOT STARTED / BLOCKED** until Q1, Q2, Q5, Q7, Q8 fully closed |
| Deploy | **NO** |
| Next | Remaining PSR-P0 PRE-SCHEMA questions. Not InventoryMovement schema. |

## 25. Journal — PSR-P0-CORE remaining PRE-SCHEMA contracts

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P0-CORE / remaining PRE-SCHEMA contracts |
| BASE GitHub `main` | `bd82aa0e0f4785cee316d282ef55eb593aadca3b` |
| Application / production | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Result | `audit/08.04-psr-p0-core-contract.md` created. Q1 remainder, Q2, Q5, Q7, Q8 and DESIGN-001/002 **CLOSED / ACCEPTED**. **ACCEPTED DESIGN / NOT IMPLEMENTED.** |
| PSR-P0 | **COMPLETE / ACCEPTED** as architecture/design contract only |
| PSR-P1 | **NOT STARTED**. **NEXT after reviewed merge** = InventoryMovement schema in SHADOW |
| `PSR-Q-003` / `Q4` / `Q6` | unchanged later timing |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Correction Center / Cancellation | **not implemented** / cancellation **DEFERRED** |
| Deploy | **NO** |
| Next | Reviewed merge of `08.04`. Then PSR-P1 InventoryMovement schema in SHADOW. Not dual-write. Not deploy. |

## 26. Journal — PSR-P1 InventoryMovement schema contract

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P1 / InventoryMovement exact schema contract |
| BASE GitHub `main` | `b11c37df94be8aee0fb4d0e9a466182924e29fc7` |
| Application / production | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Result | `audit/08.05-psr-p1-inventory-movement-schema-contract.md` created. Exact enums/model/no-FK/partial indexes/CHECKs/snapshots frozen. **ACCEPTED DESIGN / NOT IMPLEMENTED.** |
| PSR-P0 | **COMPLETE / ACCEPTED** as architecture/design contract only (unchanged) |
| PSR-P1 schema contract | **ACCEPTED DESIGN / NOT IMPLEMENTED** |
| PSR-P1 Prisma/migration | **NOT STARTED** |
| Application / schema | unchanged |
| `production_cost_flow` | unchanged / INACTIVE |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Correction Center / Cancellation | **not implemented** / cancellation **DEFERRED** |
| Deploy | **NO** |
| Next | Reviewed merge of `08.05`. Then a separate implementation prompt: empty InventoryMovement table in SHADOW. Not dual-write. Not deploy. |

## 27. Journal — PSR-P1 Independent Review #1 schema-contract corrections

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P1 schema contract — Independent Review #1 disposition |
| BASE GitHub `main` | `b11c37df94be8aee0fb4d0e9a466182924e29fc7` |
| Application / production | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Review verdict | **PASS WITH NON-BLOCKING FINDINGS**. P0=0. P1=0. |
| Result | ChatGPT resolved schema-shaping items into `audit/08.05`: SHADOW may carry rehearsal `epochId`; AUTHORITATIVE-only opening UNIQUE indexes; reversal remains partial/multi/chain without self-FK; snapshot keys-present/null-ok; identity length + MANUAL reason CHECKs; no-money snapshot rule. R-03 proposed UNIQUE/self-FK/1:1 full reversal **rejected**. Writer items R-04…R-07/R-10/R-11 recorded as PSR-P2 preconditions. R-06 also a runtime DI finding at that review; **no new DI number allocated**. |
| PSR-P1 schema contract | **ACCEPTED DESIGN / NOT IMPLEMENTED** |
| Deploy | **NO** |
| Next | Reviewed merge of `08.05`. Then a separate implementation prompt: empty InventoryMovement table in SHADOW. Not dual-write. Not deploy. |

## 28. Journal — PSR-P1 SHADOW schema implementation and production deploy

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P1 InventoryMovement SHADOW schema — implemented and deployed empty |
| Implementation PR | #7 — `feat: add PSR-P1 inventory movement shadow schema` |
| Reviewed head | `087ed7c5b09937cacf10fe3c110465a08c14de78` |
| Merge commit / `origin/main` | `92532e818df41160b434caac2c6d94933e93d810` |
| Post-merge CI | `35227949324` SUCCESS |
| Production Deploy | `35228794988` SUCCESS (`workflow_dispatch`) |
| Previous production application | `0686d0036da52cc32aaff531c91f1dd2ded899ec` |
| Production application at this journal closeout | `92532e818df41160b434caac2c6d94933e93d810` |
| Migration | `20260917150000_psr_p1_inventory_movement_shadow` — `_prisma_migrations` 1 row; `finished_at` set; `rolled_back_at` NULL; `applied_steps_count` = 1 |
| `InventoryMovement` | EXISTS; row count = **0** |
| Catalog | 5 enums PASS; 12 CHECKs PASS; FK 0/0; Prisma + 8 partial + 5 opening UNIQUE indexes PASS |
| Health | HTTP 200 `{"status":"ok","db":"up"}` |
| Rollback | **NO** |
| Manual production mutation | **NO** |
| Result | **COMPLETE / IMPLEMENTED / DEPLOYED / SHADOW SCHEMA EMPTY** (`audit/08.06`) |
| Runtime writers | **none** |
| PSR-P2 | **NOT STARTED** |
| `production_cost_flow` | unchanged canonical delivery state / INACTIVE (no fresh live query in this closeout) |
| AUDIT 1 | COMPLETE / REVIEWED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **PSR-P2 PRE-DUAL-WRITE CONTRACT / PRECONDITIONS**. Not dual-write implementation. |

## 29. Journal — PSR-P2 general pre-dual-write preconditions (Q4 / R-07 / R-10 / R-11)

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P2 general preconditions implementation |
| BASE GitHub `main` | `394f753dd4e04ea5d2b345894041f63e70818d2d` (**historical pre-merge / work start**) |
| Production application | `92532e818df41160b434caac2c6d94933e93d810` (**unchanged**; intentionally different from current GitHub `main`) |
| Result | `audit/08.07-psr-p2-pre-dual-write-general-preconditions.md`. Architecture **CLOSED**. Implementation **VERIFIED / MERGED TO main / NOT DEPLOYED**. PR #9 **MERGED**. PR #9 implementation merge checkpoint = `3f89fffb8dc5842027420095bd3c85a07a85e284`. Post-merge CI **SUCCESS** `35250490823`. Always verify current GitHub `main` HEAD. |
| Historical packaging | Feature-branch / PR-open state (`COMMITTED ON FEATURE BRANCH / PR #9 OPEN`) is **historical**. Do not treat it as current. |
| Q4 | Setting `inventory_movement_shadow_write`; writer = SHARED TX lock; ON/OFF = same EXCLUSIVE control lock as reset via transaction-only setter + maintenance CLI; not wired into physical writers |
| R-07 | New migration `recordedAt TIMESTAMPTZ(3)`; P1 migration not rewritten; empty-table guard |
| R-10 | SHADOW-only delete; exclusive control lock first (same primitive as gate ON/OFF); causal UNIQUE unchanged |
| R-11 | CI/static append-only guard |
| Runtime `InventoryMovement` writers | **none** (except dedicated R-10 maintenance path) |
| Dual-write | **NOT STARTED** |
| Deploy | **NO** |
| Production queried | **NO** |
| `production_cost_flow` | canonical delivery state INACTIVE; live runtime NOT QUERIED |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| R-04 / R-05 / R-06 | remain OPEN |
| `PSR-Q-003` / `Q6` | remain later-timing |
| Next | **PSR-P2 GENERAL PRECONDITIONS — PRODUCTION PREFLIGHT / DEPLOYMENT DECISION**. Not dual-write. Not deploy from this file. |

## 30. Journal — PSR-P2 R-04 Supply cycle identity

| | |
| --- | --- |
| Date | 2026-09-17 |
| Stage | PSR-P2 R-04 Supply cycle-identity prerequisite |
| BASE GitHub `main` | `de2e1c015423e7b848f0583c0e75b2abb12733d9` |
| Production application | `de2e1c015423e7b848f0583c0e75b2abb12733d9` (**unchanged** this cycle) |
| Result | `audit/08.08-psr-p2-r04-supply-cycle-identity.md`. Architecture **CLOSED**. Implementation **VERIFIED / NOT DEPLOYED**. Dual-write **NOT STARTED**. No InventoryMovement writer. |
| Fields | `Supply.stockAccountingGeneration` default 0; `Supply.stockAccountingOpen` default false |
| Migration | `20260917200000_psr_p2_r04_supply_stock_accounting_cycle` |
| Ozon | cancel closes open cycle including full shortfall; same-sync cancel wins |
| WB | consume-only; DI-011 still deferred |
| Deploy | **NO** |
| Production queried | **NO** |
| `inventory_movement_shadow_write` | unwired / inactive |
| R-05 / R-06 | remain OPEN |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **R-04 DELIVERY — PR #11 MERGE / PRODUCTION PREFLIGHT / DEPLOYMENT DECISION**. Not SUPPLY SHADOW dual-write. SHADOW gate inactive. InventoryMovement writer 0. R-05 / R-06 remain OPEN. Not a deploy from this file. |

## 31. Journal — PSR-P2 R-04 production deployment

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 R-04 production deploy closeout |
| Production application | `c14a58641d57dfabfce223b2c213db9c86167ca4` |
| Evidence | Production Deploy run `35314440036` SUCCESS (`workflow_dispatch`). Deploy job `105503362569`. CI/verify `105503012164`. |
| Prior production | `de2e1c015423e7b848f0583c0e75b2abb12733d9` (**historical**) |
| Result | `audit/08.08`. R-04 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED**. Migration `20260917200000_psr_p2_r04_supply_stock_accounting_cycle` **APPLIED**. |
| Schema | `Supply.stockAccountingGeneration` integer NOT NULL DEFAULT 0; `Supply.stockAccountingOpen` boolean NOT NULL DEFAULT false; CHECKs `Supply_stockAccountingGeneration_nonnegative`, `Supply_stockAccountingOpen_generation` |
| Unique identity | unchanged `UNIQUE(marketplace, externalId, sku)` |
| InventoryMovement | 0 / 0 / 0; runtime writers **0** |
| `inventory_movement_shadow_write` | ABSENT / inactive |
| `production_cost_flow` | **INACTIVE** |
| Dual-write | **NOT STARTED** |
| P3009 recovery | **NO** |
| Rollback | **NO** |
| R-05 / R-06 | remain OPEN |
| DI-011 | **DEFERRED BY OWNER** |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **PSR-P2 R-05 CORRECTION IDENTITY — RECONNAISSANCE / CONTRACT DECISION**. Not SUPPLY SHADOW dual-write. Not an InventoryMovement writer. Not R-06. Not Correction Center. Not AUDIT 2. |

## 32. Journal — PSR-P2 R-05 correction identity

This journal is **historical** (PR #13 implementation/review). §33 records the later R-05 deploy of its own date. Current runtime status is §4 and `audit/08.27`.

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 R-05 TORCOVKA railsTaken correction identity |
| BASE GitHub `main` | `30972dd76a6e84e03bd40d5b7551f10ac89ed4f5` |
| Production application | `c14a58641d57dfabfce223b2c213db9c86167ca4` (**unchanged** this cycle) |
| Result | `audit/08.09-psr-p2-r05-correction-identity.md`. Architecture **CLOSED**. Implementation **VERIFIED / NOT DEPLOYED**. Dual-write **NOT STARTED**. No InventoryMovement writer. Not full `ProductionOperationMutation`. |
| Model | `ProductionOperationCorrection` (scalar IDs, no FK cascade). `requestId` UNIQUE. expected-old CAS. Idempotent replay. |
| Migration | `20260918120000_psr_p2_r05_production_operation_correction` (empty table, no backfill) |
| Deploy | **NO** |
| Production queried | **NO** |
| `inventory_movement_shadow_write` | ABSENT / inactive |
| R-06 | remains OPEN |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **R-05 PRODUCTION PREFLIGHT / DEPLOYMENT DECISION**. Not R-06. Not dual-write. Not Correction Center. Always verify current GitHub `main` HEAD. |

## 33. Journal — PSR-P2 R-05 production deployment

This journal does **not** rewrite §32. §32 remains the historical PR-#13 implementation/review status (**NOT DEPLOYED** at that time).

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 R-05 production deploy closeout |
| Production application | `27538a5d5777d33fb87d060963a6d07a189cf044` |
| Evidence | Production Deploy run `35329071777` SUCCESS (`workflow_dispatch`). Resolve `105548942840`. CI/verify `105548987647`. Deploy `105549637693`. Created `2026-09-18T09:21:04Z`. Completed `2026-09-18T09:27:58Z`. |
| Prior production | `c14a58641d57dfabfce223b2c213db9c86167ca4` (**historical**) |
| Result | `audit/08.09`. R-05 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED**. Migration `20260918120000_psr_p2_r05_production_operation_correction` **APPLIED**. |
| Table | `ProductionOperationCorrection` **LIVE**. Initial row count **0**. Historical backfill **NO**. No fabricated correction identities. |
| InventoryMovement | 0 / 0 / 0; runtime writers **0**. R-05 deploy did **not** start an InventoryMovement writer. |
| `inventory_movement_shadow_write` | ABSENT / inactive |
| `production_cost_flow` | **INACTIVE** |
| Dual-write | **NOT STARTED** |
| P3009 recovery | **NO** |
| Rollback | **NO** |
| R-04 | remains **DEPLOYED** |
| R-06 | **OPEN** |
| DI-011 | **DEFERRED BY OWNER** |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **PSR-P2 R-06 INVENTORY IDENTITY — RECONNAISSANCE / CONTRACT DECISION**. Not R-06 implementation. Not SHADOW activation. Not dual-write. Not an InventoryMovement writer. Not Correction Center. Not AUDIT 2. |

## 34. Journal — PSR-P2 R-06 inventory identity implementation

This journal does **not** rewrite §33. §33 remains the historical R-05 production-deploy closeout.

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 R-06 inventory physical identity implementation |
| Production application | `27538a5d5777d33fb87d060963a6d07a189cf044` (**unchanged**) |
| Result | `audit/08.10`. R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / NOT DEPLOYED**. |
| Migration | `20260918130000_psr_p2_r06_inventory_line_identity` (uniqueness only; not deployed) |
| InventoryMovement | writers **0**; dual-write **NOT STARTED**; SHADOW inactive |
| `production_cost_flow` | **INACTIVE** |
| Production access | **NO** |
| Deploy | **NO** |
| Next | **R-06 HEAD REVIEW**. Not InventoryMovement dual-write. Not Correction Center. Not AUDIT 2. |

## 35. Journal — PSR-P2 R-06 production deployment

This journal does **not** rewrite §34. §34 remains the historical R-06 implementation/review status (**NOT DEPLOYED** at that time).

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 R-06 production deploy closeout |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` |
| Evidence | Production Deploy run `35337215903` SUCCESS (`workflow_dispatch`). Resolve `105574729643`. CI/verify `105574756893`. Deploy `105575381753`. |
| Prior production | `27538a5d5777d33fb87d060963a6d07a189cf044` (**historical**) |
| Result | `audit/08.10`. R-06 = **ARCHITECTURE CLOSED / IMPLEMENTATION VERIFIED / MERGED TO main / DEPLOYED / POST-DEPLOY VERIFIED**. Migration `20260918130000_psr_p2_r06_inventory_line_identity` **APPLIED**. Index `InventoryLine_inventoryId_refType_refId_key` **LIVE**. |
| Cutover Inventory | total **1** (CONDUCTED **1**, DRAFT **0**, CLOSED **0**). InventoryLine **0**. Historical backfill **NO**. No BLANK document at cutover. |
| InventoryMovement | 0 / 0 / 0; runtime writers **0**. R-06 deploy did **not** start an InventoryMovement writer. |
| `inventory_movement_shadow_write` | ABSENT / inactive |
| `production_cost_flow` | **INACTIVE** |
| Dual-write | **NOT STARTED** |
| P3009 recovery | **NO** |
| Rollback used | **NO** |
| Rollback window | **PHASE A**. Rollback to `27538a5` currently **SAFE**. Phase B = SAFE BUT DRAFT UNUSABLE FOR CONDUCT. Phase C (first CONDUCTED R-06 BLANK inventory) = **SEMANTICALLY UNSAFE** — do not blindly rollback to `27538a5`. |
| R-05 | remains **DEPLOYED** |
| R-04 | remains **DEPLOYED** |
| AUDIT 2 | **NOT STARTED** |
| INC-001 | OPEN |
| Next | **PSR-P2 INVENTORY WRITER PREREQUISITE PACKAGE**. Not the first Inventory physical writer. Not SHADOW activation. Not dual-write. Not Correction Center. Not AUDIT 2. |

---
## PSR-P2 shadow-writer contract freeze — 2026-09-18

Accepted contract: `audit/08.11-psr-p2-shadow-writer-contract.md` (PR #17).

Starting main: `2eb4f6a6d769900481a5c3fd33a76240789d953d`.

The contract records all verified physical mutation contours and explicitly keeps blocked contours blocked. In particular: Inventory requires one global BlankStock lock set/order; Supply requires the null-product restore guard and a global Supply/ProductStock lock order; R-05 requires explicit READ COMMITTED; SimplePurchase and general production edit/delete paths require retained retry-stable mutation identity; positive-stock Batch deletion cannot bypass the future ledger.

No runtime InventoryMovement writer is introduced by this package. No SHADOW activation. No production deploy or mutation.

Current NEXT after contract acceptance was **P2-GUARD/CI**. That package is now **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED** (`audit/08.12`; PR #18). NEXT: **PSR-P2 INVENTORY WRITER PREREQUISITE PACKAGE**. Not the first physical writer.

---
## PSR-P2 P2-GUARD/CI implementation — 2026-09-18

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 P2-GUARD/CI |
| BASE GitHub `main` | `71182863c7432b9af490370a66179e060f2ed913` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Result | `audit/08.12`. Common SHADOW gateway skeleton, INSERT/gate-read/TRUNCATE guards, identity/actor/time helpers, disposable PostgreSQL CI. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**. |
| Runtime InventoryMovement writers | **0** |
| Gateway wired to physical paths | **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| PR / merge | `#18` / `643c7966a4f03670747517050031843eac1b5013` |
| Accepted implementation HEAD | `91c7e3e91f956f9fc2d4959cb83c105d4979f96d` |
| Post-merge CI | `35373616566` SUCCESS |
| Next | **PSR-P2 INVENTORY WRITER PREREQUISITE PACKAGE**. Not the first Inventory physical writer. Not dual-write. Not Correction Center. Not AUDIT 2. |

The prerequisite package is recorded in `audit/08.13`. Feature-branch journal: §36. Merge closeout: §37. **NOT DEPLOYED. INVENTORY WRITER NOT STARTED.** NEXT after merge closeout: **PSR-P2 INVENTORY SHADOW WRITER IMPLEMENTATION PACKAGE**.

## 36. Journal — PSR-P2 Inventory writer prerequisite (feature branch)

This journal does **not** rewrite §35. §35 remains the P2-GUARD/CI merge closeout. Subsequent merge closeout is §37; do not treat this table as current merge state.

| | |
| --- | --- |
| Date | 2026-09-18 |
| Stage | PSR-P2 Inventory writer prerequisite |
| BASE GitHub `main` | `6a1eeaf6ad7f39803f0ddf193e2ac232531636a9` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-inventory-writer-prereq` |
| Result | `audit/08.13`. SHADOW gate-first Inventory TX, temporary SHADOW-active fail-closed, dual-active fail-closed, global BlankStock lock plan, retained USER actor. **IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / INVENTORY WRITER NOT STARTED**. |
| Runtime InventoryMovement writers | **0** |
| `appendShadowInventoryMovements` from Inventory | **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Next | **HEAD REVIEW OF INVENTORY WRITER PREREQUISITE PR**. Not the Inventory writer. Not SHADOW activation. Not merge. Not deploy. |

## 37. Journal — PSR-P2 Inventory writer prerequisite merge closeout

This journal does **not** rewrite §36. §36 remains the feature-branch implementation record.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Inventory writer prerequisite merge closeout |
| BASE GitHub `main` | `6a1eeaf6ad7f39803f0ddf193e2ac232531636a9` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Exact accepted implementation HEAD | `1f8b1d64e7d4d7828606514f728c4603f1281244` |
| PR | `#20` |
| Merge commit | `4dfaae26471188db04d76262d9776336aada854a` |
| Accepted PR CI | `35379385996` SUCCESS |
| Post-merge CI | `35422069460` SUCCESS |
| HEAD review | **PASS** |
| Independent Opus review | **PASS** |
| Findings | **P0=0 / P1=0 / P2=5** (non-blocking; dispositioned in `audit/08.13` §10) |
| Result | `audit/08.13`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / INVENTORY WRITER NOT STARTED**. |
| Runtime InventoryMovement writers | **0** |
| `appendShadowInventoryMovements` from Inventory | **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Next | **PSR-P2 INVENTORY SHADOW WRITER IMPLEMENTATION PACKAGE**. Not started. Not SHADOW activation. Not deploy. |

The writer implementation is recorded in `audit/08.14`. Feature-branch journal: §38. Merge closeout: §39. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED.** NEXT: **PSR-P2 NORMAL TERMINAL PRODUCTION SHADOW WRITERS PACKAGE**.

## 38. Journal — PSR-P2 Inventory SHADOW writer (feature branch)

This journal does **not** rewrite §37. §37 remains the Inventory writer prerequisite merge closeout.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Inventory SHADOW writer |
| BASE GitHub `main` | `ab81d9b7094d063b3d0ef4ab6ddb117fc18aa878` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-inventory-shadow-writer` |
| Result | `audit/08.14`. First physical InventoryMovement writer for Inventory `conductInventory`. **IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | **Inventory conduct only** (not in production) |
| `appendShadowInventoryMovements` from Inventory | **YES** (feature branch) |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| Next | **HEAD REVIEW OF INVENTORY SHADOW WRITER PR**. Not merge. Not deploy. Not SHADOW activation. Not the next contour writer. |

## 39. Journal — PSR-P2 Inventory SHADOW writer merge closeout

This journal does **not** rewrite §38. §38 remains the feature-branch implementation record.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Inventory SHADOW writer merge closeout |
| BASE GitHub `main` | `ab81d9b7094d063b3d0ef4ab6ddb117fc18aa878` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Exact accepted implementation HEAD | `c58131c02484ae49897fa0259ad623af65708b9e` |
| PR | `#22` |
| Merge commit | `2fd138e2c7195b63c2e943d0f85f2b9b0050740c` |
| Accepted PR CI | `35427250317` SUCCESS |
| Post-merge CI | `35427681739` SUCCESS |
| HEAD review | **PASS** |
| Independent Opus review | **PASS — P0=0 / P1=0 / P2=4** (reviewed `28d7247`; no second Opus after W1/W4) |
| Findings | **P0=0 / P1=0 / P2=4**. W1 CLOSED. W2 accepted non-blocking. W3 accepted pre-existing/non-blocking. W4 CLOSED. |
| Result | `audit/08.14`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | **Inventory conduct only** in source/main; production writer currently live = **NO** |
| `appendShadowInventoryMovements` from Inventory | **YES** (source/main; not in production) |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Next | **PSR-P2 NORMAL TERMINAL PRODUCTION SHADOW WRITERS PACKAGE**. Not started. Not SHADOW activation. Not deploy. |

The terminal production writer implementation is recorded in `audit/08.15`. Journal: §40. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED.**

## 40. Journal — PSR-P2 terminal production SHADOW writers

This journal does **not** rewrite §39. §39 remains the Inventory SHADOW writer merge closeout.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 terminal production SHADOW writers |
| BASE GitHub `main` | `cb0a9019a739738a44399f5491bd4d00a2cd1f65` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Exact accepted implementation HEAD | `1367e306f4c5e0be77137cf005e7396bf110ae33` |
| PR | #24 |
| Merge commit | `853db69b00485f5201c2fd1046cc68b07ac69ded` |
| Exact-head CI | `35439899641` SUCCESS |
| Post-merge CI | `35440444019` SUCCESS |
| HEAD final review | **PASS** |
| Independent Opus | **SKIPPED BY OWNER COST POLICY** |
| Initial findings | **P0=0 / P1=2 / P2=1**. P1-01 CLOSED. P1-02 CLOSED. P2-01 CLOSED. |
| Result | `audit/08.15`. SHADOW writers for normal `submitTorcovka` / `submitPrisadka` / `submitUpakovka`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits in source/main; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Next | **PSR-P2 R-05 TORCOVKA CORRECTION SHADOW WRITER PACKAGE**. Not started. Not SHADOW activation. Not deploy. Not Supply. |

The R-05 correction writer merge closeout is recorded in `audit/08.16`. Journal: §42. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED.**

## 42. Journal — PSR-P2 R-05 TORCOVKA correction SHADOW writer merge closeout

This journal does **not** rewrite §41. §41 remains the historical feature-branch implementation snapshot.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 R-05 TORCOVKA correction SHADOW writer merge closeout |
| BASE GitHub `main` | `f89081f70b7522afe21694527fa22f8f778daafe` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Exact accepted implementation HEAD | `c9d3c0b62894d505987685ee399fa99c69ce3126` |
| PR | #26 |
| Merge commit | `debafdae9510acab7182e334fcfe1a5b00608e0d` |
| Exact-head CI | `35443727340` SUCCESS |
| Post-merge CI | `35444256886` SUCCESS |
| HEAD final review | **PASS** |
| Findings | **P0=0 / P1=0 / P2=0** |
| Independent Opus | **SKIPPED BY OWNER COST POLICY** |
| Result | `audit/08.16`. SHADOW writer for `correctTorcovkaRailsTaken`. Explicit READ COMMITTED. Gate-first. Retained USER actor. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 correction in source/main; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Next | **PSR-P2 SUPPLY PREREQUISITE FIX PACKAGE**. Not started. Not SHADOW activation. Not deploy. Do not start Supply from this closeout. |

## 43. Journal — PSR-P2 Supply writer prerequisite (feature branch)

This journal does **not** rewrite §42. §42 remains the R-05 correction writer merge closeout. The original feature-branch name is historical. The Result / access rows below are a **historical snapshot** after PR #28 merge and failed read-only preflight `35449877592`. Current living closeout is §44.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Supply writer prerequisite |
| BASE GitHub `main` | `f740dbcc3a0838df85ad3a83a3a061e503368a4d` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-supply-prerequisite` |
| Result | `audit/08.17`. Runtime hardening **MERGED** (PR #28 `5fe5f40`; accepted `8e92dd6`). P1-01/P1-02 **CLOSED**. Production preflight **FAILED / INCOMPLETE** (`SUPPLY-PREFLIGHT-PARSER-001`; run `35449877592`). Supply writer **BLOCKED / NOT STARTED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 correction in source/main; Supply **NOT connected**; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access | **YES — READ-ONLY** preflight attempt via run `35449877592` |
| Production mutation / deploy | **NO / NO** |
| Trusted counts / `SUPPLY_DATA_BLOCKER` | **NONE** / **UNKNOWN** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Next | Historical next at this snapshot: HEAD re-review of the Supply preflight parser-fix PR. Closed by §44. |

## 44. Journal — PSR-P2 Supply writer prerequisite closeout

This journal does **not** rewrite §43. §43 remains the historical feature-branch / failed-preflight snapshot.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Supply writer prerequisite closeout |
| BASE GitHub `main` | `eb79b261ed8c2dfe423ba9207d48e7d29e14dbd8` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `docs/psr-p2-supply-prerequisite-closeout` |
| Result | `audit/08.17` **COMPLETE**. Runtime hardening **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**. Production preflight **COMPLETE / TRUSTED**. P1-01/P1-02 **CLOSED**. `SUPPLY-PREFLIGHT-PARSER-001` **CLOSED**. P2-01 **CLOSED**. Supply writer **READY TO START / NOT STARTED**. |
| Implementation | PR #28 accepted `8e92dd62caf063914e56d4105d550fb2fe1505af`; merge `5fe5f40572ce9259c3725a93516a76f9533f07ab`; exact-head CI `35449013808`; post-merge CI `35449670249` |
| Parser fix | PR #29 accepted `7795e88d9bf250c330db3cc3b360b780a18148c5`; merge `eb79b261ed8c2dfe423ba9207d48e7d29e14dbd8`; exact-head CI `35451478137`; post-merge CI `35452147190` |
| Historical failed preflight | `35449877592` — `SUPPLY-PREFLIGHT-PARSER-001`; trusted counts **NONE** |
| Trusted preflight | `35452435411` SUCCESS on `eb79b26`. TOTAL=0 / DEDUCTED_POSITIVE=0 / SHORTFALL_ONLY=0 / OPEN_DEDUCTED_POSITIVE=0 / `SUPPLY_DATA_BLOCKER=NO` |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 correction in source/main; Supply **NOT connected**; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access | **YES — READ ONLY** |
| Production mutation / deploy | **NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Next | **PSR-P2 SUPPLY SHADOW WRITER IMPLEMENTATION PACKAGE**. Not started. Not deploy. Not SHADOW activation. Do not start Supply writer from this closeout. |

## 41. Journal — PSR-P2 R-05 TORCOVKA correction SHADOW writer (feature branch)

This journal does **not** rewrite §40. §40 remains the terminal production SHADOW writer merge closeout.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 R-05 TORCOVKA correction SHADOW writer |
| BASE GitHub `main` | `f89081f70b7522afe21694527fa22f8f778daafe` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-r05-correction-shadow-writer` |
| Result | `audit/08.16`. SHADOW writer for `correctTorcovkaRailsTaken`. Explicit READ COMMITTED. Gate-first. Retained USER actor. **IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 correction on this branch; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Next | **HEAD REVIEW OF R-05 TORCOVKA CORRECTION SHADOW WRITER PR**. Not merge. Not deploy. Not SHADOW activation. Not Supply. |

## 45. Journal — PSR-P2 Supply SHADOW writer (feature branch)

This journal does **not** rewrite §44. §44 remains the Supply prerequisite closeout.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Stage | PSR-P2 Supply SHADOW writer |
| BASE GitHub `main` | `b030086746292464414e1508c798cea2c8ff7e5a` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-supply-shadow-writer` |
| Result | `audit/08.18`. SHADOW writer for Supply ProductStock deduction and Ozon positive restore. Gate-first marketplace TX. Retained USER actor. **IMPLEMENTATION ON FEATURE BRANCH / NOT MERGED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 + Supply deduction/Ozon restore on this branch; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Next | **HEAD RE-REVIEW OF SUPPLY SHADOW WRITER PR** (historical; completed). Not merge. Not deploy. Not SHADOW activation. |

## 46. Journal — PSR-P2 Supply SHADOW writer closeout

This journal does **not** rewrite §45. §45 remains the feature-branch implementation record.

| | |
| --- | --- |
| Date | 2026-09-20 |
| Stage | PSR-P2 Supply SHADOW writer closeout |
| BASE GitHub `main` | `b030086746292464414e1508c798cea2c8ff7e5a` |
| Initial implementation HEAD | `b1787205d51b9ce60ea6859708f9c3d80a6bda43` |
| Initial HEAD review | **REQUEST CHANGES** — P0=0 / P1=1 / P2=1 |
| Correction / accepted HEAD | `2e90060d145bac9fc9eb6b2fcaef4253fbfe877b` |
| Merge | `164ffca49d5200af0b442de05c8966fc3b5c70ed` |
| Exact-head CI | `35493552025` SUCCESS |
| Post-merge CI | `35493953060` SUCCESS |
| Final HEAD review | **PASS** — P0=0 / P1=0 / P2=0; P1-01 CLOSED; P2-01 CLOSED |
| Independent Opus | **SKIPPED BY OWNER COST POLICY** |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Result | `audit/08.18`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. |
| Runtime InventoryMovement writers | Inventory conduct + three normal terminal submits + R-05 + Supply deduction/Ozon restore on `main`; production writer currently live = **NO** |
| Schema / migration | **NONE** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Next | **PSR-P2 RAW RECEIPT / WRITE-OFF IDENTITY PREREQUISITE PACKAGE** (historical; started on feature branch). Not the next writers. Not deploy. Not SHADOW activation. |

## 47. Journal — PSR-P2 raw receipt / write-off identity prerequisite

This journal does **not** rewrite §46. §46 remains the Supply writer closeout.

| | |
| --- | --- |
| Date | 2026-09-20 |
| Stage | PSR-P2 raw receipt / write-off identity prerequisite |
| BASE GitHub `main` | `ea7942464add030cbe12b7226075820bc16f70bc` |
| Production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` (**unchanged**) |
| Branch | `feat/psr-p2-raw-identity-prerequisite` |
| Result | `audit/08.19`. Retained identities for `createBatch`, `writeOffBatchRemainder`, `createSimplePurchase`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED**. PR #33 accepted head `919a427`; merge `76131ca`; exact-head CI `35499639266`; post-merge CI `35500149127`. |
| Runtime InventoryMovement writers | still 6 source contours; this package adds **0** writers; production writer currently live = **NO** |
| Schema / migration | **YES** — three empty identity tables; no FK; no backfill; no InventoryMovement change |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Next | **PSR-P2 RAW IDENTITY PREREQUISITE PRODUCTION DEPLOYMENT PACKAGE**. Not the three writers. Not deploy from this file. Not SHADOW activation. |

## 48. Journal — PSR-P2 raw identity production deploy closeout

This journal does **not** rewrite §47. §47 remains the implementation/merge closeout (**NOT DEPLOYED** at that time).

| | |
| --- | --- |
| Date | 2026-09-20 |
| Stage | PSR-P2 raw identity prerequisite production deploy |
| `origin/main` at deploy | `0cc8382f307ac1ff7fa881012033f5105e689a23` |
| Post-merge CI | `35502059086` SUCCESS |
| Previous production application | `eb02b17f488ef9ec13a11dcf158fc169b78e3e37` |
| Deployed application | `0cc8382f307ac1ff7fa881012033f5105e689a23` |
| Production Deploy | `35502770382` SUCCESS (`workflow_dispatch`) |
| Resolve job | `106057379019` SUCCESS — SHA `0cc8382` |
| Deploy CI | `106057394038` SUCCESS on `0cc8382` |
| Deploy job | `106057962791` SUCCESS |
| Standard production preflight | `PREFLIGHT OK` |
| Backup | YES (`backups/stell22_2026-09-20_09-41-23.sql.gz`) |
| Target migration | `20260920120000_psr_p2_raw_identity_prerequisite` **APPLIED** (exactly one row; `finished_at` 2026-09-20 09:46:59.862416+00; `rolled_back_at` NULL; unfinished **0**; rolled-back **0**) |
| Identity tables | LIVE. FK count **0**. Immediate row counts 0/0/0 |
| Historical backfill | **NO** |
| InventoryMovement pre/post | 0/0/0 and 0/0/0 |
| SHADOW pre/post | ABSENT / INACTIVE |
| `production_cost_flow` pre/post | ABSENT / INACTIVE |
| Supply preflight rerun | `35502680346` SUCCESS; TOTAL=0 / DEDUCTED_POSITIVE=0 / SHORTFALL_ONLY=0 / OPEN_DEDUCTED_POSITIVE=0 / `SUPPLY_DATA_BLOCKER=NO` |
| Writer modules | Inventory + normal TORCOVKA / PRISADKA / UPAKOVKA + R-05 + Supply deduct/Ozon restore = **DEPLOYED DORMANT / SHADOW INACTIVE** |
| Production dual-write | **NOT STARTED** |
| P2 | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Rollback used | **NO** |
| P3009 recovery | **NO** |
| Production mutation outside normal deployment/migration | **NO** |
| Result | `audit/08.19` **IMPLEMENTED / MERGED / DEPLOYED / POST-DEPLOY VERIFIED** |
| Next | **PSR-P2 RAW RECEIPT / WRITE-OFF SHADOW WRITERS IMPLEMENTATION PACKAGE**. Not SHADOW activation. Not dual-write. Not AUDIT 2. |

## 49. Journal — PSR-P2 raw receipt / write-off SHADOW writers

This journal does **not** rewrite §47–§48. Those remain the identity implementation and production-deploy closeouts.

| | |
| --- | --- |
| Date | 2026-09-20 |
| Stage | PSR-P2 raw receipt / write-off SHADOW writers |
| BASE GitHub `main` | `8374a0fb4499214e7da6972a82db277bf011850b` |
| Production application | `0cc8382f307ac1ff7fa881012033f5105e689a23` (**unchanged**) |
| Production Deploy | `35502770382` (**unchanged**) |
| Branch | `feat/psr-p2-raw-shadow-writers` |
| Result | `audit/08.20`. SHADOW writers for `createBatch`, `writeOffBatchRemainder`, `createSimplePurchase`. **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / NOT DEPLOYED / SHADOW NOT ACTIVATED**. PR #36 accepted head `424f119`; merge `0bf2c77`; exact-head CI `35507221861`; post-merge CI `35507868236`. HEAD review **PASS** P0=0 / P1=0 / P2=0. |
| Source/`main` contours | **9** |
| Production dormant contours | **6** |
| Schema / migration | **NO** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Independent Opus | **SKIPPED BY OWNER COST POLICY** |
| Next | **PSR-P2 RAW SHADOW WRITERS PRODUCTION DEPLOYMENT PACKAGE**. Not SHADOW activation. Not dual-write. Not AUDIT 2. |

## 50. Journal — PSR-P2 raw receipt / write-off SHADOW writers production deploy

This journal does **not** rewrite §47–§49. Those remain the identity and writer implementation / merge closeouts.

| | |
| --- | --- |
| Date | 2026-09-20 |
| Stage | PSR-P2 raw receipt / write-off SHADOW writers production deploy |
| Previous production application | `0cc8382f307ac1ff7fa881012033f5105e689a23` |
| Deployed application | `69e0f53993d5b02f27f0fc03682cef492c02d685` |
| Production Deploy | `35510094974` SUCCESS (`workflow_dispatch`) |
| Resolve job | `106076377496` SUCCESS — `69e0f53` |
| Deploy CI | `106076398215` SUCCESS |
| Deploy job | `106077017178` SUCCESS |
| Standard production preflight | `PREFLIGHT OK` |
| Backup | YES — `backups/stell22_2026-09-20_12-20-52.sql.gz` |
| `prisma migrate deploy` | `43 migrations found` / `No pending migrations to apply.` |
| New migration applied | **NO** |
| Health | PASS — `200 {"status":"ok","db":"up"}` |
| InventoryMovement pre/post | 0/0/0 |
| SHADOW pre/post | ABSENT / INACTIVE |
| `production_cost_flow` pre/post | ABSENT / INACTIVE |
| Production contours | **6 → 9** |
| Rollback used | **NO** |
| P3009 recovery | **NO** |
| Result | `audit/08.20` **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**. All nine writers **DEPLOYED DORMANT / SHADOW INACTIVE**. |
| Production dual-write | **NOT STARTED** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Independent Opus | **SKIPPED BY OWNER COST POLICY** |
| Next | **PSR-P2 REMAINING MUTATION / DESTRUCTIVE CONTOURS IDENTITY-OR-DISABLE PACKAGE**. Not SHADOW activation. Not dual-write. Not AUDIT 2. |

## 51. Journal — PSR-P2 remaining mutation / destructive discovery

This journal does **not** rewrite §47–§50. Those remain the raw identity / writer / deploy closeouts.

| | |
| --- | --- |
| Date | 2026-09-20 |
| Stage | PSR-P2 remaining mutation / destructive contours discovery |
| BASE GitHub `main` | `289979b091dab5b77b4e988ae98b94a281afdfdb` |
| Production application | `69e0f53993d5b02f27f0fc03682cef492c02d685` (**unchanged**) |
| Production Deploy | `35510094974` (**unchanged**) |
| Branch | `audit/psr-p2-remaining-mutation-destructive` |
| Result | `audit/08.21`. Exhaustive remaining physical contours A–H. Architecture candidates prepared. **AWAITING HEAD REVIEW / NO IMPLEMENTATION**. |
| Schema / migration / runtime | **NO / NO / NO** |
| SHADOW activation | **NO** |
| Dual-write | **NOT STARTED** |
| `production_cost_flow` | unchanged / INACTIVE |
| Production access / mutation / deploy | **NO / NO / NO** |
| Runtime P2 global completeness | **NOT COMPLETE** |
| P3 | **NOT STARTED** |
| Ledger authoritative | **NO** |
| Independent Opus | **SKIPPED BY OWNER COST POLICY** |
| Next | Historical next at discovery commit. Closed by §52 HEAD adjudication. |

## 52. Journal — PSR-P2 remaining contours HEAD adjudication

This journal does **not** rewrite §51. §51 remains the discovery commit.

| | |
| --- | --- |
| Date | 2026-09-20 |
| Stage | PSR-P2 remaining mutation / destructive HEAD adjudication |
| BASE discovery HEAD | `6f11e38ac972685488f88c9015119c043aee4e7d` |
| HEAD review | **REQUEST CHANGES** — P0=0 / P1=1 / P2=0. Discovery/exhaustiveness **PASS**. P1-01 = net ADJUSTMENT. |
| Result | `audit/08.21` **HEAD ARCHITECTURE ADJUDICATED / AWAITING INDEPENDENT OPUS REVIEW / NO IMPLEMENTATION**. A/B/C IDENTITY+WRITER. D/E FAIL-CLOSED DISABLE. F READY AS DISABLED. G remaining===0. H INACTIVE qty===0 / ACTIVE any-row. Package 4 NONE. |
| Schema / migration / runtime | **NO / NO / NO** |
| Independent Opus | **AWAITING** at this journal. Closed by §53. |
| Next | Historical next at HEAD-adjudication commit. Closed by §53 independent Opus PASS. |

## 53. Journal — independent Opus review of remaining P2 architecture

This journal does **not** rewrite §51 or §52. Frozen HEAD decisions are unchanged.

| | |
| --- | --- |
| Date | 2026-09-20 |
| Stage | Independent Opus review of HEAD-adjudicated `audit/08.21` |
| Reviewed exact HEAD | `a9567b6bcfb6fb5b1761aa618d33cee1cd2c60fc` |
| Reviewer / model | Claude Opus (`claude-opus-5-thinking-high`) |
| Verdict | **PASS** |
| P0 / P1 / P2 | **0 / 0 / 4** informational / documentation-sequencing only |
| Architecture changed after Opus | **NO** |
| Blockers | **NONE** |
| Result | `audit/08.21` **DISCOVERY COMPLETE / ARCHITECTURE ACCEPTED / REVIEWED / NO IMPLEMENTATION**. |
| Schema / migration / runtime | **NO / NO / NO** |
| Next | **PSR-P2 SAFE DESTRUCTIVE GUARDS IMPLEMENTATION PACKAGE**. Not started in this PR. Not SHADOW activation. |

## 08.22 addendum — Package 1 production closeout (2026-09-20)

`audit/08.22-psr-p2-safe-destructive-guards.md` records Package 1 as **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED**. `08.21` architecture is unchanged. Canonical? **YES**. HEAD review **PASS**. P0=0 / P1=0.

Historical Package 1 Production Deploy `35524416936` SUCCESS. Historical Package 1 application `4508ee1c5d242e679f18e331c35efc679e37c10c`. Previous production application `69e0f53`. Remaining enabled uncovered physical contours lacking an InventoryMovement writer = **A / B / C = 3**. Connected InventoryMovement contours remain **9**. No writer added. Schema / migration = **NO CHANGE / NO NEW MIGRATION**. SHADOW **NOT ACTIVATED**. Dual-write **NOT STARTED**. P2 **NOT COMPLETE**. P3 **NOT STARTED**.

**NEXT = PSR-P2 PRODUCTION QUANTITY-EDIT IDENTITY PREREQUISITE**. Historical 08.22 closeout NEXT. Current implementation: `audit/08.23`.

## 08.23 addendum — Package 2 production closeout (2026-09-21)

`audit/08.23-psr-p2-production-quantity-edit-identity.md` records Package 2 as **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED**. PR #42 accepted exact HEAD `e143e22b6f805c9d4d053d761b5629fa5a325d9b`. Accepted exact-head CI `35534868456` SUCCESS. Merge `b033cfad88f01d9231f7b892fcce290244f48130`. Post-merge CI `35535532806` SUCCESS. Production Deploy `35536089109` SUCCESS. Production application `b033cfad88f01d9231f7b892fcce290244f48130`. Previous production application `4508ee1c5d242e679f18e331c35efc679e37c10c`. Migration `20260920180000_psr_p2_production_quantity_edit_identity` **APPLIED**. `ProductionOperationQuantityEdit` **LIVE / EMPTY AT VERIFICATION**. Verifier PR #43 merge `6621e875fdb10b720886708c361df13a08c7a471` (**not** a production application SHA). Read-only verifier run `35592291536` **PASS**. InventoryMovement **0**. SHADOW **ABSENT**. `production_cost_flow` **ABSENT**. `08.21` architecture is unchanged. No InventoryMovement writer. Dual-write **NOT STARTED**. Package 3 **NOT STARTED**. P2 **NOT COMPLETE**. P3 **NOT STARTED**. `ARCH-P1-001` **OPEN**.

**NEXT = PSR-P2 PRODUCTION QUANTITY-EDIT SHADOW WRITERS (PACKAGE 3)**. Package 3 **NOT STARTED**. Do not implement Package 3 from this file. Do not activate SHADOW.

## 08.24 addendum — Package 3 implementation candidate (2026-09-21)

`audit/08.24-psr-p2-production-quantity-edit-shadow-writers.md` records Package 3 as a feature-branch candidate: **IMPLEMENTED / CI VERIFIED / AWAITING HEAD REVIEW / NOT MERGED / NOT DEPLOYED / SHADOW INACTIVE**. Starting `origin/main` `4c662f96b1d279e2832a4dfcf7ee7b3d9ec6a595`. Branch `psr-p2/package3-production-quantity-edit-shadow-writers`. PR [#45](https://github.com/Mr-Pinkerton/Stell22/pull/45) **OPEN**. Implementation commit `218f2f7b6ca6b77d49e893636b7d21f706babd70`. Docs closeout commit `9fba665012f3560159c0272e78124efc43c95ac5`. CI evidence class = **PR MERGE-REF CI / EXACT CANDIDATE-TREE VERIFIED**, not `exact-head CI`. PR merge-ref CI `35603658542` SUCCESS (implementation tree `1b810195` == tested merge-ref tree). PR merge-ref CI `35604292351` SUCCESS (docs tree `9b05ffc7` == tested merge-ref tree). Production application remains `b033cfad88f01d9231f7b892fcce290244f48130`. Schema / migration = **NO**. SHADOW **NOT ACTIVATED**. Production accessed = **NO**. Dual-write **NOT STARTED**. P2 **NOT COMPLETE**. P3 **NOT STARTED**. `ARCH-P1-001` **OPEN**. Do not merge or deploy from this addendum. Do not activate SHADOW.

## 08.24 addendum — Package 3 production closeout / HEAD handoff (2026-09-21)

This journal does **not** rewrite the candidate addendum above. That remains the historical feature-branch record.

`audit/08.24-psr-p2-production-quantity-edit-shadow-writers.md` now records Package 3 as **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / DEPLOYED / POST-DEPLOY VERIFIED / SHADOW INACTIVE**. PR #45 accepted exact HEAD `7f090e132267edf7e0b6251d65b93b6a3c129a2e`. Accepted candidate tree `3e8fde498c6d542d6dfc04295ede064afb73a0a5`. Final PR merge-ref CI `35612492381` SUCCESS (`fca79157`; parents `4c662f96` + `7f090e13`; tested tree `3e8fde49`). Independent Opus completed (implementation P0=0 / P1=0; initial evidence P2=1 closed by HEAD via PR comment `5762512562`). Final acceptance P0=0 / P1=0 / P2=0. Implementation merge `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf`. Post-merge CI `35615386224` SUCCESS. Production Deploy `35616829882` SUCCESS. Production application `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf`. Previous production application `b033cfad88f01d9231f7b892fcce290244f48130`. Verifier PR #46 merge `49aa1209e7815d8545b6c45f42ca0770a26a767b` (**not** a production application SHA). Post-verifier-merge CI `35619130027` SUCCESS. Read-only verifier `35619733266` SUCCESS: `PRODUCTION_APP_SHA=2d2cbcbd`, `P2_MIGRATION=APPLIED`, `P2_TABLE=EXISTS`, `P2_ROW_COUNT=0`, `P2_FK_COUNT=0`, `P2_REQUEST_ID_UNIQUE=YES`, `SHADOW_SETTING=ABSENT`, `COST_FLOW_SETTING=ABSENT`, `INVENTORY_MOVEMENT_COUNT=0`, `PACKAGE3_PRODUCTION_POST_DEPLOY_VERIFY_OK`. Schema / migration = **NO**. SHADOW **NOT ACTIVATED**. Dual-write **NOT STARTED**. Ledger **NOT AUTHORITATIVE**. Source/`main` connected contours **12**. Production dormant contours **12**. Remaining enabled uncovered contours **0**. P2 **NOT COMPLETE**. P3 **NOT STARTED**. `ARCH-P1-001` **OPEN / CONFIRMED**. Owner decision recorded at this Package 3 closeout: **CHANGE HEAD AFTER PACKAGE 3**.

Historical NEXT at the Package 3 closeout, superseded: **NEW HEAD TAKEOVER / PSR-P2 SHADOW ACTIVATION & DUAL-WRITE START READINESS REVIEW**. This is **not** authorization to activate SHADOW. Do not start PSR-P3.

## 08.25 candidate — SHADOW activation control (2026-09-21)

This journal does **not** rewrite the Package 3 closeout above. This candidate paragraph stays historical.

`audit/08.25-psr-p2-shadow-activation-control.md` recorded the control-plane rework while it was **REWORK IMPLEMENTED / AWAITING HEAD REVIEW / NOT MERGED / NOT RUN IN PRODUCTION / SHADOW INACTIVE**. Previous candidate `329c2be45dad2a9ab2e69a62e53b9e0000368c6c` is **REWORKED / SUPERSEDED / NOT ACCEPTED**. Its PR merge-ref CI `35632872580` remains historical and does not verify the accepted candidate. Starting `origin/main` `693a9f12fe52b7b6babecdf4f8b6d05e1082f7b6`. Branch `psr-p2/shadow-activation-control`. PR [#48](https://github.com/Mr-Pinkerton/Stell22/pull/48).

## 08.25 closeout — SHADOW activation control merged (2026-09-21)

`audit/08.25` now records **IMPLEMENTED / MERGED TO MAIN / CI VERIFIED / POST-MERGE VERIFIED / NOT RUN IN PRODUCTION / SHADOW INACTIVE**. Canonical?: **YES** after this docs closeout is accepted and merged. Accepted HEAD `7e58c3df7836cc46591c682496eef78b83f7d955`. Accepted tree `b5c8e5a19904006784fdc8d2018f45f1ec5cb909`. Candidate PR CI `35637791430` SUCCESS. Evidence class = **PR MERGE-REF CI / EXACT CANDIDATE-TREE VERIFIED**. Merge-ref `3ba02c69d39bdc3cdd161bd0523e76fce7c57572`. Parents `693a9f12` + `7e58c3df`. Implementation merge `231026601cdbaa0ff1a8a80411f90a33b92eaef8`. Post-merge CI `35638837175` SUCCESS. The control plane is merged and is not a separate production deploy. Production application remains `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf`. `PRODUCTION_ENVIRONMENT_REF_POLICY = UNSAFE`. Production accessed = **NO**. Production mutated = **NO**. SHADOW **NOT ACTIVATED**. `production_cost_flow` unchanged. Dual-write **NOT STARTED**. Ledger **NOT AUTHORITATIVE**. PSR-P2 **NOT COMPLETE**. PSR-P3 **NOT STARTED**. `ARCH-P1-001` **OPEN / CONFIRMED**. `INC-001` remains **OPEN — CONTAINMENT DEPLOYED; PHYSICAL FACT REQUIRED FOR DATA CORRECTION**. AUDIT 1 remains **COMPLETE / REVIEWED**. AUDIT 2 remains **NOT STARTED**. Connected / deployed dormant contours **12 / 12**. Remaining enabled uncovered contours **0**. Opus reviewed `329c2be` (P0=0 / P1=1 / P2=2, **REWORK REQUIRED**) and did not review `7e58c3df` directly. HEAD accepted the bounded corrective patch.

**NEXT = PRODUCTION ENVIRONMENT REF-POLICY HARDENING**. This is not authorization to change the GitHub Environment, not authorization to activate SHADOW, and not authorization to deploy.

## 08.26 closeout — Production Environment ref-policy hardening (2026-09-22)

This journal does **not** rewrite the 08.25 closeout above. The `UNSAFE` record there remains the pre-hardening evidence.

`audit/08.26-psr-p2-production-environment-ref-policy-hardening.md` records **COMPLETE / HEAD ACCEPTED / INDEPENDENT REVIEWED / LIVE VERIFIED / CONFIGURATION APPLIED / NO PRODUCTION ACCESS / NO DEPLOY / SHADOW INACTIVE**. Canonical?: **YES** after this docs closeout is accepted and merged. This was GitHub Environment configuration, not an application deployment. Starting `origin/main` `1c8b45b29acb1de1bac6eae13572dab71305de3e`. Starting tree `102692287c6e0dfd575590fc94cdd4e5a0f582dc`. Production application remains `2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf`. Last Actions run at closeout start `35642902576` SUCCESS. Environment `production` id `21178616940`. `can_admins_bypass = false`. `protected_branches = false`. `custom_branch_policies = true`. Exactly one deployment branch policy: id `60621333`, name `main`, type `branch`. No tag policy. No wildcard policy. Protection rule id `66278516`, type `branch_policy`. No required reviewers. No wait timer. No custom deployment protection app. Environment variables = 0. Final Environment `updated_at` `2026-09-21T19:32:57Z`. Environment secret names and metadata were not changed. No secret values were read. `PRODUCTION_ENVIRONMENT_REF_POLICY = SAFE / MAIN-ONLY / ADMIN-BYPASS-DISABLED`. Independent review **PASS / ACCEPT**. P0 = 0. P1 = 0. P2 = 5, non-blocking. P2-1 `CLOSED BY THIS DOCS CLOSEOUT`. P2-2 `ACCEPTED NON-BLOCKING HARDENING BACKLOG`. P2-3 `ACCEPTED NON-BLOCKING SUPPLY-CHAIN HARDENING BACKLOG` (`appleboy/ssh-action@v1.2.4` in exactly `deploy-production.yml`, `package2-production-readonly-verify.yml`, and `supply-production-preflight.yml`; SHADOW workflows use `scripts/shadow-activation-ssh.sh`). P2-4 `ACCEPTED / CURRENT DOCS DISTINGUISH DEPLOYMENT RECORD FROM PRODUCTION APPLICATION`. P2-5 `ACCEPTED INHERENT ADMIN CONTROL / MONITOR BY LIVE POLICY RE-READ`. Production accessed = **NO**. Production mutated = **NO**. Deploy = **NO**. SHADOW **NOT ACTIVATED**. Dual-write **NOT STARTED**. Ledger **NOT AUTHORITATIVE**. PSR-P2 **NOT COMPLETE**. PSR-P3 **NOT STARTED**.

**NEXT = PSR-P2 SHADOW ACTIVATION READINESS / OWNER AUTHORIZATION GATE**. The technical control plane is merged. Environment ref isolation is accepted. This NEXT does not authorize SHADOW activation, a deploy, cost-flow activation, backfill or reset, or PSR-P3. Owner authorization is required before any activation dispatch. There is no automatic activation. SHADOW gate ACTIVE alone is not dual-write started.

## 08.29 checkpoint — PSR-P3 Slice 1 closeout (2026-10-10)

`audit/08.29-psr-p3-slice1-invariant-a-closeout.md` records Slice 1 as **IMPLEMENTED / MERGED TO MAIN / POST-MERGE CI VERIFIED / NOT DEPLOYED**. This journal does not rewrite `audit/08.28`. Verified GitHub `main` baseline before this documentation closeout (PR #61): `df21c3c2a8e943c509ad52c2f70e13066fefe6de`. Production application remains `678cbc1d308ddfe568b901ebf53f7e05f9a8c014`. Invariant A is implemented for R-05, batch remainder write-off, and SimplePurchase. Invariant B is **NOT_EVALUABLE**. `MATCH_OBSERVED` does not prove a projection change. PSR-P3 is **PARTIAL / NOT COMPLETE**. Ledger **NOT AUTHORITATIVE**. `AUTHORITATIVE_COUNT` = **0**. Final epoch **NOT CREATED**. `OPENING_BALANCE` **NOT CREATED**. `production_cost_flow` **INACTIVE**. `SOAK_COMPLETE` = **NO**. `INC-001` **OPEN**. `ARCH-P1-001` **OPEN**. Paper removal **NOT AUTHORIZED**. Production was not accessed and was not deployed.

**NEXT = PSR-P3-S2-DISC-01 — Batch receipt provenance discovery**. Not started. Not an implementation authorization.

## 08.30 checkpoint — Batch receipt provenance discovery accepted (2026-10-10)

`audit/08.30-psr-p3-batch-receipt-provenance-discovery.md` is **DISCOVERY ACCEPTED / MERGED TO MAIN / POST-MERGE CI VERIFIED / NO IMPLEMENTATION**. Canonical?: **YES** after this status-sync package is accepted and merged. PR #62. Accepted HEAD `98acf79bbe164f7a05c783fa32924f9257efafae`. Tree `70d6ce4709cc7b27c3a419dba2800db39e0b5969`. Merge `055dd86743a99ec31518b298d03c286c04d9beb6`. Post-merge CI `38045353299`, job `114193656814`, SUCCESS. Verified GitHub `main` baseline before this status sync is that merge and is **not** a production application deploy. Production application remains `678cbc1d308ddfe568b901ebf53f7e05f9a8c014`. Discovery is **COMPLETE / ACCEPTED**. Option B is accepted in principle and is not implemented. Option A stays conditional. Slice 2 implementation is **NOT AUTHORIZED**. Historical reconstruction is **NO**. This journal does not rewrite `audit/08.27`, `audit/08.28`, or `audit/08.29`. Production was not accessed.

**NEXT = PSR-P3-S2-B-ARCH-01 — Forward-Only Batch Receipt Durable Provenance Contract**. Not started. Not an implementation authorization.

## 08.31 checkpoint — Forward-only Batch receipt durable provenance accepted (2026-10-10)

`audit/08.31-psr-p3-batch-receipt-durable-provenance-contract.md` is **ARCHITECTURE ACCEPTED / MERGED TO MAIN / POST-MERGE CI VERIFIED / NOT IMPLEMENTED**. Canonical?: **YES** after this status-sync package is accepted and merged. PR #64. Accepted HEAD `fdf82850831a5901817a61b01b36e239165dea1b`. Tree `632ecb777ef0ca7b4a9a8868a053810929a554b9`. Merge `d8fa4b017ef9deb9c102c38b72848e48993cf78a`. Parents `025c0c412840e22610a6a634ea80fbf4f30a25a1` and `fdf82850831a5901817a61b01b36e239165dea1b`. Post-merge CI `38059320498`, job `114234163436`, SUCCESS. Verified GitHub `main` baseline before this status sync is that merge and is **not** a production application deploy. Production application remains `678cbc1d308ddfe568b901ebf53f7e05f9a8c014`. Architecture is **ACCEPTED / COMPLETE**. Implementation is **NOT STARTED** and **NOT AUTHORIZED**. Accepted architecture is not operational warehouse readiness. This journal does not rewrite `audit/08.27`, `audit/08.28`, `audit/08.29`, or `audit/08.30`. Production was not accessed.

**NEXT = PSR-P3-S2-B-IMPL-GATE-01 — Forward-Only Durable Provenance Implementation Readiness / Scope Gate**. Not started. Not an implementation authorization.

## 08.32 candidate — Batch receipt implementation readiness gate (2026-10-10)

`audit/08.32-psr-p3-batch-receipt-implementation-readiness-gate.md` is **READINESS GATE ACCEPTED / MERGED TO MAIN / POST-MERGE CI VERIFIED / IMPLEMENTATION NOT YET AUTHORIZED**. Canonical?: **YES** after this status-sync package is accepted and merged. PR #66. Accepted HEAD `1105c4f0d858c5d79477fc1b596a17580ce88be4`. Tree `3a15a7e2f571207851efe1f25511c134d95c7427`. Merge `25abcde4f221483e2bc20fe03f4ce3a244f93d61`. Parents `04c6fbbd4329b41e0dd3a81e920f24c176946ec8` and `1105c4f0d858c5d79477fc1b596a17580ce88be4`. Post-merge CI `38065765320`, job `114252968644`, SUCCESS. Checkout `25abcde4f221483e2bc20fe03f4ce3a244f93d61`. Unit 119 / 1085 PASS. Integrity 38 / 533 PASS. Build SUCCESS. PR CI run `38063235540`: attempt 1 is a Build failure on `next/font` and is not a pass; attempt 2 is SUCCESS. Verified GitHub `main` baseline before this status sync is the merge of PR #66 and is **not** a production application deploy. Production application remains `678cbc1d308ddfe568b901ebf53f7e05f9a8c014`. Sequencing P1, then P2, then P3 is accepted. P1 implementation is **NOT YET AUTHORIZED**. P2 and P3 are **NOT AUTHORIZED**. This journal does not rewrite `audit/08.31`. Production was not accessed.

**NEXT = PSR-P3-S2-B-P1-IMPLEMENT-01 — Durable Provenance Schema / JSON CHECK / DB Immutability Guard**. Not started. Not code authorization.

## 08.33 checkpoint — P1 provenance guard closeout (2026-10-10)

`audit/08.33-psr-p3-s2-b-p1-provenance-guard-closeout.md` records P1 as **IMPLEMENTED IN MAIN / POST-MERGE CI VERIFIED / NOT DEPLOYED**. Canonical?: **YES** after this closeout is accepted and merged. PR #68. Initial implementation `d52e9c228ff7bca08a21d65b7c2d7db356aa2ad4`. Accepted R1 HEAD `6323c55d92c0fda6a5dbd451f0e2ae1a9a0e48cc`. Tree `fa2b10829b92622d5dc4791156af5a1342f4caee`. Merge `1b4cfcc5968e31264cfca7371edbc9ce9f236999`. Parents `f16cd1acd8d1447a0d2f42a1e76d157146b00c3a` and `6323c55d92c0fda6a5dbd451f0e2ae1a9a0e48cc`. Post-merge CI `38078078295`, attempt 1, job `114289141246`, event `push`, branch `main`, SUCCESS. Checkout `1b4cfcc5968e31264cfca7371edbc9ce9f236999`. Unit 120 / 1087 PASS. Integrity 39 / 540 PASS. Build SUCCESS. Server Action manifest SUCCESS. Four files, +606 / −0. P1 production schema migration is **NOT AUTHORIZED / NOT EXECUTED**. P2 and P3 are **NOT AUTHORIZED**. This journal does not rewrite `audit/08.31` or `audit/08.32`. Production was not accessed.

**NEXT = PSR-P3-S2-B-P2-IMPLEMENT-01 — Transactional createBatch writer / provenance snapshot builder / replay and rollback tests**. Package name only. Not P2 code authorization. Not a deploy.

## 08.34 checkpoint — P2 provenance writer closeout (2026-10-11)

`audit/08.34-psr-p3-s2-b-p2-provenance-writer-closeout.md` records P2 as **IMPLEMENTED IN MAIN / POST-MERGE CI VERIFIED / NOT DEPLOYED**. Canonical?: **YES** after this closeout is accepted and merged. PR #70. Initial implementation `7de3e65250a41774df316762aca43c848588ba6a`. Accepted R1 HEAD `627c6817f3bb6babc93911ccd90cab8857962648`. Tree `7d9db7f82f869d9be8b5258348a7eea383377fe3`. Merge `e6110fa142e977b71d58ab898328c39610bf73b1`. Parents `e4ddd7fbedd6ed77a41e9443721ee377047c3e70` and `627c6817f3bb6babc93911ccd90cab8857962648`. Post-merge CI `38086320638`, attempt 1, job `114313462311`, event `push`, branch `main`, SUCCESS. Checkout `e6110fa142e977b71d58ab898328c39610bf73b1`. Unit 121 / 1096 PASS. Integrity 40 / 552 PASS. Build SUCCESS. Server Action manifest SUCCESS. Four files, +654 / −0. P1 production schema migration is **NOT AUTHORIZED / NOT EXECUTED**. P2 production deploy is **NOT AUTHORIZED**. P3 is **NOT AUTHORIZED**. This journal does not rewrite `audit/08.31`, `audit/08.32`, or `audit/08.33`. Production was not accessed.

**NEXT = PSR-P3-S2-B-P3-IMPLEMENT-01 — Read-only Batch receipt Invariant A checker**. Package name only. Not P3 code authorization. Not a deploy.

## 08.35 checkpoint — P3 read-only checker closeout (2026-10-11)

`audit/08.35-psr-p3-s2-b-p3-batch-receipt-checker-closeout.md` records P3 as **IMPLEMENTED IN MAIN / POST-MERGE CI VERIFIED / NOT DEPLOYED**. Canonical?: **YES** after this closeout is accepted and merged. PR #72. Accepted implementation HEAD `cef2ee394e7bf3eb8fea37be9a7290c6421d4bb1`. Tree `289aae687243e5a1341dd1e6656c095f3fc53583`. Merge `592375843bab6cd82fe86f62db0ae9b15dcae9bf`. Parents `e1e9a6aab280374b47d62be441362854f4d62300` and `cef2ee394e7bf3eb8fea37be9a7290c6421d4bb1`. Post-merge CI `38123106192`, attempt 1, job `114421737536`, event `push`, branch `main`, SUCCESS. Checkout `592375843bab6cd82fe86f62db0ae9b15dcae9bf`. Unit 122 / 1119 PASS. Integrity 41 / 564 PASS. TypeScript, lint, and security SUCCESS. Build SUCCESS. Server Action manifest SUCCESS. Three files, +1489 / −0. P1 production schema migration is **NOT AUTHORIZED / NOT EXECUTED**. P2 production deploy is **NOT AUTHORIZED**. P3 production deploy is **NOT AUTHORIZED**. This journal does not rewrite `audit/08.31`, `audit/08.32`, `audit/08.33`, or `audit/08.34`. Production was not accessed.

**NEXT = PSR-P3-S2-B-ROLLOUT-READINESS-01 — Deployment sequencing, schema compatibility, and rollback gate**. Package name only. Not a production migration. Not a deploy. Not production access.

## 08.36 checkpoint — rollout readiness assessment (2026-10-11)

`audit/08.36-psr-p3-s2-b-rollout-readiness.md` records a rollout readiness assessment as **CANDIDATE / NOT READY / EVIDENCE INCOMPLETE**. Canonical?: **YES** only after this assessment is accepted and merged. Verified GitHub `main` baseline before this assessment: `03121e730ca6afab7751adda10ba69af0ec3fc3e`. Tree `c226b4696d5fdf40102b691381b0dea259b2db4d`. Recorded production application `678cbc1d308ddfe568b901ebf53f7e05f9a8c014`, Deploy `37816537899`. Production was not queried. The current production workflow cannot apply the P1 migration without also starting the P2/P3 image. That is a deployment blocker, not a go decision. P1 production migration remains **NOT AUTHORIZED / NOT EXECUTED**. P2 and P3 production deployment remain **NOT AUTHORIZED**. This journal does not rewrite `audit/08.26` through `audit/08.35`.

**NEXT = PSR-P3-S2-B-ROLLOUT-GATE-RESOLUTION-01 — Resolve the deployment blocker and the missing production evidence**. Package name only. Not a production migration. Not a deploy. Not production access.

## 08.42 checkpoint — P1-only release path (2026-10-15)

`audit/08.42-psr-p3-p1-only-release-implementation.md` records an isolated migration-only prototype. Status: **ISOLATED MIGRATION-ONLY PROTOTYPE — VERIFIED**. **PRODUCTION EXECUTION ADAPTER — NOT IMPLEMENTED**. **PRODUCTION RUNTIME AUTHENTICATION — NOT COMPLETE**. **PRODUCTION P1 MIGRATION — NOT AUTHORIZED / NOT EXECUTED**. **PRODUCTION DEPLOY — NOT AUTHORIZED**. Canonical?: **NO** until HEAD accepts and merges this candidate. Base `c6d982ab2c0c0ca239904e1a3ccc78390493e5b2`. The disposable proof runs `prisma migrate deploy` for the pinned P1 migration and does not start the application. The test application container runs `node /app/health.js` and is not the historical production Next.js container. Production container names stay unauthorized. A recovery word is not a backup proof. The writer-deploy check refuses when P1 is absent or its definitions do not match, and it does not add an unconditional stop. This journal does not rewrite `audit/08.36`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed.

## 08.43 checkpoint — production P1-only adapter (2026-10-15)

`audit/08.43-psr-p3-p1-production-adapter.md` records a separate production-shaped adapter for the isolated mechanism accepted in PR #91. Status: **PRODUCTION P1 ADAPTER — R2 / TEST-OWNED PROOF**. **PRODUCTION TRUST KEY — UNPROVISIONED**. **PRODUCTION DAEMON — UNPINNED**. **PRODUCTION RUNTIME AUTHENTICATION — NOT COMPLETE**. **PRODUCTION P1 MIGRATION — NOT AUTHORIZED / NOT EXECUTED**. **PRODUCTION DEPLOY — NOT AUTHORIZED**. Canonical?: **NO** until HEAD accepts and merges this candidate. Base `0d73ab6aee038b2655a64c5b8bacb9ad02476203`. Tree `6996d059eef6c606704a7d474cd550e02ea2e792`. The disposable runner is unchanged and `productionReleaseAuthorized()` stays false. The test-owned proof uses PostgreSQL 17, DNS alias `db`, and no published database port. Its result class is `TEST_OWNED_NOT_PRODUCTION`. The public CLI cannot apply P1. The production daemon pin is not in the repository and is not invented from the 2026-10-15 evidence. This journal does not rewrite `audit/08.36` or `audit/08.42`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed.

R1 (`PSR-P3-P1-PRODUCTION-ADAPTER-R1`) keeps the same candidate. A caller JSON object is not owner authorization. Production apply verifies an Ed25519 signature against `/var/lib/stell22/p1-owner-authorization.pub`, which is **UNPROVISIONED**. The executor does not hold a private key. Docker endpoint resolution rejects remote contexts and does not inherit unrelated parent credentials. Restore evidence is produced by the adapter's restore controller; a forged report or a shared production volume is refused. Test-owned proof is not production readiness. Production P1 migration remains **NOT AUTHORIZED / NOT EXECUTED**. Production deploy remains **NOT AUTHORIZED**.

R2 (`PSR-P3-P1-PRODUCTION-ADAPTER-R2`) keeps production apply unavailable. Recovery uses the persisted release backup for the attempt and does not mint a witness. Authorization is consumed once, under the host lock, by an exclusive-create marker. Missing or malformed Docker mount metadata fails closed. The owner trust key remains **UNPROVISIONED**. Production P1 migration remains **NOT AUTHORIZED / NOT EXECUTED**. Production deploy remains **NOT AUTHORIZED**.

## 08.44 checkpoint — production operator wiring (2026-10-16)

`audit/08.44-psr-p3-p1-production-operator-wiring.md` connects the accepted adapter to a local operator runtime. Status: **OPERATOR RUNTIME — WIRED / R2 CLEANUP OWNERSHIP / TEST-OWNED PROOF**. **PRODUCTION MIGRATION — NOT AUTHORIZED**. **PRODUCTION APPLY — NOT EXECUTED**. **PRODUCTION DEPLOY — NOT AUTHORIZED**. Canonical?: **NO** until HEAD accepts and merges this candidate. Base `c424340b10a5de57303f0e955fd8ee49af1f5c58`. Tree `e8fe2412579633fcbbceb00211c1e685a732cab9`. PR #92 is merged and its post-merge CI `38875323679` succeeded. PR #93 remains open. R2 creates the disposable credential directory exclusively and does not treat a failed Docker inspect as resource absence. PR #93 R2 CI `38898857417` on `0e8437ef6136b622d0e1ba2b693cf67e79ece3e5` succeeded. R1 behavior stays: the password is not a Docker argument, cleanup removes only resources this invocation created, and preflight does not create or delete files. `imageGitSha` stays `UNVERIFIED`. The test-owned proof is not a production apply. This journal does not rewrite `audit/08.36`, `audit/08.42`, or `audit/08.43`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed.

## 08.45 checkpoint — P1 release-gate correction (2026-10-16)

`audit/08.45-psr-p3-p1-release-gate-correction.md` records the P1-1 and P1-2 correction. Status: **NOT READY / EVIDENCE INCOMPLETE**. **OWNER TRUST KEY — NOT INSTALLED**. **OWNER SIGNED APPROVAL — ABSENT**. **PRODUCTION VERIFY-RECOVERY — ABSENT**. **PRODUCTION MIGRATOR IMAGE — NOT PROVISIONED**. **PRODUCTION P1 — NOT AUTHORIZED**. **PRODUCTION DEPLOYMENT — NOT AUTHORIZED**. Canonical?: **NO** until HEAD accepts and merges this candidate. Base `7f9ef79e2134ba157935b0a459b3443bf848f146`. Tree `7b613c8b2090bc869fd921b8b18d96c1b88a83bd`. PR #92 and PR #93 are merged on that base; the sentence above that PR #93 remains open is the `08.44` pre-merge record and is not rewritten. The one-shot container is bound to an approved Docker image digest, and that digest is inside the dossier hash. The CLI prints the attempt id and the dossier and recovery digests, and does not present an unavailable digest as a signing input. P1-3 is not implemented. This journal does not rewrite `audit/08.36` through `audit/08.44`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed.

## 08.46 checkpoint — P1 operator crash safety (2026-10-17)

`audit/08.46-psr-p3-p1-operator-crash-safety.md` records the P2-1 host lock and the P2-2 spawn intent and credential cleanup. Status: **NOT READY / EVIDENCE INCOMPLETE**. **PRODUCTION P1 — NOT AUTHORIZED / NOT EXECUTED**. **PRODUCTION DEPLOYMENT — NOT AUTHORIZED**. **PRODUCTION CRASH RECOVERY — NOT TESTED**. Canonical?: **NO** until HEAD accepts and merges this candidate. Base `058f6a7010aff53d9749ff1cab63d95447cde446`. Tree `a67c13c844b927ff862d8b3da1eb34b09bec99f4`. PR #94 is merged and post-merge CI `39010736839` succeeded. `verify-recovery` and `apply` share one host lock. Preflight does not take it. A spawn intent marker is written before authorization and is removed when authorization is rejected without a spawn. A leftover intent or ambiguous marker blocks another migration. Credential cleanup does not recursive-delete a directory it does not own. P1-3 and the other Opus findings are not in this package. This journal does not rewrite `audit/08.36` through `audit/08.45`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed.

## 08.47 checkpoint — offline Owner signing (2026-10-17)

`audit/08.47-psr-p3-p1-offline-owner-signing.md` records the P1-2 offline signing utility. Status: **NOT READY / EVIDENCE INCOMPLETE**. **SECURITY VERIFIED — NO**. **OWNER EXECUTION — NOT AUTHORIZED**. **PRODUCTION RELEASE — NO-GO**. Canonical?: **NO** until HEAD accepts and merges this candidate. Base `00f240263146903ed23445a5ecf49467f8ddc95d`. Tree `1a637c369bf853b05ab733d6cb70129cff564cb5`. PR #95 is merged and post-merge CI `39017986259` succeeded. The utility signs only a reviewed, explicitly untrusted evidence file. It does not generate the Owner key, read the Owner profile, or contact production. The operator prints the authenticated daemon id. P1-3 is not implemented. This journal does not rewrite `audit/08.36` through `audit/08.46`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed.

## 08.48 checkpoint — P1-3 write-freeze design (2026-10-17)

`audit/08.48-psr-p3-p1-write-freeze-design.md` is the P1-3 design record. Status: **DESIGN ONLY / DESIGN D CANDIDATE NOT ACCEPTED / WRITE-FREEZE NOT IMPLEMENTED / NOT READY / EVIDENCE INCOMPLETE / DESIGN BLOCKED ON THE CURRENT DATABASE ROLE**. **PRODUCTION RELEASE — NO-GO**. **OWNER APPROVAL OF A ROLE SPLIT — NOT GIVEN**. Canonical?: **NO**. Design base `b1f27a215a929e73bf0ba8faf2d2cc91a8fb5f6a`, tree `aa83d7efbd832abfc43e6129ba9c0252b91424df`. PR #97 is open. HEAD review `6238305737` required R1. R1 corrects the transaction model: role creation, role alteration, ownership transfer, and `GRANT`/`REVOKE` can commit or roll back together. The bootstrap superuser cannot be set `NOSUPERUSER`. The candidate is a permanent three-role split, not a temporary maintenance mode, and it is not accepted. This journal does not rewrite `audit/08.36` through `audit/08.47`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. The rollout NEXT named above is not an authorization to start that role split. Production was not accessed.

## 08.49 checkpoint — disposable PostgreSQL 17 write-freeze proof (2026-10-18)

`audit/08.49-psr-p3-p1-write-freeze-pg17-proof.md` records package A. Status: **PROVEN IN DISPOSABLE POSTGRESQL / P1-3 NOT IMPLEMENTED / PRODUCTION ROLE SPLIT NOT AUTHORIZED / NOT READY / EVIDENCE INCOMPLETE / PRODUCTION RELEASE — NO-GO**. **OWNER APPROVAL OF A ROLE SPLIT — NOT GIVEN**. Canonical?: **NO**. Base `e2212fe23a0f6c45f734a3debc0002fcc2104011`, tree `f37e2a6daebea33b86cc89ab3306061f941206f0`. PR #97 is merged. The proof uses a new `postgres:17-alpine` cluster with `POSTGRES_USER=stell22` and generated passwords. It does not change production roles, run production SQL, or approve Design D. The historical application image remains unproven. This journal does not rewrite `audit/08.36` through `audit/08.48`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed. R1 (HEAD review `6247664583`) corrects the harness: cleanup no longer deletes by label, and either image-identity mismatch refuses the container. That correction does not implement P1-3 and does not authorize a production role split.

## 08.50 checkpoint — disposable historical application proof (2026-10-18)

`audit/08.50-psr-p3-p1-write-freeze-historical-app-proof.md` records package B. Status: **HISTORICAL APP ON DISPOSABLE POSTGRESQL — MEASURED / P1-3 NOT IMPLEMENTED / PRODUCTION ROLE SPLIT NOT AUTHORIZED / NOT READY / EVIDENCE INCOMPLETE / PRODUCTION RELEASE — NO-GO**. **OWNER APPROVAL OF A ROLE SPLIT — NOT GIVEN**. **DESIGN D — CANDIDATE / NOT ACCEPTED**. Canonical?: **NO**. Main `07041d4b8b26e64cae0c453089bafe25919ffe5a`, tree `0f130a304a1e3d420aebaf27ec597dad7bb8ca59`. Historical source `678cbc1d308ddfe568b901ebf53f7e05f9a8c014`, tree `502f5f5a3c7f2e4ec70427f935485e8184d7b984`. The historical entrypoint started as a non-superuser on a test-owned cluster when nothing was pending, and again after disposable P1 SQL. That does not approve a production role split. This journal does not rewrite `audit/08.36` through `audit/08.49`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed.

## 08.51 checkpoint — P1 migrator identity (2026-10-18)

`audit/08.51-psr-p3-p1-write-freeze-migrator-identity.md` records package C. Status: **IMPLEMENTED IN CODE / PROVEN ON DISPOSABLE PG17 / NOT INSTALLED IN PRODUCTION / NOT VERIFIED ON PRODUCTION / P1-3 NOT IMPLEMENTED / DESIGN D CANDIDATE / ROLE SPLIT NOT OWNER-APPROVED / NOT READY / EVIDENCE INCOMPLETE / PRODUCTION RELEASE — NO-GO**. **OWNER APPROVAL OF A ROLE SPLIT — NOT GIVEN**. Canonical?: **NO**. Base main `83e3616f039779a1aec9da2e0fe38c286ec1ca27`, tree `11534024671edd00e24ee9615aafaf93311b8960`. The adapter can apply pinned P1 only as `stell22_migrator` after a catalog privilege read. `stell22` stays the target role. The production credential file is not installed. The application entrypoint is unchanged. This journal does not rewrite `audit/08.36` through `audit/08.50`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed. PR #100 is merged as `741bf212e8b2571702f3a43cb5aa09a8a46b76a7`.

## 08.52 checkpoint — app-only startup candidate (2026-10-18)

`audit/08.52-psr-p3-p1-app-only-startup.md` records a separate application entrypoint. Status: **APP-ONLY STARTUP CANDIDATE ONLY / P1-3 NOT IMPLEMENTED / PRODUCTION ROLE SPLIT NOT AUTHORIZED / NOT READY / EVIDENCE INCOMPLETE / PRODUCTION RELEASE — NO-GO**. **OWNER APPROVAL OF A ROLE SPLIT — NOT GIVEN**. **DESIGN D — CANDIDATE / NOT ACCEPTED**. Canonical?: **NO**. Base main `741bf212e8b2571702f3a43cb5aa09a8a46b76a7`, tree `ebfd8352380b09c2b76557904034a71381c66f86`. R1 corrects the open PR #101 candidate: database `stell22` is allowed only for a restricted non-owner role, the role catalog covers database and object ownership, Docker cleanup is invocation-bound, production migrations are read from `/app`, and checksums normalize CRLF pairs only. The candidate starts Next.js only after a read-only schema gate. It does not change `docker-entrypoint.sh`, the production Dockerfile, Compose, or `scripts/deploy.sh`. This journal does not rewrite `audit/08.36` through `audit/08.51`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed. This checkpoint is not permission for a production upgrade. PR #101 later merged as `f497df0feeb3e1ed6b7079928e68f5c492675baa`. The `08.52` text above is not rewritten.

## 08.53 checkpoint — disposable write-freeze coordinator (2026-10-19)

`audit/08.53-psr-p3-p1-write-freeze-coordinator.md` records an isolated disposable coordinator. Status: **IMPLEMENTED IN CODE / VERIFIED ON DISPOSABLE POSTGRESQL 17 / NOT CONNECTED TO THE PRODUCTION OPERATOR / NOT VERIFIED IN PRODUCTION / P1-3 NOT IMPLEMENTED / DESIGN D CANDIDATE / PRODUCTION ROLE SPLIT NOT AUTHORIZED / NOT READY / EVIDENCE INCOMPLETE / PRODUCTION RELEASE — NO-GO**. **OWNER APPROVAL OF A ROLE SPLIT — NOT GIVEN**. **DESIGN D — CANDIDATE / NOT ACCEPTED**. Canonical?: **NO**. Base main `f497df0feeb3e1ed6b7079928e68f5c492675baa`, tree `4fd05bc5cf0d31945d1f00171851d45b49e07d30`. `FROZEN_VERIFIED` covers the application role only. A superuser and the owning migrator can still write. Test-owned approvals are not owner signatures. The production operator, entrypoint, Dockerfile, Compose, and `scripts/deploy.sh` are unchanged. This journal does not rewrite `audit/08.36` through `audit/08.52`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed. PR #102 later merged as `dcc3eeb0681ec8529b020831105d768eb5d72e54`. The `08.53` text above is not rewritten.

## 08.54 checkpoint — privileged writer barrier (2026-10-20)

`audit/08.54-psr-p3-p1-privileged-writer-barrier.md` records a disposable PostgreSQL 17 proof. Status: **PRIVILEGED_WRITER_BARRIER_BLOCKED / ARCHITECTURE_BLOCKED / P1-3 NOT IMPLEMENTED / FREEZE_COVERAGE APPLICATION_ROLE_ONLY / DESIGN D CANDIDATE / ROLE SPLIT NOT OWNER-APPROVED / NOT READY / EVIDENCE INCOMPLETE / PRODUCTION RELEASE — NO-GO**. **OWNER APPROVAL OF A ROLE SPLIT — NOT GIVEN**. **DESIGN D — CANDIDATE / NOT ACCEPTED**. Canonical?: **NO**. Base main `dcc3eeb0681ec8529b020831105d768eb5d72e54`, tree `c111e7070f1690c1c5a1196f6d28a5ae1da9263d`. Default-reject authentication blocks a new login that is not allow-listed. An existing session, the admitted superuser, and host root can still write. `FROZEN_VERIFIED` is not upgraded. No production privilege cutover. This journal does not rewrite `audit/08.36` through `audit/08.53`. `audit/08.36` remains **NOT READY / EVIDENCE INCOMPLETE**. Production was not accessed. This checkpoint is not permission for a production upgrade. PR #103 is open and is not merged.
