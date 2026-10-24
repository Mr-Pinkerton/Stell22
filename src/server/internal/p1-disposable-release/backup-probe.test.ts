import { describe, expect, it } from "vitest";
import {
  BACKUP_PROBE_VALUE,
  compareBackupProbe,
} from "@/server/internal/p1-disposable-release/rehearsal";

const captured = {
  sourceDatabase: "p1as_abcdef01",
  restoreDatabase: "p1as_abcdef02",
  sourceCurrentDatabase: "p1as_abcdef01",
  restoreCurrentDatabase: "p1as_abcdef02",
  capturedKey: "p1rr_backup_abcdef01",
  capturedValue: BACKUP_PROBE_VALUE,
  sourceKey: "p1rr_backup_abcdef01",
  sourceValue: BACKUP_PROBE_VALUE,
  restoredKey: "p1rr_backup_abcdef01",
  restoredValue: BACKUP_PROBE_VALUE,
  sourceP1: "ABSENT",
  restoredP1: "ABSENT",
};

describe("backup business probe", () => {
  it("accepts an exact restored Setting value in a separate database", () => {
    expect(compareBackupProbe(captured)).toEqual({ ok: true });
  });

  it("rejects a missing or changed restored record", () => {
    expect(compareBackupProbe({ ...captured, restoredValue: "" }).ok).toBe(false);
    expect(compareBackupProbe({ ...captured, restoredValue: '"changed"' }).ok).toBe(false);
    expect(compareBackupProbe({ ...captured, restoredKey: "" }).ok).toBe(false);
  });

  it("rejects a source record that no longer matches the captured value", () => {
    expect(compareBackupProbe({ ...captured, sourceValue: '"changed"' }).ok).toBe(false);
  });

  it("rejects the same database name or a present P1 row", () => {
    expect(
      compareBackupProbe({
        ...captured,
        restoreDatabase: captured.sourceDatabase,
        restoreCurrentDatabase: captured.sourceDatabase,
      }).ok,
    ).toBe(false);
    expect(compareBackupProbe({ ...captured, sourceP1: "present" }).ok).toBe(false);
    expect(compareBackupProbe({ ...captured, restoredP1: "present" }).ok).toBe(false);
  });
});
