import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import { HISTORICAL_MIGRATION_NAMES } from "@/server/internal/p1-isolated-runner/classify";
import {
  POSTGRES_IMAGE_REF,
  createOwnedDisposableContainer,
  reconfirmOwnedContainer,
  removeOwnedDisposableContainer,
} from "@/server/internal/p1-isolated-runner/container-origin";
import {
  EXPECTED_HISTORICAL_MIGRATION_COUNT,
  EXPECTED_MIGRATION_SQL_COUNT,
  HISTORICAL_APPLICATION_COMMIT,
  P1_MIGRATION_NAME,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import {
  attestationFor,
  deployPrisma,
  finishedNames,
  identityFrom,
  installIdentity,
  materializeHistorical,
  ownedUrl,
  postApplySummary,
  queryOwned,
  runPrisma,
  sameTarget,
  waitUntilReady,
  writeQueryChild,
} from "@/server/internal/p1-isolated-runner/disposable-migration-harness";
import { buildChildEnv } from "@/server/internal/p1-isolated-runner/env";
import { executeDisposableApply } from "@/server/internal/p1-isolated-runner/executor";
import { executeP1OnlyMigration } from "@/server/internal/p1-isolated-runner/p1-only-migration";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import {
  disposableEvidenceFromQueries,
  readDisposablePostgreSql,
} from "@/server/internal/p1-isolated-runner/live-read-probe";
import { assessOwnedDisposablePreapply } from "@/server/internal/p1-isolated-runner/owned-preapply-gate";
import {
  checkMatchesContract,
  columnMatchesContract,
  functionMatchesContract,
  triggerMatchesContract,
} from "@/server/internal/p1-isolated-runner/schema-contract";

/**
 * LIVE OLD-APPLICATION EVIDENCE.
 * The historical sources are the git bytes of HISTORICAL_APPLICATION_COMMIT.
 * esbuild only loads those bytes. The single substituted module is
 * test-only/admin-shim.ts, because requireAdmin reads next/headers cookies().
 * createBatch, updateBatch, Prisma queries, and PostgreSQL are not substituted.
 *
 * NEXT RUNTIME CONTEXT, not a business mock: Next's compiled server reads
 * globalThis.AsyncLocalStorage, and the real revalidatePath records tags only
 * when workAsyncStorage has an incremental cache. The child sets both before
 * calling the historical functions.
 */

const LIVE_FLAG = "P1_DISPOSABLE_LIVE";
const REQUEST_ID = "old-app-compat-request-1";

const AUTH_SHIM = `import { prisma } from "@/server/db";

/**
 * TEST-ONLY AUTH SUBSTITUTION.
 * Historical requireAdmin reads next/headers cookies() and cannot run outside
 * a Next request. This returns the fixture ADMIN row through the historical
 * Prisma client. It does not replace createBatch, updateBatch, Prisma, or SQL.
 */
export async function requireAdmin() {
  const user = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    select: { id: true, name: true, email: true, role: true },
  });
  if (!user || user.role !== "ADMIN") {
    throw new Error("TEST-ONLY AUTH: fixture admin is missing");
  }
  return user;
}
`;

const RUNNER = `import { createRequire } from "node:module";
import { prisma } from "@/server/db";
import { createBatch, updateBatch } from "@/server/purchases";

const require = createRequire(__filename);
const { workAsyncStorage } = require(
  "next/dist/server/app-render/work-async-storage.external.js",
);

type Payload = {
  requestId?: string;
  batchId?: string;
  values?: never;
};

function withNextStore<T>(fn: () => Promise<T>): Promise<T> {
  const store = { incrementalCache: {}, pendingRevalidatedTags: [] as unknown[] };
  return workAsyncStorage.run(store, fn);
}

export async function run(mode: string, payload: Payload) {
  if (mode === "seed") {
    const admin = await prisma.user.create({
      data: {
        email: "old-app-compat@example.test",
        passwordHash: "test-only-not-a-login",
        name: "Тестовый администратор",
        role: "ADMIN",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Хвоя совместимости",
        sectionWidthMm: 40,
        sectionHeightMm: 20,
      },
    });
    return { adminId: admin.id, materialId: material.id };
  }
  if (mode === "create") {
    const row = await withNextStore(() => createBatch(payload.values, payload.requestId ?? ""));
    return { id: row.id, name: row.name };
  }
  if (mode === "update") {
    const row = await withNextStore(() => updateBatch(payload.batchId ?? "", payload.values));
    return { id: row.id, name: row.name };
  }
  throw new Error("unknown historical mode");
}
`;

const ENTRY = `const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
globalThis.AsyncLocalStorage = AsyncLocalStorage;
const secret = process.env.DATABASE_URL || "";
function redact(text) {
  return String(text)
    .split(secret)
    .join("[redacted]")
    .replace(/postgres(?:ql)?:\\/\\/\\S+/gi, "[url]")
    .replace(/p1disp_[0-9a-f]+/gi, "[database]");
}
const { run } = require("./historical-app.cjs");
const payload = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
run(process.argv[2], payload)
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
  })
  .catch((error) => {
    process.stderr.write(redact(error && error.stack ? error.stack : error));
    process.exit(1);
  });
`;

describe.skipIf(process.env[LIVE_FLAG] !== "1")(
  "historical application on postgresql 17 after disposable P1",
  () => {
    it(
      "runs historical createBatch, replay, and updateBatch on the migrated database",
      async () => {
        const owned = createOwnedDisposableContainer();
        const runtime = fs.mkdtempSync(path.join(process.cwd(), ".p1-historical-runtime-"));
        const queryScript = writeQueryChild(path.join(process.cwd(), "node_modules", ".cache"));
        const sharedClient = path.join(
          process.cwd(),
          "node_modules",
          ".prisma",
          "client",
          "index.d.ts",
        );
        const sharedClientBefore = fs.readFileSync(sharedClient);
        let fixture: PrismaClient | null = null;
        let failure: unknown;
        try {
          expect(owned.host).toBe("127.0.0.1");
          expect(owned.user).toBe("p1disp");
          expect(owned.imageRef).toBe(POSTGRES_IMAGE_REF);
          expect(owned.containerId).toMatch(/^[0-9a-f]{64}$/);
          expect(owned.port).toBeGreaterThan(0);
          expect(owned.databaseName.startsWith("p1disp_")).toBe(true);
          expect(owned.endpoint.startsWith("tcp:")).toBe(false);
          expect(owned.endpoint.startsWith("ssh:")).toBe(false);

          const ready = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, ready)).toBe(true);
          fixture = new PrismaClient({ datasourceUrl: ownedUrl(ready) });
          await waitUntilReady(fixture);
          await fixture.$disconnect();
          fixture = null;

          fs.mkdirSync(runtime, { recursive: true });
          const historicalSchema = materializeHistorical(path.join(runtime, "migrations"));
          const historical = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, historical)).toBe(true);
          const historicalDeploy = deployPrisma(historicalSchema, ownedUrl(historical));
          expect(historicalDeploy.status, historicalDeploy.detail).toBe(0);
          expect(historicalDeploy.signal).toBeNull();

          const identified = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, identified)).toBe(true);
          fixture = new PrismaClient({ datasourceUrl: ownedUrl(identified) });
          await installIdentity(fixture, identified);
          await fixture.$disconnect();
          fixture = null;

          const before = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, before)).toBe(true);
          const beforeUrl = ownedUrl(before);
          const beforeEvidence = disposableEvidenceFromQueries(queryOwned(queryScript, beforeUrl));
          expect(finishedNames(beforeEvidence.history)).toEqual(
            [...HISTORICAL_MIGRATION_NAMES].sort(),
          );
          expect(beforeEvidence.history).toHaveLength(EXPECTED_HISTORICAL_MIGRATION_COUNT);
          expect(beforeEvidence.schema.column).toBeNull();

          const gate = await assessOwnedDisposablePreapply(owned);
          expect(gate.status, "code" in gate ? gate.code : "").toBe("diagnostic-ready");
          if (gate.status !== "diagnostic-ready") return;
          expect(gate.code).toBe("P1_ABSENT");
          expect(gate.executionAuthorized).toBe(false);
          expect(gate.prismaExecutionAuthorized).toBe(false);
          expect(gate.publicAuthorization.applyEnabled).toBe(false);

          const confirmed = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, confirmed)).toBe(true);
          const confirmedUrl = ownedUrl(confirmed);
          let spawns = 0;
          let prismaDetail = "";
          const parentEnv = {
            ...process.env,
            DATABASE_URL: "postgresql://blocked.example/stell22",
          };
          const first = executeDisposableApply(attestationFor(confirmed), {
            git: createRepoGitSource(process.cwd()),
            destinationRoot: path.join(runtime, "p1"),
            lockPath: path.join(runtime, "p1.lock"),
            parentEnv,
            readHistory: () =>
              disposableEvidenceFromQueries(queryOwned(queryScript, confirmedUrl)).history,
            readSchema: () =>
              disposableEvidenceFromQueries(queryOwned(queryScript, confirmedUrl)).schema,
            probeIdentity: () => identityFrom(queryOwned(queryScript, confirmedUrl)),
            spawnPrisma: (request) => {
              spawns += 1;
              const argsOk =
                request.args.length === 4 &&
                request.args[0] === "migrate" &&
                request.args[1] === "deploy" &&
                request.args[2] === "--schema";
              const target = new URL(String(request.env.DATABASE_URL));
              const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
              const targetOk =
                target.hostname === "127.0.0.1" &&
                target.port === String(confirmed.port) &&
                target.username === "p1disp" &&
                database === confirmed.databaseName &&
                !Object.values(request.env).some((value) =>
                  String(value).includes("blocked.example"),
                );
              if (!argsOk || !targetOk) {
                prismaDetail = "refusing prisma target";
                return { status: 1, signal: null };
              }
              const result = runPrisma(request.args, request.cwd, request.env);
              prismaDetail = result.detail || "no prisma text";
              return result;
            },
          });
          if (first.verdict !== "ALREADY_APPLIED") {
            throw new Error(postApplySummary(queryScript, confirmedUrl, first, prismaDetail));
          }
          expect(first).toEqual({
            verdict: "ALREADY_APPLIED",
            code: "P1_APPLIED",
            spawned: true,
            retryAttempted: false,
          });
          expect(spawns).toBe(1);

          const migrated = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, migrated)).toBe(true);
          const migratedUrl = ownedUrl(migrated);
          assertP1Schema(queryScript, migratedUrl);
          const report = await readDisposablePostgreSql(attestationFor(migrated));
          expect(report.verdict).toBe("BLOCKED");
          expect(report.code).toBe("CONTAINER_ORIGIN_NOT_ESTABLISHED");
          expect(report.applyEnabled).toBe(false);
          const reportText = JSON.stringify(report);
          expect(reportText).not.toContain(migrated.password);
          expect(reportText).not.toContain("postgresql://");

          const appRoot = path.join(runtime, "app");
          extractHistorical(appRoot);
          const purchasesPath = path.join(appRoot, "src", "server", "purchases.ts");
          const schemaPath = path.join(appRoot, "prisma", "schema.prisma");
          expect(gitBlob(purchasesPath)).toBe(gitBlobAt("src/server/purchases.ts"));
          expect(gitBlob(schemaPath)).toBe(gitBlobAt("prisma/schema.prisma"));
          const purchasesSource = fs.readFileSync(purchasesPath, "utf8");
          expect(purchasesSource).not.toContain("receiptProvenanceSnapshot");
          expect(purchasesSource).not.toContain("psr-p3");

          fs.mkdirSync(path.join(appRoot, "node_modules", "@prisma"), { recursive: true });
          fs.cpSync(
            path.join(process.cwd(), "node_modules", "prisma"),
            path.join(appRoot, "node_modules", "prisma"),
            { recursive: true, dereference: true },
          );
          fs.cpSync(
            path.join(process.cwd(), "node_modules", "@prisma", "client"),
            path.join(appRoot, "node_modules", "@prisma", "client"),
            { recursive: true, dereference: true },
          );
          const generated = generateHistoricalClient(appRoot, schemaPath, migratedUrl);
          expect(generated.status, generated.detail).toBe(0);
          if (!fs.readFileSync(sharedClient).equals(sharedClientBefore)) {
            throw new Error("shared prisma client types were replaced");
          }
          expect(clientIdentity(appRoot, migratedUrl)).toBe("HISTORICAL_CLIENT");

          const testOnly = path.join(appRoot, "test-only");
          fs.mkdirSync(testOnly, { recursive: true });
          const shimPath = path.join(testOnly, "admin-shim.ts");
          const runnerPath = path.join(testOnly, "runner.ts");
          fs.writeFileSync(shimPath, AUTH_SHIM);
          fs.writeFileSync(runnerPath, RUNNER);
          fs.writeFileSync(path.join(testOnly, "entry.cjs"), ENTRY);
          const built = await esbuild.build({
            absWorkingDir: appRoot,
            entryPoints: [runnerPath],
            outfile: path.join(testOnly, "historical-app.cjs"),
            bundle: true,
            platform: "node",
            format: "cjs",
            packages: "external",
            metafile: true,
            logLevel: "silent",
            plugins: [
              {
                name: "historical-alias",
                setup(build) {
                  build.onResolve({ filter: /^@\// }, (args) => {
                    if (args.path === "@/server/session") return { path: shimPath };
                    const base = path.join(appRoot, "src", args.path.slice(2));
                    const found = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(
                      (item) => fs.existsSync(item),
                    );
                    if (!found) return { errors: [{ text: `missing historical import ${args.path}` }] };
                    return { path: found };
                  });
                },
              },
            ],
          });
          const inputs = Object.keys(built.metafile?.inputs ?? {}).map((item) =>
            item.replaceAll("\\", "/"),
          );
          expect(inputs).toContain("src/server/purchases.ts");
          expect(inputs).toContain("test-only/admin-shim.ts");
          expect(inputs.some((item) => item.endsWith("src/server/session.ts"))).toBe(false);
          expect(inputs.some((item) => item.includes("psr-p3"))).toBe(false);
          expect(inputs.some((item) => item.includes("receiptProvenance"))).toBe(false);

          const countsBeforeSeed = tableCounts(queryScript, migratedUrl);
          const seeded = runHistorical(testOnly, migratedUrl, "seed", {});
          const materialId = String(seeded.materialId ?? "");
          expect(materialId.length).toBeGreaterThan(0);
          const countsAfterSeed = tableCounts(queryScript, migratedUrl);
          const materialBefore = countsBeforeSeed.get("Material") ?? 0;
          const userBefore = countsBeforeSeed.get("User") ?? 0;
          expect(countDiff(countsBeforeSeed, countsAfterSeed)).toEqual([
            `Material:${materialBefore}->${materialBefore + 1}`,
            `User:${userBefore}->${userBefore + 1}`,
          ]);

          const values = batchValues(materialId, "Партия совместимости");
          const created = runHistorical(testOnly, migratedUrl, "create", {
            requestId: REQUEST_ID,
            values,
          });
          const batchId = String(created.id ?? "");
          expect(batchId.length).toBeGreaterThan(0);
          expect(created.name).toBe("Партия совместимости");
          const countsAfterCreate = tableCounts(queryScript, migratedUrl);
          expect(countDiff(countsAfterSeed, countsAfterCreate)).toEqual([
            "Batch:0->1",
            "BatchCreationCommand:0->1",
            "ChangeLog:0->1",
            "RailLot:0->1",
          ]);

          const replayed = runHistorical(testOnly, migratedUrl, "create", {
            requestId: REQUEST_ID,
            values,
          });
          expect(replayed.id).toBe(batchId);
          expect(countDiff(countsAfterCreate, tableCounts(queryScript, migratedUrl))).toEqual([]);

          const updatedValues = batchValues(materialId, "Партия совместимости обновлена");
          const updated = runHistorical(testOnly, migratedUrl, "update", {
            batchId,
            values: updatedValues,
          });
          expect(updated.id).toBe(batchId);
          expect(updated.name).toBe("Партия совместимости обновлена");
          const countsAfterUpdate = tableCounts(queryScript, migratedUrl);
          expect(countDiff(countsAfterCreate, countsAfterUpdate)).toEqual(["ChangeLog:1->2"]);

          const business = querySelects(queryScript, migratedUrl, {
            provenance: `
              SELECT (count(*))::int AS command_count,
                     (count(*) FILTER (WHERE "receiptProvenanceSnapshot" IS NULL))::int AS sql_null_count
              FROM public."BatchCreationCommand"
            `,
            batch: `
              SELECT (count(*))::int AS batch_count,
                     (count(*) FILTER (WHERE name = 'Партия совместимости обновлена'))::int AS updated_count
              FROM public."Batch"
            `,
            settings: `
              SELECT count(*)::int AS setting_count
              FROM public."Setting"
            `,
            movements: `SELECT (count(*))::int AS movement_count FROM public."InventoryMovement"`,
          });
          expect(business.provenance).toEqual([{ command_count: 1, sql_null_count: 1 }]);
          expect(business.batch).toEqual([{ batch_count: 1, updated_count: 1 }]);
          expect(business.settings).toEqual([{ setting_count: 0 }]);
          expect(business.movements).toEqual([{ movement_count: 0 }]);
          assertP1Schema(queryScript, migratedUrl);
          expect(tableCounts(queryScript, migratedUrl).get("_prisma_migrations")).toBe(
            EXPECTED_MIGRATION_SQL_COUNT,
          );

          const second = executeDisposableApply(attestationFor(migrated), {
            git: createRepoGitSource(process.cwd()),
            destinationRoot: path.join(runtime, "p1-repeat"),
            lockPath: path.join(runtime, "p1-repeat.lock"),
            parentEnv,
            readHistory: () =>
              disposableEvidenceFromQueries(queryOwned(queryScript, migratedUrl)).history,
            readSchema: () =>
              disposableEvidenceFromQueries(queryOwned(queryScript, migratedUrl)).schema,
            probeIdentity: () => identityFrom(queryOwned(queryScript, migratedUrl)),
            spawnPrisma: () => {
              spawns += 1;
              return { status: 1, signal: null };
            },
          });
          expect(second).toEqual({
            verdict: "ALREADY_APPLIED",
            code: "P1_APPLIED",
            spawned: false,
            retryAttempted: false,
          });
          expect(spawns).toBe(1);
        } catch (error) {
          failure = error;
        } finally {
          await fixture?.$disconnect().catch(() => undefined);
          try {
            removeOwnedDisposableContainer(owned);
          } catch (error) {
            failure ??= error;
          }
          fs.rmSync(queryScript, { force: true });
          for (let attempt = 0; attempt < 10; attempt += 1) {
            try {
              fs.rmSync(runtime, { recursive: true, force: true });
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
        }
        if (failure) throw failure;
      },
      480_000,
    );

    it(
      "applies P1 through the migration-only path while the historical application stays loaded",
      async () => {
        const owned = createOwnedDisposableContainer();
        const runtime = fs.mkdtempSync(path.join(process.cwd(), ".p1-historical-runtime-"));
        const queryScript = writeQueryChild(path.join(process.cwd(), "node_modules", ".cache"));
        const sharedClient = path.join(process.cwd(), "node_modules", ".prisma", "client", "index.d.ts");
        const sharedClientBefore = fs.readFileSync(sharedClient);
        let fixture: PrismaClient | null = null;
        let failure: unknown;
        try {
          expect(owned.host).toBe("127.0.0.1");
          expect(owned.user).toBe("p1disp");
          expect(owned.databaseName.startsWith("p1disp_")).toBe(true);
          const ready = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, ready)).toBe(true);
          fixture = new PrismaClient({ datasourceUrl: ownedUrl(ready) });
          await waitUntilReady(fixture);
          await fixture.$disconnect();
          fixture = null;

          fs.mkdirSync(runtime, { recursive: true });
          const historicalSchema = materializeHistorical(path.join(runtime, "migrations"));
          const historical = reconfirmOwnedContainer(owned);
          expect(deployPrisma(historicalSchema, ownedUrl(historical)).status).toBe(0);
          const identified = reconfirmOwnedContainer(owned);
          fixture = new PrismaClient({ datasourceUrl: ownedUrl(identified) });
          await installIdentity(fixture, identified);
          await fixture.$disconnect();
          fixture = null;

          const before = reconfirmOwnedContainer(owned);
          const beforeUrl = ownedUrl(before);
          const beforeEvidence = disposableEvidenceFromQueries(queryOwned(queryScript, beforeUrl));
          expect(beforeEvidence.history).toHaveLength(EXPECTED_HISTORICAL_MIGRATION_COUNT);
          expect(beforeEvidence.schema.column).toBeNull();

          const appRoot = path.join(runtime, "app");
          extractHistorical(appRoot);
          const purchasesPath = path.join(appRoot, "src", "server", "purchases.ts");
          const schemaPath = path.join(appRoot, "prisma", "schema.prisma");
          const purchasesBlob = gitBlob(purchasesPath);
          expect(purchasesBlob).toBe(gitBlobAt("src/server/purchases.ts"));
          expect(gitBlob(schemaPath)).toBe(gitBlobAt("prisma/schema.prisma"));
          fs.mkdirSync(path.join(appRoot, "node_modules", "@prisma"), { recursive: true });
          fs.cpSync(path.join(process.cwd(), "node_modules", "prisma"), path.join(appRoot, "node_modules", "prisma"), {
            recursive: true,
            dereference: true,
          });
          fs.cpSync(
            path.join(process.cwd(), "node_modules", "@prisma", "client"),
            path.join(appRoot, "node_modules", "@prisma", "client"),
            { recursive: true, dereference: true },
          );
          const generated = generateHistoricalClient(appRoot, schemaPath, beforeUrl);
          expect(generated.status, generated.detail).toBe(0);
          if (!fs.readFileSync(sharedClient).equals(sharedClientBefore)) {
            throw new Error("shared prisma client types were replaced");
          }
          expect(clientIdentity(appRoot, beforeUrl)).toBe("HISTORICAL_CLIENT");
          const testOnly = path.join(appRoot, "test-only");
          fs.mkdirSync(testOnly, { recursive: true });
          fs.writeFileSync(path.join(testOnly, "admin-shim.ts"), AUTH_SHIM);
          fs.writeFileSync(path.join(testOnly, "runner.ts"), RUNNER);
          fs.writeFileSync(path.join(testOnly, "entry.cjs"), ENTRY);
          const shimPath = path.join(testOnly, "admin-shim.ts");
          const built = await esbuild.build({
            absWorkingDir: appRoot,
            entryPoints: [path.join(testOnly, "runner.ts")],
            outfile: path.join(testOnly, "historical-app.cjs"),
            bundle: true,
            platform: "node",
            format: "cjs",
            packages: "external",
            metafile: true,
            logLevel: "silent",
            plugins: [
              {
                name: "historical-alias",
                setup(build) {
                  build.onResolve({ filter: /^@\// }, (args) => {
                    if (args.path === "@/server/session") return { path: shimPath };
                    const base = path.join(appRoot, "src", args.path.slice(2));
                    const found = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((item) =>
                      fs.existsSync(item),
                    );
                    if (!found) return { errors: [{ text: `missing historical import ${args.path}` }] };
                    return { path: found };
                  });
                },
              },
            ],
          });
          const inputs = Object.keys(built.metafile?.inputs ?? {}).map((item) => item.replaceAll("\\", "/"));
          expect(inputs.some((item) => item.includes("psr-p3"))).toBe(false);
          expect(namedContainers("stell22-app")).toBe("");
          expect(namedContainers("stell22-caddy")).toBe("");

          const seeded = runHistorical(testOnly, beforeUrl, "seed", {});
          const materialId = String(seeded.materialId ?? "");
          expect(materialId.length).toBeGreaterThan(0);

          const parentEnv = { ...process.env, DATABASE_URL: "postgresql://blocked.example/stell22" };
          const depsFor = (url: string, spawn: ApplySpawn) => ({
            git: createRepoGitSource(process.cwd()),
            destinationRoot: path.join(runtime, `p1-${spawn.label}`),
            lockPath: path.join(runtime, `p1-${spawn.label}.lock`),
            parentEnv,
            readHistory: () =>
              spawn.history ?? disposableEvidenceFromQueries(queryOwned(queryScript, url)).history,
            readSchema: () => disposableEvidenceFromQueries(queryOwned(queryScript, url)).schema,
            probeIdentity: () => identityFrom(queryOwned(queryScript, url)),
            spawnPrisma: spawn.run,
          });
          let spawns = 0;
          const confirmed = reconfirmOwnedContainer(owned);
          const confirmedUrl = ownedUrl(confirmed);
          const wrong = executeP1OnlyMigration(
            { ...attestationFor(confirmed), containerId: "b".repeat(64) },
            depsFor(confirmedUrl, {
              label: "wrong-target",
              run: () => {
                spawns += 1;
                return { status: 1, signal: null };
              },
            }),
          );
          expect(wrong.code).toBe("DISPOSABLE_IDENTITY_MISMATCH");
          expect(wrong.spawned).toBe(false);
          const damagedHistory = disposableEvidenceFromQueries(queryOwned(queryScript, confirmedUrl)).history.map(
            (row) => ({ ...row, checksum: "0".repeat(64) }),
          );
          const damaged = executeP1OnlyMigration(
            attestationFor(confirmed),
            depsFor(confirmedUrl, {
              label: "bad-checksum",
              history: damagedHistory,
              run: () => {
                spawns += 1;
                return { status: 1, signal: null };
              },
            }),
          );
          expect(damaged.code).toBe("UNEXPECTED_CHECKSUM");
          expect(damaged.spawned).toBe(false);
          const incomplete = executeP1OnlyMigration(
            attestationFor(confirmed),
            depsFor(confirmedUrl, {
              label: "incomplete-history",
              history: disposableEvidenceFromQueries(queryOwned(queryScript, confirmedUrl)).history.slice(1),
              run: () => {
                spawns += 1;
                return { status: 1, signal: null };
              },
            }),
          );
          expect(incomplete.code).toBe("OTHER_PENDING_MIGRATION");
          expect(incomplete.spawned).toBe(false);
          expect(spawns).toBe(0);
          expect(
            disposableEvidenceFromQueries(queryOwned(queryScript, confirmedUrl)).history,
          ).toHaveLength(EXPECTED_HISTORICAL_MIGRATION_COUNT);

          let prismaDetail = "";
          const first = executeP1OnlyMigration(
            attestationFor(confirmed),
            depsFor(confirmedUrl, {
              label: "apply",
              run: (request) => {
                spawns += 1;
                const target = new URL(String(request.env.DATABASE_URL));
                const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
                const targetOk =
                  target.hostname === "127.0.0.1" &&
                  target.port === String(confirmed.port) &&
                  target.username === "p1disp" &&
                  database === confirmed.databaseName &&
                  !Object.values(request.env).some((value) => String(value).includes("blocked.example"));
                if (!targetOk || request.args[0] !== "migrate" || request.args[1] !== "deploy") {
                  prismaDetail = "refusing prisma target";
                  return { status: 1, signal: null };
                }
                const result = runPrisma(request.args, request.cwd, request.env);
                prismaDetail = result.detail || "no prisma text";
                return result;
              },
            }),
          );
          if (first.verdict !== "ALREADY_APPLIED") {
            throw new Error(postApplySummary(queryScript, confirmedUrl, first, prismaDetail));
          }
          expect(first.appContainerReplaced).toBe(false);
          expect(first.applicationSha).toBe(HISTORICAL_APPLICATION_COMMIT);
          expect(first.migrationOnly).toBe(true);
          expect(spawns).toBe(1);
          expect(gitBlob(purchasesPath)).toBe(purchasesBlob);
          expect(namedContainers("stell22-app")).toBe("");
          expect(namedContainers("stell22-caddy")).toBe("");
          assertP1Schema(queryScript, confirmedUrl);

          const values = batchValues(materialId, "Партия только P1");
          const created = runHistorical(testOnly, confirmedUrl, "create", {
            requestId: "p1-only-rollout-request-1",
            values,
          });
          const batchId = String(created.id ?? "");
          const replayed = runHistorical(testOnly, confirmedUrl, "create", {
            requestId: "p1-only-rollout-request-1",
            values,
          });
          expect(replayed.id).toBe(batchId);
          const updated = runHistorical(testOnly, confirmedUrl, "update", {
            batchId,
            values: batchValues(materialId, "Партия только P1 обновлена"),
          });
          expect(updated.name).toBe("Партия только P1 обновлена");
          const business = querySelects(queryScript, confirmedUrl, {
            provenance: `
              SELECT (count(*))::int AS command_count,
                     (count(*) FILTER (WHERE "receiptProvenanceSnapshot" IS NULL))::int AS sql_null_count
              FROM public."BatchCreationCommand"
            `,
            batch: `
              SELECT (count(*))::int AS updated_count
              FROM public."Batch"
              WHERE name = 'Партия только P1 обновлена'
            `,
            settings: `
              SELECT count(*)::int AS setting_count
              FROM public."Setting"
            `,
          });
          expect(business.provenance).toEqual([{ command_count: 1, sql_null_count: 1 }]);
          expect(business.batch).toEqual([{ updated_count: 1 }]);
          expect(business.settings).toEqual([{ setting_count: 0 }]);

          const second = executeP1OnlyMigration(
            attestationFor(reconfirmOwnedContainer(owned)),
            depsFor(confirmedUrl, {
              label: "repeat",
              run: () => {
                spawns += 1;
                return { status: 1, signal: null };
              },
            }),
          );
          expect(second).toMatchObject({
            verdict: "ALREADY_APPLIED",
            code: "P1_APPLIED",
            spawned: false,
            retryAttempted: false,
            appContainerReplaced: false,
          });
          expect(spawns).toBe(1);
          expect(tableCounts(queryScript, confirmedUrl).get("_prisma_migrations")).toBe(
            EXPECTED_MIGRATION_SQL_COUNT,
          );
        } catch (error) {
          failure = error;
        } finally {
          await fixture?.$disconnect().catch(() => undefined);
          try {
            removeOwnedDisposableContainer(owned);
          } catch (error) {
            failure ??= error;
          }
          fs.rmSync(queryScript, { force: true });
          for (let attempt = 0; attempt < 10; attempt += 1) {
            try {
              fs.rmSync(runtime, { recursive: true, force: true });
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          }
        }
        if (failure) throw failure;
      },
      480_000,
    );
  },
);

