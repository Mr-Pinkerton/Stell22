import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATION_NAME, MIGRATION_SHA256, readMigrationInventory } from "./decide.mjs";
import {
  POSTGRES_IMAGE,
  assessDisposableIdentity,
  parseHistoryText,
  runDisposableStatementMigration,
} from "./operator.mjs";

const migrationsDir = path.join(process.cwd(), "prisma", "migrations");

type InventoryRow = { name: string; sha256: string };
type HistoryRow = {
  name: string;
  checksum: string;
  finished: boolean;
  rolledBack: boolean;
  steps: number;
};

function historyFrom(rows: InventoryRow[]): HistoryRow[] {
  return rows.map((row) => ({
    name: row.name,
    checksum: row.sha256,
    finished: true,
    rolledBack: false,
    steps: 1,
  }));
}

function identity(databaseName = "stell22_pbr_dst") {
  const id = "a".repeat(64);
  const name = "stell22-pbr-pbrlf0123456789ab";
  return {
    databaseName,
    productionContainersPresent: false,
    evidence: {
      run: "pbrlf0123456789ab",
      containerId: id,
      containerName: name,
      networkName: "none",
      image: POSTGRES_IMAGE,
    },
    inspect: {
      id,
      name,
      networkMode: "none",
      publishedPorts: false,
      configImage: POSTGRES_IMAGE,
      imageId: "b".repeat(64),
      expectedImageId: "b".repeat(64),
      label: "pbrlf0123456789ab",
      composeProject: "",
      mounts: [{ type: "tmpfs", destination: "/var/lib/postgresql/data", name: "" }],
    },
  };
}

function harness(options: {
  databaseName?: string;
  before: HistoryRow[];
  after?: HistoryRow[];
  migrate?: () => { status: number | null };
  confirmRole?: () => string;
  version?: string;
  attempted?: boolean;
}) {
  const calls = { migrate: 0, history: 0 };
  const result = runDisposableStatementMigration({
    identity: identity(options.databaseName),
    inventory: readMigrationInventory(migrationsDir),
    attempted: options.attempted === true,
    readServerVersion: () => options.version ?? "170011",
    readHistory: () => {
      calls.history += 1;
      return calls.history === 1 ? options.before : (options.after ?? options.before);
    },
    confirmRole: options.confirmRole ?? (() => "stell22_migrator"),
    migrate: () => {
      calls.migrate += 1;
      return options.migrate ? options.migrate() : { status: 0 };
    },
  });
  return { result, calls };
}

describe("disposable statement migration operator", () => {
  const image = readMigrationInventory(migrationsDir);
  const before = historyFrom(image.filter((row: InventoryRow) => row.name !== MIGRATION_NAME));
  const applied = historyFrom(image);

  it("accepts the exact 47 to 48 disposable run once", () => {
    expect(image).toHaveLength(48);
    expect(image.find((row: InventoryRow) => row.name === MIGRATION_NAME)?.sha256).toBe(MIGRATION_SHA256);
    const { result, calls } = harness({ before, after: applied });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("DISPOSABLE_MIGRATION_VERIFIED");
    expect(calls.migrate).toBe(1);
    expect(result.retryMigration).toBe("NO");
    expect(result.schemaRestore).toBe("NO");
    expect(result.productionAuthorized).toBe(false);
    expect(result.freezePass).toBe(false);
    expect(result.appMigrated).toBe(false);
    expect(result.scope).toBe("DISPOSABLE_ONLY");
  });

  it("refuses a different pending migration before migrate", () => {
    const other = image.find((row: InventoryRow) => row.name !== MIGRATION_NAME);
    if (!other) throw new Error("comparison migration is missing");
    const { result, calls } = harness({ before: historyFrom(image.filter((row: InventoryRow) => row.name !== other.name)) });
    expect(result).toMatchObject({ ok: false, code: "STOP_PENDING_NAME", attempted: false });
    expect(calls.migrate).toBe(0);
  });

  it("refuses a wrong historical checksum before migrate", () => {
    const mismatched = before.map((row, index) => (index === 0 ? { ...row, checksum: "c".repeat(64) } : row));
    const { result, calls } = harness({ before: mismatched });
    expect(result.code).toBe("STOP_CHECKSUM");
    expect(calls.migrate).toBe(0);
  });

  it("refuses the production database before any database call", () => {
    let called = false;
    const result = runDisposableStatementMigration({
      identity: identity("stell22"),
      inventory: image,
      readServerVersion: () => {
        called = true;
        return "170011";
      },
      readHistory: () => before,
      confirmRole: () => "stell22_migrator",
      migrate: () => ({ status: 0 }),
    });
    expect(result.code).toBe("STOP_PRODUCTION_DATABASE");
    expect(called).toBe(false);
    expect(assessDisposableIdentity({ ...identity(), productionContainersPresent: true }).code).toBe("STOP_PRODUCTION_CONTAINER");
    expect(assessDisposableIdentity({ ...identity(), inspect: { ...identity().inspect, publishedPorts: true } }).code).toBe("STOP_PUBLISHED_PORT");
    expect(
      assessDisposableIdentity({
        ...identity(),
        inspect: {
          ...identity().inspect,
          mounts: [{ type: "volume", destination: "/var/lib/postgresql/data", name: "db-data" }],
        },
      }).code,
    ).toBe("STOP_VOLUME");
  });

  it("does not retry after an uncertain migration attempt", () => {
    const first = harness({ before, after: applied, migrate: () => { throw new Error("unknown"); } });
    expect(first.result).toMatchObject({ ok: false, code: "STOP_UNCERTAIN", attempted: true, retryMigration: "NO", schemaRestore: "NO" });
    const second = harness({ before, after: applied, attempted: true });
    expect(second.result.code).toBe("STOP_RETRY");
    expect(second.calls.migrate).toBe(0);
    const unclear = harness({ before, after: before, migrate: () => ({ status: null }) });
    expect(unclear.result.code).toBe("STOP_UNCERTAIN");
    expect(unclear.result.schemaRestore).toBe("NO");
  });

  it("parses disposable history flags without treating them as permissions", () => {
    const parsed = parseHistoryText(`${MIGRATION_NAME}|${MIGRATION_SHA256}|t|f|1\n`);
    expect(parsed).toEqual([
      { name: MIGRATION_NAME, checksum: MIGRATION_SHA256, finished: true, rolledBack: false, steps: 1 },
    ]);
  });
});
