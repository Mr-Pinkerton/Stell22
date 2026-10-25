import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_PHRASE,
  MIGRATION_NAME,
  MIGRATION_SHA256,
  REJECTED_AUTHORIZATION_PHRASE,
  assertMigratorUrl,
  compareHistory,
  decide,
  parseFacts,
  readMigrationInventory,
  recoveryAction,
} from "./decide.mjs";

const migrationsDir = path.join(process.cwd(), "prisma", "migrations");

function imageRows() {
  return readMigrationInventory(migrationsDir);
}

function historyFrom(rows: { name: string; sha256: string }[], unfinished: string[] = []) {
  return rows.map((row) => ({
    name: row.name,
    checksum: row.sha256,
    finished: !unfinished.includes(row.name),
    rolledBack: false,
    steps: unfinished.includes(row.name) ? 0 : 1,
  }));
}

describe("admin corrections release decisions", () => {
  it("rejects the role-split phrase, a missing phrase, and a restore flag", () => {
    expect(decide("lock", { execute: "1", maintenance: "1", authorization: AUTHORIZATION_PHRASE, restore: "", ci: "1" }).code).toBe("LOCK_OPEN");
    expect(decide("lock", { execute: "1", maintenance: "1", authorization: REJECTED_AUTHORIZATION_PHRASE, restore: "", ci: "1" }).code).toBe("STOP_OWNER_GATE");
    expect(decide("lock", { execute: "1", maintenance: "1", authorization: "", restore: "", ci: "1" }).code).toBe("STOP_OWNER_GATE");
    expect(decide("lock", { execute: "1", maintenance: "1", authorization: AUTHORIZATION_PHRASE, restore: "1", ci: "1" }).code).toBe("STOP_NO_RESTORE");
    expect(decide("lock", { execute: "1", maintenance: "1", authorization: AUTHORIZATION_PHRASE, restore: "", ci: "0" }).code).toBe("STOP_CHECKOUT");
  });

  it("requires the exact SHA to be origin/main and to have CI", () => {
    const sha = "a".repeat(40);
    expect(decide("sha", { sha, originMain: sha, head: sha, ci: "1" }).code).toBe("SHA_APPROVED");
    expect(decide("sha", { sha, originMain: "b".repeat(40), head: sha, ci: "1" }).code).toBe("STOP_CHECKOUT");
    expect(decide("sha", { sha: "abc", originMain: "abc", head: "abc", ci: "1" }).code).toBe("STOP_CHECKOUT");
    expect(decide("sha", { sha, originMain: sha, head: sha, ci: "0" }).code).toBe("STOP_CHECKOUT");
  });

  it("accepts only the one expected pending migration and refuses a repeat", () => {
    const image = imageRows();
    expect(image).toHaveLength(47);
    expect(image.find((row) => row.name === MIGRATION_NAME)?.sha256).toBe(MIGRATION_SHA256);
    const pending = compareHistory(image, historyFrom(image.filter((row) => row.name !== MIGRATION_NAME)));
    expect(pending.pendingCount).toBe("1");
    expect(pending.pendingName).toBe(MIGRATION_NAME);
    expect(pending.pendingSha256).toBe(MIGRATION_SHA256);
    expect(pending.historyFinished).toBe("46");
    const applied = compareHistory(image, historyFrom(image));
    expect(applied.pendingCount).toBe("0");
    expect(applied.historyFinished).toBe("47");
    expect(applied.targetChecksum).toBe(MIGRATION_SHA256);
    const mismatched = historyFrom(image.filter((row) => row.name !== MIGRATION_NAME));
    mismatched[0] = { ...mismatched[0], checksum: "c".repeat(64) };
    expect(compareHistory(image, mismatched).checksumMismatch).toBe("1");
    const extraImage = [...image, { name: "20990101000000_other", sha256: "d".repeat(64) }];
    expect(compareHistory(extraImage, historyFrom(image.filter((row) => row.name !== MIGRATION_NAME))).pendingCount).toBe("2");
  });

  it("restarts the old image only before an unattempted migration", () => {
    const proved = {
      stage: "after-stop",
      migrationAttempted: "0",
      historyUnchanged: "1",
      schemaUnchanged: "1",
      oldImageAppOnly: "1",
      targetObjectsAbsent: "1",
      schemaCompared: "1",
      oldImageIdentity: "1",
      sessionClear: "1",
      processesClear: "1",
      unexpectedWrites: "0",
    };
    expect(recoveryAction({ ...proved, stage: "before-stop" })).toBe("none");
    expect(recoveryAction(proved)).toBe("restart-old");
    expect(recoveryAction({ ...proved, sessionClear: "0" })).toBe("stop");
    expect(recoveryAction({ ...proved, processesClear: "0" })).toBe("stop");
    expect(recoveryAction({ stage: "after-stop", migrationAttempted: "0", historyUnchanged: "1", schemaUnchanged: "1", oldImageAppOnly: "1" })).toBe("stop");
    expect(recoveryAction({ ...proved, targetObjectsAbsent: "0" })).toBe("stop");
    expect(recoveryAction({ ...proved, schemaCompared: "0" })).toBe("stop");
    expect(recoveryAction({ ...proved, oldImageIdentity: "0" })).toBe("stop");
    expect(recoveryAction({ ...proved, unexpectedWrites: "1" })).toBe("stop");
    expect(recoveryAction({ ...proved, stage: "signal" })).toBe("stop");
    expect(recoveryAction({ ...proved, historyUnchanged: "0" })).toBe("stop");
    expect(recoveryAction({ ...proved, oldImageAppOnly: "0" })).toBe("stop");
    expect(recoveryAction({ stage: "migration-uncertain", migrationAttempted: "1", historyUnchanged: "1", schemaUnchanged: "1", oldImageAppOnly: "1" })).toBe("forward-recovery");
    expect(recoveryAction({ stage: "app-start-failed", migrationAttempted: "1", historyUnchanged: "1", schemaUnchanged: "1", oldImageAppOnly: "1" })).toBe("forward-recovery");
    expect(decide("recovery", { stage: "after-stop", migrationAttempted: "1", historyUnchanged: "1", schemaUnchanged: "1", oldImageAppOnly: "1" }).action).not.toBe("restore");
    expect(JSON.stringify(decide("recovery", { stage: "success", migrationAttempted: "1", historyUnchanged: "0", schemaUnchanged: "0", oldImageAppOnly: "1" }))).not.toContain("restore");
  });

  it("does not return a database URL password", () => {
    const password = `secret${"a".repeat(24)}`;
    const text = `DATABASE_URL=postgresql://stell22_migrator:${password}@127.0.0.1:5432/acrel_abcd1234?schema=public\n`;
    const result = assertMigratorUrl(text, "disposable");
    expect(result.code).toBe("MIGRATOR_URL_READY");
    expect(JSON.stringify(result)).not.toContain(password);
    expect(assertMigratorUrl(text.replace("stell22_migrator", "stell22_app"), "disposable").code).toBe("STOP_MIGRATOR");
    expect(assertMigratorUrl(text.replace("stell22_migrator", "stell22"), "production").code).toBe("STOP_MIGRATOR");
    expect(assertMigratorUrl(text.replace("acrel_abcd1234", "stell22"), "disposable").code).toBe("STOP_MIGRATOR");
    const file = path.join(os.tmpdir(), `ac-url-${process.pid}.env`);
    fs.writeFileSync(file, text);
    const printed = fs.readFileSync(file, "utf8");
    expect(printed).toContain(password);
    fs.rmSync(file, { force: true });
    expect(pathToFileURL(file).protocol).toBe("file:");
  });

  it("refuses a secret fact key", () => {
    expect(() => parseFacts("password=value\n")).toThrow("SECRET_FACT");
  });
});
