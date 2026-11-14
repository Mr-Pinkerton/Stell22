import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATION_NAME, MIGRATION_SHA256, readMigrationInventory } from "./decide.mjs";
import { AUTHORIZATION_PHRASE, INSPECTION_APP, decideProductionRelease } from "./production.mjs";

const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
const approvedSha = "a".repeat(40);

type InventoryRow = { name: string; sha256: string };

function historyFrom(rows: InventoryRow[]) {
  return rows.map((row) => ({
    name: row.name,
    checksum: row.sha256,
    finished: true,
    rolledBack: false,
    steps: 1,
  }));
}

function ready(inventory: InventoryRow[]) {
  return {
    execute: "1",
    authorization: AUTHORIZATION_PHRASE,
    approvedSha,
    headSha: approvedSha,
    originMainSha: approvedSha,
    inventory,
    history: historyFrom(inventory.filter((row) => row.name !== MIGRATION_NAME)),
    migrator: { login: "stell22_migrator", superuser: false, credentialReady: true },
    appRole: { login: "stell22_app", canMigrate: false, migrationInsert: false, insertSqlstate: "42501" },
    image: {
      entrypoint: "./docker-entrypoint-app-only.sh",
      migrateOnStart: false,
      migrationSha256: MIGRATION_SHA256,
      appUser: "stell22_app",
    },
    backup: { verified: true, checksumOk: true },
    writers: {
      proof: "app-role-and-inspection",
      appContainerStopped: true,
      backupRunning: false,
      statementImportRunning: false,
      migrateProcess: false,
      conflictingDeploy: false,
      inspectionApp: INSPECTION_APP,
      sessions: [{ user: "stell22", applicationName: INSPECTION_APP, backendType: "client backend" }],
    },
  };
}

