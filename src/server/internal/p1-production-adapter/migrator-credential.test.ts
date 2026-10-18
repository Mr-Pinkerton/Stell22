import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_MIGRATOR_CREDENTIAL_PATH, PROPOSED_MIGRATOR_ROLE } from "@/server/internal/p1-production-adapter/contract";
import { credentialModeAllowed, readMigratorCredentialFile } from "@/server/internal/p1-production-adapter/migrator-credential";
import { RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";

const PASSWORD = "migrator-secret-value";

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "P1_MIGRATOR_CREDENTIAL",
    role: PROPOSED_MIGRATOR_ROLE,
    database: "p1pa_db",
    password: PASSWORD,
    ...overrides,
  });
}

function stat(mode: number, file = true) {
  return { isSymbolicLink: () => false, isFile: () => file, mode };
}

describe("P1 migrator credential", () => {
  it("accepts a bound regular file and rejects substitution, shape, and permissions", () => {
    expect(credentialModeAllowed(0o100600)).toBe(true);
    expect(credentialModeAllowed(0o100640)).toBe(false);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-migrator-"));
    const allowed = path.join(root, "migrator-credential.json");
    const read = readMigratorCredentialFile({
      requestedPath: allowed,
      allowedPath: allowed,
      expectedDatabase: "p1pa_db",
      readFile: () => body(),
      lstat: () => stat(0o100600),
    });
    expect(read.role).toBe(PROPOSED_MIGRATOR_ROLE);
    expect(read.password).toBe(PASSWORD);

    expect(() =>
      readMigratorCredentialFile({
        requestedPath: path.join(root, "other.json"),
        allowedPath: allowed,
        expectedDatabase: "p1pa_db",
        readFile: () => body(),
        lstat: () => stat(0o100600),
      }),
    ).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_PATH" }));

    expect(() =>
      readMigratorCredentialFile({
        requestedPath: allowed,
        allowedPath: allowed,
        expectedDatabase: "p1pa_db",
        readFile: () => body(),
        lstat: () => stat(0o100666),
      }),
    ).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_PERMISSIONS" }));

    expect(() =>
      readMigratorCredentialFile({
        requestedPath: allowed,
        allowedPath: allowed,
        expectedDatabase: "p1pa_db",
        readFile: () => "",
        lstat: () => stat(0o100600),
      }),
    ).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_INVALID" }));

    expect(() =>
      readMigratorCredentialFile({
        requestedPath: allowed,
        allowedPath: allowed,
        expectedDatabase: "p1pa_db",
        readFile: () => body({ role: "p1pa" }),
        lstat: () => stat(0o100600),
      }),
    ).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_MISMATCH" }));

    expect(() =>
      readMigratorCredentialFile({
        requestedPath: allowed,
        allowedPath: allowed,
        expectedDatabase: "p1pa_db",
        readFile: () => body({ database: "stell22" }),
        lstat: () => stat(0o100600),
      }),
    ).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_MISMATCH" }));

    expect(() =>
      readMigratorCredentialFile({
        requestedPath: allowed,
        allowedPath: allowed,
        expectedDatabase: "p1pa_db",
        lstat: () => {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
      }),
    ).toThrow(expect.objectContaining({ code: "MIGRATOR_CREDENTIAL_MISSING" }));

    expect(PRODUCTION_MIGRATOR_CREDENTIAL_PATH).toBe("/var/lib/stell22/p1-migrator-credential.json");
    expect(() => readMigratorCredentialFile({ requestedPath: allowed, allowedPath: allowed, expectedDatabase: "p1pa_db", readFile: () => body(), lstat: () => ({ ...stat(0o100600), isSymbolicLink: () => true }) })).toThrow(RunnerRefusal);
  });
});