type ApplySpawn = {
  label: string;
  history?: ReturnType<typeof disposableEvidenceFromQueries>["history"];
  run: (request: {
    args: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
    cwd: string;
  }) => { status: number | null; signal: NodeJS.Signals | null };
};

function namedContainers(name: string): string {
  const listed = spawnSync("docker", ["ps", "-aq", "--filter", `name=${name}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (listed.status !== 0) throw new Error("docker container list failed");
  return listed.stdout.trim();
}

function assertP1Schema(script: string, url: string): void {
  const evidence = disposableEvidenceFromQueries(queryOwned(script, url));
  expect(evidence.history).toHaveLength(EXPECTED_MIGRATION_SQL_COUNT);
  expect(finishedNames(evidence.history)).toEqual(
    [...HISTORICAL_MIGRATION_NAMES, P1_MIGRATION_NAME].sort(),
  );
  const p1 = evidence.history.find((row) => row.migrationName === P1_MIGRATION_NAME);
  expect(p1?.checksum).toBe(P1_SHA256);
  const column = evidence.schema.column;
  const check = evidence.schema.check;
  const functionDef = evidence.schema.functionDef;
  const trigger = evidence.schema.trigger;
  if (!column || !check || !functionDef || !trigger) {
    throw new Error("P1 schema evidence is incomplete");
  }
  expect(column.isNullable).toBe("YES");
  expect(column.columnDefault).toBeNull();
  expect(column.dataType).toBe("jsonb");
  expect(columnMatchesContract(column)).toBe(true);
  expect(checkMatchesContract(check)).toBe(true);
  expect(functionMatchesContract(functionDef)).toBe(true);
  expect(trigger.enabled).toBe("O");
  expect(triggerMatchesContract(trigger)).toBe(true);
  expect(evidence.schema.foreignKeyCount).toBe(0);
}

function extractHistorical(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  const tarPath = path.join(root, "source.tar");
  const archived = spawnSync(
    "git",
    ["archive", "--format=tar", "-o", tarPath, HISTORICAL_APPLICATION_COMMIT],
    { cwd: process.cwd(), encoding: "utf8", windowsHide: true },
  );
  if (archived.status !== 0) throw new Error("historical archive failed");
  const extracted = spawnSync(
    "python",
    [
      "-c",
      "import tarfile, sys\nwith tarfile.open(sys.argv[1], 'r') as archive:\n    archive.extractall(sys.argv[2], filter='data')\n",
      tarPath,
      root,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (extracted.status !== 0) throw new Error("historical extract failed");
  fs.rmSync(tarPath, { force: true });
}

function gitBlob(file: string): string {
  const child = spawnSync("git", ["hash-object", file], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (child.status !== 0) throw new Error("historical file hash failed");
  return child.stdout.trim();
}

function gitBlobAt(file: string): string {
  const child = spawnSync("git", ["rev-parse", `${HISTORICAL_APPLICATION_COMMIT}:${file}`], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (child.status !== 0) throw new Error("historical git blob failed");
  return child.stdout.trim();
}

function generateHistoricalClient(
  root: string,
  schemaPath: string,
  url: string,
): { status: number | null; detail: string } {
  const wrapper = path.join(root, "test-only", "generate.cjs");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(
    wrapper,
    `process.env.PRISMA_GENERATE_SKIP_AUTOINSTALL = "1";
delete process.env.DATABASE_URL;
const { spawnSync } = require("node:child_process");
const child = spawnSync(process.execPath, [process.argv[2], "generate", "--schema", process.argv[3]], {
  cwd: process.argv[4],
  env: process.env,
  encoding: "utf8",
  windowsHide: true,
});
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
process.exit(child.status === null ? 1 : child.status);
`,
  );
  const cli = path.join(root, "node_modules", "prisma", "build", "index.js");
  const env = buildChildEnv(
    { ...process.env, DATABASE_URL: "postgresql://blocked.example/stell22" },
    url,
  );
  const child = spawnSync(process.execPath, [wrapper, cli, schemaPath, root], {
    cwd: root,
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const detail = redact(`${child.stdout ?? ""}\n${child.stderr ?? ""}`, env.DATABASE_URL)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /error|generated|EPERM|P\d{4}/i.test(line))
    .slice(0, 6)
    .join(" | ")
    .slice(0, 500);
  return { status: child.status, detail };
}

function clientIdentity(root: string, url: string): string {
  const script = path.join(root, "test-only", "client-identity.cjs");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    `
      const { Prisma } = require("@prisma/client");
      const model = Prisma.dmmf.datamodel.models.find((item) => item.name === "BatchCreationCommand");
      const names = model.fields.map((field) => field.name);
      process.stdout.write(names.includes("receiptProvenanceSnapshot") ? "HAS_P1_FIELD" : "HISTORICAL_CLIENT");
    `,
  );
  const child = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: buildChildEnv({ ...process.env, DATABASE_URL: "postgresql://blocked.example/stell22" }, url) as NodeJS.ProcessEnv,
  });
  if (child.status !== 0) throw new Error("historical client identity failed");
  if (child.stdout.includes("postgresql://") || child.stderr.includes("postgresql://")) {
    throw new Error("historical client identity leaked a url");
  }
  return child.stdout.trim();
}

function runHistorical(
  testOnly: string,
  url: string,
  mode: string,
  payload: unknown,
): Record<string, unknown> {
  const payloadPath = path.join(testOnly, `payload-${mode}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify(payload));
  const env = buildChildEnv(
    { ...process.env, DATABASE_URL: "postgresql://blocked.example/stell22" },
    url,
  );
  const target = new URL(env.DATABASE_URL);
  if (target.hostname !== "127.0.0.1" || target.username !== "p1disp" || env.DATABASE_URL.includes("blocked.example")) {
    throw new Error("refusing historical child target");
  }
  const child = spawnSync(process.execPath, [path.join(testOnly, "entry.cjs"), mode, payloadPath], {
    cwd: path.dirname(testOnly),
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: env as NodeJS.ProcessEnv,
  });
  fs.rmSync(payloadPath, { force: true });
  const secret = env.DATABASE_URL;
  const stdout = redact(child.stdout ?? "", secret);
  const stderr = redact(child.stderr ?? "", secret);
  if (stdout.includes("postgresql://") || stderr.includes("postgresql://") || stderr.includes(secret)) {
    throw new Error("historical child leaked a connection string");
  }
  if (child.status !== 0) throw new Error(stderr.slice(0, 800) || "historical child failed");
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("historical child response is not an object");
  }
  return parsed as Record<string, unknown>;
}

