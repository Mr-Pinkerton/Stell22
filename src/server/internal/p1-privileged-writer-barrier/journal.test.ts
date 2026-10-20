import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyJournal,
  mayWidenHba,
  readJournal,
  reopenJournal,
  writeJournal,
} from "@/server/internal/p1-privileged-writer-barrier/journal";

const binding = "container:image:daemon:system:started";

describe("privileged writer admission journal", () => {
  it("stays closed when a held journal is reopened without a release", () => {
    const held = applyJournal([], "ACQUIRE", binding);
    expect(held[0]?.state).toBe("HELD");
    const reopened = reopenJournal(held, binding);
    expect(reopened.state).toBe("AMBIGUOUS");
    expect(reopened.mayWiden).toBe(false);
    expect(mayWidenHba(reopened.state)).toBe(false);
  });

  it("does not widen after an unexpected session or a binding change", () => {
    const blocked = applyJournal(applyJournal([], "ACQUIRE", binding), "UNEXPECTED_SESSION", binding);
    expect(blocked[1]?.state).toBe("BLOCKED");
    expect(reopenJournal(blocked, binding).mayWiden).toBe(false);
    expect(reopenJournal(blocked, "other-binding").state).toBe("AMBIGUOUS");
    const released = applyJournal(applyJournal([], "ACQUIRE", binding), "RELEASE", binding);
    expect(reopenJournal(released, binding)).toEqual({ state: "RELEASED", mayWiden: true });
    const again = applyJournal(released, "ACQUIRE", binding);
    expect(again[2]?.state).toBe("BLOCKED");
    expect(mayWidenHba("BLOCKED")).toBe(false);
  });

  it("round-trips a journal file", () => {
    const file = path.join(os.tmpdir(), `p1pb-journal-${process.pid}.ndjson`);
    const records = applyJournal([], "ACQUIRE", binding);
    writeJournal(file, records);
    expect(reopenJournal(readJournal(file), binding).mayWiden).toBe(false);
    fs.rmSync(file, { force: true });
  });
});
