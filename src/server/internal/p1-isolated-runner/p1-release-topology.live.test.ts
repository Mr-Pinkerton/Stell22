import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PrismaClient } from "@prisma/client";
import esbuild from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { HISTORICAL_MIGRATION_NAMES } from "@/server/internal/p1-isolated-runner/classify";
import {
  createOwnedDisposableContainer,
  reconfirmOwnedContainer,
  removeOwnedDisposableContainer,
  type OwnedContainerHandle,
} from "@/server/internal/p1-isolated-runner/container-origin";
import {
  EXPECTED_HISTORICAL_MIGRATION_COUNT,
  EXPECTED_MIGRATION_SQL_COUNT,
  HISTORICAL_APPLICATION_COMMIT,
  P1_MIGRATION_NAME,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import {
  deployPrisma,
  finishedNames,
  installIdentity,
  materializeHistorical,
  ownedUrl,
  queryOwned,
  sameTarget,
  waitUntilReady,
  writeQueryChild,
} from "@/server/internal/p1-isolated-runner/disposable-migration-harness";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import { disposableEvidenceFromQueries } from "@/server/internal/p1-isolated-runner/live-read-probe";
import {
  AUTH_SHIM,
  ENTRY,
  RUNNER,
  batchValues,
  clientIdentity,
  countDiff,
  extractHistorical,
  generateHistoricalClient,
  querySelects,
  runHistorical,
  tableCounts,
} from "@/server/internal/p1-isolated-runner/old-app-compatibility.live.test";
import { attachReviewedImageToOperatorTag, buildReviewedOneShotImage, releaseOwnedOperatorTag } from "@/server/internal/p1-isolated-runner/oneshot-recipe-build";
import {
  assessWriterDeployPrerequisite,
  ONE_SHOT_BASE_IMAGE,
  logicalSchemaFingerprint,
  migrationHistoryFingerprint,
  sha256Bytes,
  type CatalogProbe,
  type ContainerIdentity,
  type TopologyObservation,
} from "@/server/internal/p1-isolated-runner/p1-release-gate";
import { executeP1OnlyRelease } from "@/server/internal/p1-isolated-runner/p1-release-execute";
import {
  checkMatchesContract,
  columnMatchesContract,
  functionMatchesContract,
  triggerMatchesContract,
} from "@/server/internal/p1-isolated-runner/schema-contract";

const LIVE_FLAG = "P1_DISPOSABLE_LIVE";
const REQUEST_ID = "p1-release-topology-request-1";

describe.skipIf(process.env[LIVE_FLAG] !== "1")("isolated P1-only release topology", () => {
  afterAll(() => {
    releaseOwnedOperatorTag();
  });
  it(
    "applies pinned P1 beside a historical application container and leaves that container unchanged",
    async () => {
      const attemptId = randomBytes(8).toString("hex");
      const networkName = `p1rel-${attemptId}`;
      const appName = `p1rel-app-${attemptId}`;
      const imageTag = `p1rel-image:${attemptId}`;
      const owned = createOwnedDisposableContainer();
      const restored = createOwnedDisposableContainer();
      const runtime = fs.mkdtempSync(path.join(process.cwd(), ".p1-release-runtime-"));
      const queryScript = writeQueryChild(path.join(process.cwd(), "node_modules", ".cache"));
      const sharedClient = path.join(process.cwd(), "node_modules", ".prisma", "client", "index.d.ts");
      const sharedClientBefore = fs.readFileSync(sharedClient);
      let fixture: PrismaClient | null = null;
      let failure: unknown;
      let appStarted = false;
      let networkStarted = false;
      try {
        ensureNodeImage();
        const ready = reconfirmOwnedContainer(owned);
        expect(sameTarget(owned, ready)).toBe(true);
        fixture = new PrismaClient({ datasourceUrl: ownedUrl(ready) });
        await waitUntilReady(fixture);
        await fixture.$disconnect();
        fixture = null;

        const historicalSchema = materializeHistorical(path.join(runtime, "historical"));
        const historical = reconfirmOwnedContainer(owned);
        const historicalDeploy = deployPrisma(historicalSchema, ownedUrl(historical));
        expect(historicalDeploy.status, historicalDeploy.detail).toBe(0);

        const identified = reconfirmOwnedContainer(owned);
        fixture = new PrismaClient({ datasourceUrl: ownedUrl(identified) });
        await installIdentity(fixture, identified);
        await fixture.$disconnect();
        fixture = null;

        const sourceUrl = ownedUrl(reconfirmOwnedContainer(owned));
        const before = disposableEvidenceFromQueries(queryOwned(queryScript, sourceUrl));
        expect(finishedNames(before.history)).toEqual([...HISTORICAL_MIGRATION_NAMES].sort());
        expect(before.history).toHaveLength(EXPECTED_HISTORICAL_MIGRATION_COUNT);
        expect(
          assessWriterDeployPrerequisite({ history: before.history, schema: before.schema }).allow,
        ).toBe(false);
        expect(writerVerdict(owned.containerName, owned.databaseName)).toBe("P1_BLOCKED");

        docker(["network", "create", networkName]);
        networkStarted = true;
        docker(["network", "connect", networkName, owned.containerName]);
        const connected = reconfirmOwnedContainer(owned);
        expect(sameTarget(owned, connected)).toBe(true);

        const context = path.join(runtime, "image");
        fs.mkdirSync(context);
        fs.writeFileSync(path.join(context, "docker-entrypoint.sh"), gitBytes("docker-entrypoint.sh"));
        fs.writeFileSync(path.join(context, "package.json"), gitBytes("package.json"));
        expect(gitHash(path.join(context, "docker-entrypoint.sh"))).toBe(gitBlobAt("docker-entrypoint.sh"));
        fs.writeFileSync(
          path.join(context, "health.js"),
          [
            'const http = require("http");',
            "const server = http.createServer((request, response) => {",
            '  response.writeHead(200, { "content-type": "text/plain", "content-length": "2", connection: "close" });',
            '  response.end("ok");',
            "});",
            'server.listen(3000, "0.0.0.0");',
            "",
          ].join("\n"),
        );
        fs.writeFileSync(
          path.join(context, "Dockerfile"),
          [
            "FROM node:22-bookworm-slim",
            "WORKDIR /app",
            "COPY docker-entrypoint.sh package.json health.js ./",
            'ENTRYPOINT ["node", "/app/health.js"]',
            "",
          ].join("\n"),
        );
        docker(["build", "-t", imageTag, context]);
        docker([
          "run",
          "-d",
          "--pull",
          "never",
          "--name",
          appName,
          "--network",
          networkName,
          "--restart",
          "no",
          "-p",
          "127.0.0.1::3000",
          imageTag,
        ]);
        appStarted = true;
        const appBefore = inspectContainer(appName);
        const dbBefore = inspectContainer(owned.containerName);
        expect(appBefore.entrypoint.join(" ")).toBe("node /app/health.js");
        expect(appBefore.entrypoint.join(" ")).not.toContain("docker-entrypoint.sh");
        const healthPort = docker(["port", appName, "3000/tcp"]).trim();
        expect(await readHealth(healthPort)).toBe("ok");

        const archivePath = path.join(runtime, "backup.sql.gz");
        const dumped = spawnSync(
          "docker",
          ["exec", owned.containerName, "pg_dump", "-U", "p1disp", "--no-owner", "--no-acl", owned.databaseName],
          { maxBuffer: 64 * 1024 * 1024 },
        );
        if (dumped.status !== 0) throw new Error("pg_dump failed");
        fs.writeFileSync(archivePath, zlib.gzipSync(dumped.stdout));
        const archiveHash = sha256Bytes(fs.readFileSync(archivePath));

        const restoredReady = reconfirmOwnedContainer(restored);
        fixture = new PrismaClient({ datasourceUrl: ownedUrl(restoredReady) });
        await waitUntilReady(fixture);
        await fixture.$disconnect();
        fixture = null;
        const restore = spawnSync(
          "docker",
          ["exec", "-i", restored.containerName, "psql", "-U", "p1disp", "-d", restored.databaseName, "-v", "ON_ERROR_STOP=1"],
          { input: zlib.gunzipSync(fs.readFileSync(archivePath)), maxBuffer: 64 * 1024 * 1024 },
        );
        expect(restore.status).toBe(0);
        const liveCatalog = readCatalog(queryScript, sourceUrl);
        const restoredCatalog = readCatalog(queryScript, ownedUrl(reconfirmOwnedContainer(restored)));
        expect(restoredCatalog).toEqual(liveCatalog);
        expect(liveCatalog.successfulMigrationCount).toBe(EXPECTED_HISTORICAL_MIGRATION_COUNT);
        expect(liveCatalog.failedMigrationCount).toBe(0);
        expect(sha256Bytes(fs.readFileSync(archivePath))).toBe(archiveHash);

        const declared = observation(attemptId, appBefore, dbBefore, owned);
        let spawns = 0;
        let oneShotDetail = "";
        const nodeModules = fs.realpathSync.native(path.join(process.cwd(), "node_modules"));
        const first = executeP1OnlyRelease(
          {
            attemptId,
            declared,
            databasePassword: owned.password,
            recoveryClaim: { attemptId, archiveSha256: archiveHash },
          },
          {
            git: createRepoGitSource(process.cwd()),
            destinationRoot: path.join(runtime, "sealed"),
            lockPath: path.join(runtime, "release.lock"),
            readHistory: () => disposableEvidenceFromQueries(queryOwned(queryScript, sourceUrl)).history,
            readSchema: () => disposableEvidenceFromQueries(queryOwned(queryScript, sourceUrl)).schema,
            inspectTopology: () => observation(attemptId, inspectContainer(appName), inspectContainer(owned.containerName), owned),
            readDatabaseIdentity: () => readDatabaseIdentity(queryScript, sourceUrl),
            readArchive: () => fs.readFileSync(archivePath),
            readLiveCatalog: () => readCatalog(queryScript, sourceUrl),
            readRestoredCatalog: () => ({
              ...readCatalog(queryScript, ownedUrl(reconfirmOwnedContainer(restored))),
              exitCode: restore.status ?? 1,
            }),
            spawnOneShot: (plan) => {
              spawns += 1;
              const child = spawnSync("docker", [...plan.argv], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 180_000,
                maxBuffer: 8 * 1024 * 1024,
              });
              oneShotDetail = `${child.stdout ?? ""}\n${child.stderr ?? ""}`
                .replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]")
                .slice(0, 1200);
              return { status: child.status, signal: child.signal };
            },
          },
        );
        expect(first, oneShotDetail).toMatchObject({
          verdict: "ALREADY_APPLIED",
          code: "P1_APPLIED",
          spawned: true,
          retryAttempted: false,
          imageGitSha: "UNVERIFIED",
          appUnchanged: true,
        });
        expect(spawns).toBe(1);

        const appAfter = inspectContainer(appName);
        expect(appAfter).toEqual(appBefore);
        expect(inspectContainer(owned.containerName).id).toBe(dbBefore.id);
        expect(await readHealth(healthPort)).toBe("ok");
        const afterUrl = ownedUrl(reconfirmOwnedContainer(owned));
        const after = disposableEvidenceFromQueries(queryOwned(queryScript, afterUrl));
        expect(after.history).toHaveLength(EXPECTED_MIGRATION_SQL_COUNT);
        expect(finishedNames(after.history)).toEqual([...HISTORICAL_MIGRATION_NAMES, P1_MIGRATION_NAME].sort());
        const p1 = after.history.find((row) => row.migrationName === P1_MIGRATION_NAME);
        expect(p1?.checksum).toBe(P1_SHA256);
        expect(columnMatchesContract(requireEvidence(after.schema.column))).toBe(true);
        expect(checkMatchesContract(requireEvidence(after.schema.check))).toBe(true);
        expect(functionMatchesContract(requireEvidence(after.schema.functionDef))).toBe(true);
        expect(triggerMatchesContract(requireEvidence(after.schema.trigger))).toBe(true);
        expect(
          assessWriterDeployPrerequisite({ history: after.history, schema: after.schema }),
        ).toEqual({ allow: true, code: "P1_APPLIED" });
        expect(writerVerdict(owned.containerName, owned.databaseName)).toBe("P1_BLOCKED");

        const appRoot = path.join(runtime, "app");
        extractHistorical(appRoot);
        expect(gitHash(path.join(appRoot, "src", "server", "purchases.ts"))).toBe(
          gitBlobAt("src/server/purchases.ts"),
        );
        fs.mkdirSync(path.join(appRoot, "node_modules", "@prisma"), { recursive: true });
        fs.cpSync(path.join(nodeModules, "prisma"), path.join(appRoot, "node_modules", "prisma"), {
          recursive: true,
          dereference: true,
        });
        fs.cpSync(path.join(nodeModules, "@prisma", "client"), path.join(appRoot, "node_modules", "@prisma", "client"), {
          recursive: true,
          dereference: true,
        });
        const generated = generateHistoricalClient(appRoot, path.join(appRoot, "prisma", "schema.prisma"), afterUrl);
        expect(generated.status, generated.detail).toBe(0);
        expect(fs.readFileSync(sharedClient).equals(sharedClientBefore)).toBe(true);
        expect(clientIdentity(appRoot, afterUrl)).toBe("HISTORICAL_CLIENT");
        const testOnly = path.join(appRoot, "test-only");
        fs.mkdirSync(testOnly, { recursive: true });
        fs.writeFileSync(path.join(testOnly, "admin-shim.ts"), AUTH_SHIM);
        fs.writeFileSync(path.join(testOnly, "runner.ts"), RUNNER);
        fs.writeFileSync(path.join(testOnly, "entry.cjs"), ENTRY);
        await esbuild.build({
          absWorkingDir: appRoot,
          entryPoints: [path.join(testOnly, "runner.ts")],
          outfile: path.join(testOnly, "historical-app.cjs"),
          bundle: true,
          platform: "node",
          format: "cjs",
          packages: "external",
          logLevel: "silent",
          plugins: [
            {
              name: "historical-alias",
              setup(build) {
                build.onResolve({ filter: /^@\// }, (args) => {
                  if (args.path === "@/server/session") return { path: path.join(testOnly, "admin-shim.ts") };
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
        const seeded = runHistorical(testOnly, afterUrl, "seed", {});
        const materialId = String(seeded.materialId ?? "");
        const created = runHistorical(testOnly, afterUrl, "create", {
          requestId: REQUEST_ID,
          values: batchValues(materialId, "Партия релиза"),
        });
        const batchId = String(created.id ?? "");
        expect(batchId.length).toBeGreaterThan(0);
        const afterCreate = tableCounts(queryScript, afterUrl);
        const replayed = runHistorical(testOnly, afterUrl, "create", {
          requestId: REQUEST_ID,
          values: batchValues(materialId, "Партия релиза"),
        });
        expect(replayed.id).toBe(batchId);
        expect(countDiff(afterCreate, tableCounts(queryScript, afterUrl))).toEqual([]);
        const updated = runHistorical(testOnly, afterUrl, "update", {
          batchId,
          values: batchValues(materialId, "Партия релиза обновлена"),
        });
        expect(updated.name).toBe("Партия релиза обновлена");

        const restoredUrl = ownedUrl(reconfirmOwnedContainer(restored));
        expect(writerVerdict(restored.containerName, restored.databaseName)).toBe("P1_BLOCKED");
        const sealedSchema = path.join(runtime, "sealed", "prisma", "schema.prisma");
        const restoredDeploy = deployPrisma(sealedSchema, restoredUrl);
        expect(restoredDeploy.status, restoredDeploy.detail).toBe(0);
        // Historical sealed schema stops at 46 migrations. The guard proof needs the
        // production inventory row; the applied 47-migration database is tested separately.
        recordAdminCorrectionsChecksum(restored.containerName, restored.databaseName);
        expect(writerVerdict(restored.containerName, restored.databaseName)).toBe("P1_APPLIED");
        proveWriterRefusals(restored.containerName, restored.databaseName, queryScript, restoredUrl);

        const second = executeP1OnlyRelease(
          {
            attemptId,
            declared,
            databasePassword: owned.password,
            recoveryClaim: "RESTORE_VERIFIED",
          },
          {
            git: createRepoGitSource(process.cwd()),
            destinationRoot: path.join(runtime, "sealed-repeat"),
            lockPath: path.join(runtime, "release-repeat.lock"),
            readHistory: () => disposableEvidenceFromQueries(queryOwned(queryScript, afterUrl)).history,
            readSchema: () => disposableEvidenceFromQueries(queryOwned(queryScript, afterUrl)).schema,
            inspectTopology: () =>
              observation(attemptId, inspectContainer(appName), inspectContainer(owned.containerName), owned),
            readDatabaseIdentity: () => readDatabaseIdentity(queryScript, afterUrl),
            readArchive: () => {
              throw new Error("repeat must not read the archive");
            },
            readLiveCatalog: () => {
              throw new Error("repeat must not read the catalog");
            },
            readRestoredCatalog: () => {
              throw new Error("repeat must not read the restore");
            },
            spawnOneShot: () => {
              spawns += 1;
              return { status: 1, signal: null };
            },
          },
        );
        expect(second.spawned).toBe(false);
        expect(second.code).toBe("P1_APPLIED");
        expect(spawns).toBe(1);
        expect(inspectContainer(appName)).toEqual(appBefore);
      } catch (error) {
        failure = error;
      } finally {
        await fixture?.$disconnect().catch(() => undefined);
        if (appStarted) spawnSync("docker", ["rm", "-f", appName], { windowsHide: true });
        spawnSync("docker", ["image", "rm", "-f", imageTag], { windowsHide: true });
        try {
          removeOwnedDisposableContainer(owned);
        } catch (error) {
          failure ??= error;
        }
        try {
          removeOwnedDisposableContainer(restored);
        } catch (error) {
          failure ??= error;
        }
        if (networkStarted) spawnSync("docker", ["network", "rm", networkName], { windowsHide: true });
        fs.rmSync(queryScript, { force: true });
        fs.rmSync(runtime, { recursive: true, force: true });
      }
      if (failure) throw failure;
    },
    600_000,
  );
});

function observation(
  attemptId: string,
  app: ContainerIdentity,
  db: ContainerIdentity,
  owned: OwnedContainerHandle,
): TopologyObservation {
  return {
    attemptId,
    app,
    db,
    databaseName: owned.databaseName,
    roleName: "p1disp",
    networkName: `p1rel-${attemptId}`,
  };
}

function inspectContainer(name: string): ContainerIdentity {
  const raw = docker([
    "inspect",
    "--format",
    '{"id":"{{.Id}}","image":"{{.Image}}","name":"{{.Name}}","running":{{.State.Running}},"startedAt":"{{.State.StartedAt}}","entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}}}',
    name,
  ]);
  const parsed = JSON.parse(raw) as {
    id: string;
    image: string;
    name: string;
    running: boolean;
    startedAt: string;
    entrypoint: string[] | null;
    cmd: string[] | null;
  };
  return {
    id: normalizeId(parsed.id),
    imageId: parsed.image.startsWith("sha256:") ? parsed.image : `sha256:${normalizeId(parsed.image)}`,
    startedAt: parsed.startedAt,
    running: parsed.running,
    name: parsed.name.replace(/^\//, ""),
    entrypoint: parsed.entrypoint ?? [],
    command: parsed.cmd ?? [],
  };
}

function readCatalog(script: string, url: string): CatalogProbe {
  const rows = querySelects(script, url, {
    migrations: `
      SELECT migration_name AS name, checksum,
             (finished_at IS NOT NULL) AS finished,
             (rolled_back_at IS NOT NULL) AS "rolledBack",
             applied_steps_count AS steps
      FROM public."_prisma_migrations"
    `,
    columns: `
      SELECT n.nspname AS schema, c.relname AS "table", a.attname AS column,
             format_type(a.atttypid, a.atttypmod) AS type,
             CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
             pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS "columnDefault",
             a.attidentity AS identity,
             a.attgenerated AS generated,
             CASE WHEN a.attcollation = 0 THEN NULL ELSE col.collname END AS collation
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      LEFT JOIN pg_catalog.pg_collation col ON col.oid = a.attcollation
      WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r'
    `,
    constraints: `
      SELECT n.nspname AS schema, c.relname AS "table", con.conname AS name,
             con.contype::text AS type, con.convalidated AS validated,
             con.condeferrable AS deferrable,
             con.condeferred AS "initiallyDeferred",
             pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
      FROM pg_catalog.pg_constraint con
      JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
    `,
    counts: `
      SELECT
        (SELECT count(*)::int FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r') AS public_table_count,
        (SELECT count(*)::int FROM public."_prisma_migrations"
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count = 1) AS successful_migration_count,
        (SELECT count(*)::int FROM public."_prisma_migrations"
          WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS failed_migration_count,
        (SELECT count(*)::int FROM public."User") AS user_row_count
    `,
  });
  const counts = oneRow(rows.counts, "counts");
  return {
    migrationFingerprint: migrationHistoryFingerprint(
      (rows.migrations ?? []).map((row) => {
        const record = recordOf(row);
        return {
          name: text(record.name),
          checksum: text(record.checksum),
          finished: bool(record.finished),
          rolledBack: bool(record.rolledBack),
          steps: Number(record.steps),
        };
      }),
    ),
    logicalSchemaFingerprint: logicalSchemaFingerprint({
      columns: (rows.columns ?? []).map((row) => {
        const record = recordOf(row);
        return {
          schema: text(record.schema),
          table: text(record.table),
          column: text(record.column),
          type: text(record.type),
          nullable: text(record.nullable),
          columnDefault: optionalText(record.columnDefault),
          identity: text(record.identity),
          generated: text(record.generated),
          collation: optionalText(record.collation),
        };
      }),
      constraints: (rows.constraints ?? []).map((row) => {
        const record = recordOf(row);
        return {
          schema: text(record.schema),
          table: text(record.table),
          name: text(record.name),
          type: text(record.type),
          validated: bool(record.validated),
          deferrable: bool(record.deferrable),
          initiallyDeferred: bool(record.initiallyDeferred),
          definition: text(record.definition),
        };
      }),
    }),
    publicTableCount: Number(counts.public_table_count),
    successfulMigrationCount: Number(counts.successful_migration_count),
    failedMigrationCount: Number(counts.failed_migration_count),
    userRowCount: Number(counts.user_row_count),
  };
}

function readDatabaseIdentity(script: string, url: string): { databaseName: string; roleName: string } {
  const rows = querySelects(script, url, {
    identity: "SELECT current_database() AS database_name, current_user AS role_name",
  });
  const row = oneRow(rows.identity, "identity");
  return { databaseName: text(row.database_name), roleName: text(row.role_name) };
}

async function readHealth(port: string): Promise<string> {
  let last = "no response";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await fetch(`http://${port}`);
      return await response.text();
    } catch (error) {
      last = error instanceof Error ? error.message : "health failed";
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(last);
}

function ensureNodeImage(): void {
  const present = spawnSync("docker", ["image", "inspect", ONE_SHOT_BASE_IMAGE], { windowsHide: true });
  if (present.status !== 0) {
    const pulled = spawnSync("docker", ["pull", ONE_SHOT_BASE_IMAGE], {
      windowsHide: true,
      timeout: 180_000,
    });
    if (pulled.status !== 0) throw new Error(`${ONE_SHOT_BASE_IMAGE} is unavailable`);
  }
  const built = buildReviewedOneShotImage();
  try {
    attachReviewedImageToOperatorTag(built);
  } finally {
    built.remove();
  }
}

function docker(args: readonly string[]): string {
  const child = spawnSync("docker", [...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(`${args[0] ?? "docker"} failed: ${(child.stderr || child.stdout).slice(0, 500)}`);
  }
  return child.stdout.trim();
}

function gitBytes(file: string): Buffer {
  const child = spawnSync("git", ["show", `${HISTORICAL_APPLICATION_COMMIT}:${file}`], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  if (child.status !== 0) throw new Error(`historical ${file} missing`);
  return child.stdout;
}

function gitHash(file: string): string {
  const child = spawnSync("git", ["hash-object", file], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (child.status !== 0) throw new Error("hash-object failed");
  return child.stdout.trim();
}

function gitBlobAt(file: string): string {
  const child = spawnSync("git", ["rev-parse", `${HISTORICAL_APPLICATION_COMMIT}:${file}`], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (child.status !== 0) throw new Error("historical blob missing");
  return child.stdout.trim();
}

function normalizeId(value: string): string {
  const hex = value.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("container id is not 64 hex");
  return hex;
}

function requireEvidence<T>(value: T | null): T {
  if (value === null) throw new Error("P1 schema evidence is incomplete");
  return value;
}

function oneRow(value: unknown[] | undefined, label: string): Record<string, unknown> {
  if (!value || value.length !== 1) throw new Error(`${label} row is missing`);
  return recordOf(value[0]);
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("row is missing");
  return value as Record<string, unknown>;
}

function recordAdminCorrectionsChecksum(containerName: string, databaseName: string): void {
  psql(
    containerName,
    databaseName,
    `INSERT INTO public."_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
     VALUES ('p1-writer-gate-47', 'd8d83b48d536bd42cb9f394958dc981003d43da5b5904bcecadd3899b179f834', NOW(), '20261025120000_admin_corrections_batch_and_cancel', NOW(), 1);`,
  );
}

function writerVerdict(containerName: string, databaseName: string): string {
  const sql = fs.readFileSync(path.join(process.cwd(), "scripts", "p1-writer-preflight.sql"), "utf8");
  const child = spawnSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "p1disp", "-d", databaseName, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-f", "-"],
    { input: sql, encoding: "utf8", windowsHide: true },
  );
  if (child.status !== 0) throw new Error("writer preflight query failed");
  return child.stdout.replace(/\s/g, "");
}

function proveWriterRefusals(containerName: string, databaseName: string, script: string, url: string): void {
  const originals = querySelects(script, url, {
    check: `
      SELECT pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
      FROM pg_catalog.pg_constraint AS con
      JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'BatchCreationCommand'
        AND con.conname = 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
    `,
    fn: `
      SELECT pg_catalog.pg_get_functiondef(p.oid) AS definition
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'batch_creation_command_provenance_guard'
    `,
    tg: `
      SELECT pg_catalog.pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_catalog.pg_trigger AS t
      JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'BatchCreationCommand'
        AND NOT t.tgisinternal AND t.tgname = 'batch_creation_command_provenance_guard'
    `,
  });
  const checkDef = text(oneRow(originals.check, "check").definition);
  const functionDef = text(oneRow(originals.fn, "function").definition);
  const triggerDef = text(oneRow(originals.tg, "trigger").definition);

  psql(
    containerName,
    databaseName,
    `ALTER TABLE public."BatchCreationCommand" DROP CONSTRAINT "BatchCreationCommand_receiptProvenanceSnapshot_shape";
     ALTER TABLE public."BatchCreationCommand" ADD CONSTRAINT "BatchCreationCommand_receiptProvenanceSnapshot_shape" CHECK (jsonb_typeof("receiptProvenanceSnapshot") = 'array');`,
  );
  expect(writerVerdict(containerName, databaseName)).toBe("P1_BLOCKED");
  psql(
    containerName,
    databaseName,
    `ALTER TABLE public."BatchCreationCommand" DROP CONSTRAINT "BatchCreationCommand_receiptProvenanceSnapshot_shape";
     ALTER TABLE public."BatchCreationCommand" ADD CONSTRAINT "BatchCreationCommand_receiptProvenanceSnapshot_shape" ${checkDef};`,
  );
  expect(writerVerdict(containerName, databaseName)).toBe("P1_APPLIED");

  psql(
    containerName,
    databaseName,
    `CREATE OR REPLACE FUNCTION public.batch_creation_command_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RETURN NEW; END; $body$;`,
  );
  expect(writerVerdict(containerName, databaseName)).toBe("P1_BLOCKED");
  psql(containerName, databaseName, functionDef);
  expect(writerVerdict(containerName, databaseName)).toBe("P1_APPLIED");

  psql(
    containerName,
    databaseName,
    `DROP TRIGGER batch_creation_command_provenance_guard ON public."BatchCreationCommand";
     CREATE TRIGGER batch_creation_command_provenance_guard AFTER INSERT ON public."BatchCreationCommand" FOR EACH ROW EXECUTE FUNCTION batch_creation_command_provenance_guard();`,
  );
  expect(writerVerdict(containerName, databaseName)).toBe("P1_BLOCKED");
  psql(
    containerName,
    databaseName,
    `DROP TRIGGER batch_creation_command_provenance_guard ON public."BatchCreationCommand";\n${triggerDef};`,
  );
  expect(writerVerdict(containerName, databaseName)).toBe("P1_APPLIED");

  psql(
    containerName,
    databaseName,
    `UPDATE public."_prisma_migrations" SET checksum = repeat('ab', 32) WHERE migration_name = '${P1_MIGRATION_NAME}';`,
  );
  expect(writerVerdict(containerName, databaseName)).toBe("P1_BLOCKED");
  psql(
    containerName,
    databaseName,
    `UPDATE public."_prisma_migrations" SET checksum = '${P1_SHA256}' WHERE migration_name = '${P1_MIGRATION_NAME}';`,
  );
  expect(writerVerdict(containerName, databaseName)).toBe("P1_APPLIED");

  psql(
    containerName,
    databaseName,
    `DELETE FROM public."_prisma_migrations" WHERE migration_name = '20260629154204_init';`,
  );
  expect(writerVerdict(containerName, databaseName)).toBe("P1_BLOCKED");
}

function psql(containerName: string, databaseName: string, sql: string): void {
  const child = spawnSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "p1disp", "-d", databaseName, "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", windowsHide: true },
  );
  if (child.status !== 0) throw new Error("disposable writer mutation failed");
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("text field is missing");
  return value;
}

function optionalText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}

function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new Error("boolean field is missing");
}
