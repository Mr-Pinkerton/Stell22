import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
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
  P1_MIGRATION_NAME,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import {
  attestationFor,
  countMigrationSql,
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

const LIVE_FLAG = "P1_DISPOSABLE_LIVE";

describe("owned query child", () => {
  const files: string[] = [];

  afterEach(() => {
    for (const file of files.splice(0)) fs.rmSync(file, { force: true });
  });

  it("refuses a non-loopback URL before opening a client", () => {
    const script = writeQueryChild(os.tmpdir());
    files.push(script);
    const child = spawnSync(process.execPath, [script, "unused.json"], {
      encoding: "utf8",
      windowsHide: true,
      env: buildChildEnv(
        process.env,
        "postgresql://p1disp:not-printed@db.example:5432/stell22",
      ) as NodeJS.ProcessEnv,
    });
    expect(child.status).toBe(2);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("refusing non-loopback\n");
    expect(child.stderr).not.toContain("not-printed");
    expect(child.stderr).not.toContain("stell22");
  });
});

describe.skipIf(process.env[LIVE_FLAG] !== "1")(
  "postgresql 17 disposable real migration",
  () => {
    it(
      "applies the historical migrations and then P1 once on a new owned database",
      async () => {
        const owned = createOwnedDisposableContainer();
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-p1-real-"));
        const queryScript = writeQueryChild(
          path.join(process.cwd(), "node_modules", ".cache"),
        );
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

          const historicalSchema = materializeHistorical(path.join(scratch, "historical"));
          const historical = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, historical)).toBe(true);
          const historicalUrl = ownedUrl(historical);
          const historicalDeploy = deployPrisma(historicalSchema, historicalUrl);
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
          const beforeEvidence = disposableEvidenceFromQueries(
            queryOwned(queryScript, ownedUrl(before)),
          );
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
            destinationRoot: path.join(scratch, "p1"),
            lockPath: path.join(scratch, "p1.lock"),
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
              prismaDetail = `${result.detail || "no prisma text"} files ${countMigrationSql(request.cwd)}`;
              return result;
            },
          });
          if (first.verdict !== "ALREADY_APPLIED") {
            throw new Error(postApplySummary(queryScript, confirmedUrl, first, prismaDetail));
          }
          expect(first, prismaDetail).toEqual({
            verdict: "ALREADY_APPLIED",
            code: "P1_APPLIED",
            spawned: true,
            retryAttempted: false,
          });
          expect(spawns).toBe(1);

          const after = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, after)).toBe(true);
          const afterEvidence = disposableEvidenceFromQueries(
            queryOwned(queryScript, ownedUrl(after)),
          );
          expect(afterEvidence.history).toHaveLength(EXPECTED_MIGRATION_SQL_COUNT);
          expect(finishedNames(afterEvidence.history)).toEqual(
            [...HISTORICAL_MIGRATION_NAMES, P1_MIGRATION_NAME].sort(),
          );
          const p1 = afterEvidence.history.find((row) => row.migrationName === P1_MIGRATION_NAME);
          expect(p1?.checksum).toBe(P1_SHA256);
          const column = afterEvidence.schema.column;
          const check = afterEvidence.schema.check;
          const functionDef = afterEvidence.schema.functionDef;
          const trigger = afterEvidence.schema.trigger;
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
          expect(afterEvidence.schema.foreignKeyCount).toBe(0);
          expect(afterEvidence.schema.extraTriggerNames).toEqual([]);
          expect(afterEvidence.schema.unexpectedObjects).toEqual([]);

          const report = await readDisposablePostgreSql(attestationFor(after));
          expect(report.evidenceSource).toBe("postgresql-query");
          expect(report.classification).toMatchObject({
            verdict: "ALREADY_APPLIED",
            code: "P1_APPLIED",
          });
          expect(report.verdict).toBe("BLOCKED");
          expect(report.code).toBe("CONTAINER_ORIGIN_NOT_ESTABLISHED");
          expect(report.applyEnabled).toBe(false);
          const reportText = JSON.stringify(report);
          expect(reportText).not.toContain(after.password);
          expect(reportText).not.toContain("postgresql://");

          const applied = await assessOwnedDisposablePreapply(owned);
          expect(applied.status).toBe("already-applied");
          if (applied.status !== "already-applied") return;
          expect(applied.code).toBe("P1_APPLIED");
          expect(applied.executionAuthorized).toBe(false);
          expect(applied.repeatMigrationAuthorized).toBe(false);

          const second = executeDisposableApply(attestationFor(after), {
            git: createRepoGitSource(process.cwd()),
            destinationRoot: path.join(scratch, "p1-repeat"),
            lockPath: path.join(scratch, "p1-repeat.lock"),
            parentEnv,
            readHistory: () =>
              disposableEvidenceFromQueries(queryOwned(queryScript, ownedUrl(after))).history,
            readSchema: () =>
              disposableEvidenceFromQueries(queryOwned(queryScript, ownedUrl(after))).schema,
            probeIdentity: () => identityFrom(queryOwned(queryScript, ownedUrl(after))),
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
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              fs.rmSync(scratch, { recursive: true, force: true });
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
        }
        if (failure) throw failure;
      },
      360_000,
    );
  },
);
