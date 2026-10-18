import fs from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_MIGRATOR_CREDENTIAL_PATH, PROPOSED_MIGRATOR_ROLE } from "@/server/internal/p1-production-adapter/contract";
import {
  MAX_MIGRATOR_CREDENTIAL_BYTES,
  credentialModeAllowed,
  readMigratorCredentialFile,
  type CredentialIo,
} from "@/server/internal/p1-production-adapter/migrator-credential";

const PASSWORD = "migrator-secret-value";
const FLAGS = { readOnly: 0, noFollow: 0o200000 };
const UID = 1000;

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "P1_MIGRATOR_CREDENTIAL",
    role: PROPOSED_MIGRATOR_ROLE,
    database: "p1pa_db",
    password: PASSWORD,
    ...overrides,
  });
}

function statOf(input: { kind: "dir" | "file" | "link"; mode: number; uid: number; ino: number; size?: number }): Stats {
  return {
    isSymbolicLink: () => input.kind === "link",
    isFile: () => input.kind === "file",
    isDirectory: () => input.kind === "dir",
    mode: input.mode,
    uid: input.uid,
    size: input.size ?? 0,
    dev: 1,
    ino: input.ino,
    } as Stats;
}

function fixture(text = body(), mutate?: { beforeOpen?: boolean; afterRead?: boolean; fstatDrift?: boolean; readError?: boolean }) {
  const filePath = path.resolve("p1-credential-fixture", "stell22", "migrator-credential.json");
  const foreign = path.resolve("p1-credential-fixture", "foreign-secret.json");
  const nodes = new Map<string, { kind: "dir" | "file" | "link"; mode: number; uid: number; ino: number; text?: string; size?: number }>();
  nodes.set(filePath, { kind: "file", mode: 0o100600, uid: UID, ino: 10, text, size: Buffer.byteLength(text) });
  nodes.set(foreign, { kind: "file", mode: 0o100600, uid: UID, ino: 11, text: "foreign-unchanged" });
  let current = path.dirname(filePath);
  while (true) {
    const parent = path.dirname(current);
    const root = parent === current;
    nodes.set(current, {
      kind: "dir",
      mode: current === path.dirname(filePath) ? 0o40700 : 0o40555,
      uid: current === path.dirname(filePath) ? UID : 0,
      ino: root ? 1 : current.length,
    });
    if (root) break;
    current = parent;
  }
  const opened = new Map<number, number>();
  const closed: number[] = [];
  let next = 3;
  const io: CredentialIo = {
    lstat(target) {
      const node = nodes.get(path.resolve(target));
      if (!node) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return statOf(node);
    },
    open(target) {
      if (mutate?.beforeOpen) nodes.get(filePath)!.ino = 99;
      const node = nodes.get(path.resolve(target));
      if (!node || node.kind !== "file") throw new Error("open failed");
      next += 1;
      opened.set(next, mutate?.fstatDrift ? node.ino + 1 : node.ino);
      return next;
    },
    fstat(fd) {
      const node = nodes.get(filePath)!;
      return statOf({ ...node, ino: opened.get(fd) ?? node.ino });
    },
    read() {
      if (mutate?.readError) throw new Error("read failed");
      if (mutate?.afterRead) nodes.get(filePath)!.ino = 77;
      return Buffer.from(nodes.get(filePath)?.text ?? "");
    },
    close(fd) {
      closed.push(fd);
    },
  };
  return { filePath, foreign, nodes, io, closed };
}

function read(setup = fixture()) {
  return readMigratorCredentialFile({
    requestedPath: setup.filePath,
    allowedPath: setup.filePath,
    expectedDatabase: "p1pa_db",
    uid: UID,
    openFlags: FLAGS,
    io: setup.io,
  });
}

describe("P1 migrator credential", () => {
  it("reads a private regular file through the opened descriptor and leaves it unchanged", () => {
    expect(credentialModeAllowed(0o100600)).toBe(true);
    expect(credentialModeAllowed(0o100666)).toBe(false);
    const setup = fixture();
    const before = setup.nodes.get(setup.filePath)?.text;
    const credential = read(setup);
    expect(credential).toMatchObject({ role: PROPOSED_MIGRATOR_ROLE, database: "p1pa_db", password: PASSWORD });
    expect(setup.nodes.get(setup.filePath)?.text).toBe(before);
    expect(setup.nodes.get(setup.foreign)?.text).toBe("foreign-unchanged");
    expect(setup.closed).toEqual([4]);
    expect(PRODUCTION_MIGRATOR_CREDENTIAL_PATH).toBe("/var/lib/stell22/p1-migrator-credential.json");
  });

  it("fails closed on symlink, replacement, size, and identity mistakes", () => {
    const linked = fixture();
    linked.nodes.get(linked.filePath)!.kind = "link";
    expect(() => read(linked)).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_PATH" }));
    expect(linked.closed).toEqual([]);
    expect(linked.nodes.get(linked.foreign)?.text).toBe("foreign-unchanged");

    const parent = fixture();
    parent.nodes.get(path.dirname(parent.filePath))!.kind = "link";
    expect(() => read(parent)).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_PATH" }));

    const writable = fixture();
    writable.nodes.get(path.dirname(writable.filePath))!.mode = 0o40777;
    expect(() => read(writable)).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_PERMISSIONS" }));

    expect(() => read(fixture(body(), { beforeOpen: true }))).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_RACE" }));
    expect(() => read(fixture(body(), { afterRead: true }))).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_RACE" }));
    expect(() => read(fixture(body(), { fstatDrift: true }))).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_RACE" }));
    const failed = fixture(body(), { readError: true });
    expect(() => read(failed)).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_INVALID" }));
    expect(failed.closed).toEqual([4]);

    const oversized = fixture(body());
    oversized.nodes.get(oversized.filePath)!.size = MAX_MIGRATOR_CREDENTIAL_BYTES + 1;
    expect(() => read(oversized)).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_SIZE" }));
    expect(() => read(fixture(body({ role: "stell22" })))).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_MISMATCH" }));
    expect(() => read(fixture(body({ database: "stell22" })))).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_MISMATCH" }));
    const directory = fixture();
    directory.nodes.get(directory.filePath)!.kind = "dir";
    expect(() => read(directory)).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_PATH" }));
    expect(directory.closed).toEqual([]);
    expect(oversized.nodes.get(oversized.foreign)?.text).toBe("foreign-unchanged");
    expect(directory.nodes.get(directory.foreign)?.text).toBe("foreign-unchanged");
  });

  it("does not claim a Linux read on a platform that cannot prove it", () => {
    const setup = fixture();
    if (process.platform !== "linux") {
      expect(() =>
        readMigratorCredentialFile({
          requestedPath: setup.filePath,
          allowedPath: setup.filePath,
          expectedDatabase: "p1pa_db",
        }),
      ).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_UNSUPPORTED" }));
      expect(setup.nodes.get(setup.foreign)?.text).toBe("foreign-unchanged");
      return;
    }
    const root = fs.mkdtempSync(path.join(process.cwd(), ".p1-credential-linux-"));
    const filePath = path.join(root, "migrator-credential.json");
    fs.chmodSync(root, 0o700);
    fs.writeFileSync(filePath, body(), { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    try {
      expect(
        readMigratorCredentialFile({
          requestedPath: filePath,
          allowedPath: filePath,
          expectedDatabase: "p1pa_db",
        }),
      ).toMatchObject({ role: PROPOSED_MIGRATOR_ROLE, database: "p1pa_db", password: PASSWORD });
      expect(fs.readFileSync(filePath, "utf8")).toBe(body());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