function querySelects(
  script: string,
  url: string,
  queries: Record<string, string>,
): Record<string, unknown[]> {
  const file = path.join(path.dirname(script), `p1-old-app-select-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(queries));
  try {
    const child = spawnSync(process.execPath, [script, file], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: buildChildEnv(process.env, url) as NodeJS.ProcessEnv,
    });
    if (child.status !== 0) throw new Error("owned select failed");
    const parsed: unknown = JSON.parse(child.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("owned select response is not an object");
    }
    return parsed as Record<string, unknown[]>;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function tableCounts(script: string, url: string): Map<string, number> {
  const rows = querySelects(script, url, {
    counts: `
      SELECT c.relname AS table_name,
             (xpath('/row/c/text()', query_to_xml(format('select count(*)::bigint as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text AS row_count
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `,
  }).counts;
  const counts = new Map<string, number>();
  if (!Array.isArray(rows)) throw new Error("table count response is missing");
  for (const row of rows) {
    if (!row || typeof row !== "object") throw new Error("table count row is missing");
    const record = row as { table_name?: unknown; row_count?: unknown };
    if (typeof record.table_name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(record.table_name)) {
      throw new Error("unexpected table name");
    }
    counts.set(record.table_name, Number(record.row_count));
  }
  return counts;
}

function countDiff(before: Map<string, number>, after: Map<string, number>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  const changes: string[] = [];
  for (const name of names) {
    const left = before.get(name) ?? 0;
    const right = after.get(name) ?? 0;
    if (left !== right) changes.push(`${name}:${left}->${right}`);
  }
  return changes.sort();
}

function batchValues(materialId: string, name: string) {
  return {
    name,
    materialId,
    purchaseDate: "2026-10-01",
    sectionWidthMm: null,
    sectionHeightMm: null,
    purchaseCost: 1000,
    priceSort1: 100,
    priceSort2: 50,
    note: "",
    rails: [
      {
        mode: "package",
        lengthM: 2,
        railType: "POLKA",
        sort: "SORT1",
        quantity: 4,
        rows: 2,
        layers: 2,
      },
    ],
  };
}

function redact(text: string, secret: string): string {
  return text
    .split(secret)
    .join("[redacted]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]")
    .replace(/p1disp_[0-9a-f]+/gi, "[database]")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:[port]");
}
