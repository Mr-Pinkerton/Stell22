import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPLIED_AFTER,
  APPLIED_BEFORE,
  IMAGE_COUNT,
  MIGRATION_NAME,
  MIGRATION_SHA256,
  evaluateOfflineHistory,
  readMigrationInventory,
  verifyAppliedHistory,
} from "./decide.mjs";

const migrationsDir = path.join(process.cwd(), "prisma", "migrations");

type InventoryRow = { name: string; sha256: string };
type HistoryRow = {
  name: string;
  checksum: string;
  finished: boolean;
  rolledBack: boolean;
  steps: number;
};

function historyFrom(rows: InventoryRow[], patch?: (row: HistoryRow, index: number) => HistoryRow): HistoryRow[] {
  return rows.map((row, index) => {
    const history: HistoryRow = {
      name: row.name,
      checksum: row.sha256,
      finished: true,
      rolledBack: false,
      steps: 1,
    };
    return patch ? patch(history, index) : history;
  });
}

function without(rows: InventoryRow[], name: string) {
  return rows.filter((row) => row.name !== name);
}

describe("statement period offline history contract", () => {
  const image = readMigrationInventory(migrationsDir);
  const before = historyFrom(without(image, MIGRATION_NAME));
  const applied = historyFrom(image);

  it("reads 48 repository migrations and the pinned target checksum", () => {
    expect(IMAGE_COUNT).toBe(48);
    expect(APPLIED_BEFORE).toBe(47);
    expect(APPLIED_AFTER).toBe(48);
    expect(image).toHaveLength(48);
    expect(image.find((row: InventoryRow) => row.name === MIGRATION_NAME)?.sha256).toBe(MIGRATION_SHA256);
  });

  it("matches only the exact 47 to 48 history", () => {
    const decision = evaluateOfflineHistory(image, before);
    expect(decision.ok).toBe(true);
    expect(decision.code).toBe("OFFLINE_HISTORY_CONTRACT_MATCHED");
    expect(decision.migrationAuthorized).toBe(false);
    expect(decision.productionAuthorized).toBe(false);
    expect(decision.writerExclusionProven).toBe(false);
    expect(decision.freezePass).toBe(false);
    expect(decision.databaseRestore).toBe("NO");
    expect(decision.retryMigration).toBe("NO");
    expect(decision.deploy).toBe("NO");
    expect(decision.restart).toBe("NO");
    expect(decision.sql).toBe("NO");
  });

  it("rejects an already applied history for another migration attempt", () => {
    const decision = evaluateOfflineHistory(image, applied);
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("STOP_ALREADY_APPLIED");
    expect(decision.retryMigration).toBe("NO");
    expect(decision.migrationAuthorized).toBe(false);
  });

  it("rejects 45 and 46 completed histories", () => {
    const oldest = [...image].sort((left: InventoryRow, right: InventoryRow) => left.name.localeCompare(right.name));
    const fortyFive = evaluateOfflineHistory(image, historyFrom(oldest.slice(0, 45)));
    const fortySix = evaluateOfflineHistory(image, historyFrom(oldest.slice(0, 46)));
    expect(fortyFive).toMatchObject({ ok: false, code: "STOP_HISTORY_COUNT", migrationAuthorized: false });
    expect(fortySix).toMatchObject({ ok: false, code: "STOP_HISTORY_COUNT", migrationAuthorized: false });
  });

  it("rejects a different single pending migration and more than one pending migration", () => {
    const other = image.find((row: InventoryRow) => row.name !== MIGRATION_NAME);
    if (!other) throw new Error("comparison migration is missing");
    const wrongPending = evaluateOfflineHistory(image, historyFrom(without(image, other.name)));
    const twoPending = evaluateOfflineHistory(image, historyFrom(without(without(image, MIGRATION_NAME), other.name)));
    expect(wrongPending).toMatchObject({ ok: false, code: "STOP_PENDING_NAME" });
    expect(twoPending).toMatchObject({ ok: false, code: "STOP_HISTORY_COUNT" });
  });

  it("rejects a wrong historical checksum and a wrong target checksum", () => {
    const mismatched = historyFrom(without(image, MIGRATION_NAME), (row, index) =>
      index === 0 ? { ...row, checksum: "c".repeat(64) } : row,
    );
    expect(evaluateOfflineHistory(image, mismatched).code).toBe("STOP_CHECKSUM");
    const badImage = image.map((row: InventoryRow) =>
      row.name === MIGRATION_NAME ? { ...row, sha256: "d".repeat(64) } : row,
    );
    expect(evaluateOfflineHistory(badImage, before).code).toBe("STOP_TARGET_CHECKSUM");
  });

  it("rejects failed, incomplete, rolled back, duplicate, and extra history", () => {
    expect(evaluateOfflineHistory(image, historyFrom(without(image, MIGRATION_NAME), (row, index) => (index === 0 ? { ...row, finished: false } : row))).code).toBe(
      "STOP_INCOMPLETE",
    );
    expect(evaluateOfflineHistory(image, historyFrom(without(image, MIGRATION_NAME), (row, index) => (index === 0 ? { ...row, steps: 0 } : row))).code).toBe(
      "STOP_INCOMPLETE",
    );
    expect(evaluateOfflineHistory(image, historyFrom(without(image, MIGRATION_NAME), (row, index) => (index === 0 ? { ...row, rolledBack: true } : row))).code).toBe(
      "STOP_ROLLED_BACK",
    );
    expect(evaluateOfflineHistory(image, [...before, before[0]]).code).toBe("STOP_DUPLICATE");
    expect(
      evaluateOfflineHistory(image, [
        ...before,
        { name: "20990101000000_other", checksum: "e".repeat(64), finished: true, rolledBack: false, steps: 1 },
      ]).code,
    ).toBe("STOP_EXTRA");
    expect(evaluateOfflineHistory(image.slice(0, 47), before).code).toBe("STOP_IMAGE_COUNT");
  });

  it("verifies 48 completed rows without authorizing another apply", () => {
    const verified = verifyAppliedHistory(image, applied);
    expect(verified.ok).toBe(true);
    expect(verified.code).toBe("POST_MIGRATION_VERIFIED");
    expect(verified.retryMigration).toBe("NO");
    expect(verified.migrationAuthorized).toBe(false);
    expect(verified.deploy).toBe("NO");
    expect(verified.sql).toBe("NO");
    expect(verifyAppliedHistory(image, before)).toMatchObject({ ok: false, code: "STOP_NOT_APPLIED", retryMigration: "NO" });
  });

  it("does not mutate its inputs or contain an operator", () => {
    const imageCopy = structuredClone(image);
    const historyCopy = structuredClone(before);
    evaluateOfflineHistory(image, before);
    verifyAppliedHistory(image, applied);
    expect(image).toEqual(imageCopy);
    expect(before).toEqual(historyCopy);
    const source = fs.readFileSync(path.join(process.cwd(), "src/server/internal/statement-period-release/decide.mjs"), "utf8");
    expect(source).not.toContain("prisma");
    expect(source).not.toContain("migrate deploy");
    expect(source).not.toContain("docker");
  });
});