describe("statement production release decision", () => {
  const inventory = readMigrationInventory(migrationsDir);
  const admitted = () => decideProductionRelease(ready(inventory));

  it("admits the sequence only when every current precondition is established", () => {
    const result = admitted();
    expect(result.ok).toBe(true);
    expect(result.code).toBe("RELEASE_SEQUENCE_ADMITTED");
    expect(result.productionAuthorized).toBe(false);
    expect(result.freezePass).toBe(false);
    expect(result.futurePrivilegedWritesProvenImpossible).toBe(false);
    expect(result.emptyActivityProvesFutureExclusion).toBe(false);
    expect(result.mutationPerformed).toBe("NO");
    expect(result.retryMigration).toBe("NO");
    expect(result.schemaRestore).toBe("NO");
    expect(result.migrateOnStart).toBe("NO");
  });

  it("stays locked without the exact owner authorization", () => {
    expect(decideProductionRelease({ ...ready(inventory), execute: undefined, authorization: undefined }).code).toBe("STOP_OWNER_GATE");
    expect(decideProductionRelease({ ...ready(inventory), authorization: "OWNER_AUTHORIZES_ROLE_SPLIT_RELEASE" }).code).toBe("STOP_OWNER_GATE");
    expect(decideProductionRelease({ ...ready(inventory), execute: "0" }).code).toBe("STOP_OWNER_GATE");
  });

  it("refuses a SHA that is not the approved head", () => {
    expect(decideProductionRelease({ ...ready(inventory), headSha: "b".repeat(40) }).code).toBe("STOP_SHA");
    expect(decideProductionRelease({ ...ready(inventory), originMainSha: "c".repeat(40) }).code).toBe("STOP_SHA");
  });

  it("refuses the wrong history, checksum, and an already applied target", () => {
    const other = inventory.find((row: InventoryRow) => row.name !== MIGRATION_NAME);
    if (!other) throw new Error("comparison migration is missing");
    const foreign = decideProductionRelease({
      ...ready(inventory),
      history: historyFrom(inventory.filter((row: InventoryRow) => row.name !== other.name)),
    });
    expect(foreign.code).toBe("STOP_PENDING_NAME");
    const mismatched = historyFrom(inventory.filter((row: InventoryRow) => row.name !== MIGRATION_NAME)).map((row, index) =>
      index === 0 ? { ...row, checksum: "d".repeat(64) } : row,
    );
    expect(decideProductionRelease({ ...ready(inventory), history: mismatched }).code).toBe("STOP_CHECKSUM");
    expect(decideProductionRelease({ ...ready(inventory), history: historyFrom(inventory) }).code).toBe("STOP_ALREADY_APPLIED");
  });

  it("refuses the wrong migrator role", () => {
    expect(decideProductionRelease({ ...ready(inventory), migrator: { login: "stell22", superuser: true, credentialReady: true } }).code).toBe("STOP_MIGRATOR");
    expect(decideProductionRelease({ ...ready(inventory), migrator: { login: "stell22_app", superuser: false, credentialReady: true } }).code).toBe("STOP_MIGRATOR");
  });

  it("refuses writer proofs that do not exclude the application", () => {
    const base = ready(inventory);
    expect(decideProductionRelease({ ...base, writers: { ...base.writers, sessions: [] } }).code).toBe("STOP_WRITER");
    expect(decideProductionRelease({ ...base, writers: { ...base.writers, proof: "empty-activity" } }).code).toBe("STOP_WRITER");
    expect(decideProductionRelease({ ...base, writers: { ...base.writers, proof: "environment-flag" } }).code).toBe("STOP_WRITER");
    expect(decideProductionRelease({ ...base, writers: { ...base.writers, proof: "maintenance-declaration", maintenanceDeclared: true } }).code).toBe("STOP_WRITER");
    expect(decideProductionRelease({ ...base, writers: { ...base.writers, claimFutureExclusion: true } }).code).toBe("STOP_WRITER");
    expect(decideProductionRelease({ ...base, appRole: { ...base.appRole, insertSqlstate: "00000", migrationInsert: true } }).code).toBe("STOP_APP_ROLE");
  });

  it("does not retry after an uncertain attempt and does not restore", () => {
    const uncertain = decideProductionRelease({
      ...ready(inventory),
      phase: "after-attempt",
      attempted: true,
      attempt: { status: null },
    });
    expect(uncertain).toMatchObject({
      ok: false,
      code: "FORWARD_RECOVERY",
      retryMigration: "NO",
      schemaRestore: "NO",
      databaseRestore: "NO",
      productionAuthorized: false,
      freezePass: false,
    });
    expect(decideProductionRelease({ ...ready(inventory), attempted: true }).code).toBe("STOP_RETRY");
  });

  it("verifies a finished attempt only through the app-only path", () => {
    const verified = decideProductionRelease({
      ...ready(inventory),
      phase: "after-attempt",
      attempted: true,
      attempt: { status: 0 },
      history: historyFrom(inventory),
      health: { ok: true, appOnly: true },
    });
    expect(verified.code).toBe("POST_RELEASE_VERIFIED");
    expect(verified.productionAuthorized).toBe(false);
    expect(verified.freezePass).toBe(false);
    expect(verified.migrateOnStart).toBe("NO");
  });

  it("keeps the entrypoint locked when the process is started", () => {
    const locked = spawnSync(process.execPath, ["src/server/internal/statement-period-release/production.mjs"], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    expect(locked.status).not.toBe(0);
    expect(locked.stdout).toContain("RESULT=STOP_OWNER_GATE");
    expect(locked.stdout).toContain("MUTATION=NO");
    expect(locked.stdout).toContain("PRODUCTION_AUTHORIZED=NO");
    expect(locked.stdout).toContain("FREEZE_PASS=NO");
    const phraseOnly = spawnSync(process.execPath, ["src/server/internal/statement-period-release/production.mjs"], {
      encoding: "utf8",
      cwd: process.cwd(),
      env: {
        ...process.env,
        STELL22_STATEMENT_RELEASE_EXECUTE: "1",
        STELL22_STATEMENT_RELEASE_AUTHORIZATION: AUTHORIZATION_PHRASE,
      },
    });
    expect(phraseOnly.status).not.toBe(0);
    expect(phraseOnly.stdout).toContain("RESULT=STOP_FACTS");
    expect(phraseOnly.stdout).toContain("MUTATION=NO");
    expect(phraseOnly.stdout).toContain("PRODUCTION_AUTHORIZED=NO");
  });
});
