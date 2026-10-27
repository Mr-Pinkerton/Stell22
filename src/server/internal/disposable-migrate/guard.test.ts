import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DisposableMigrateRefusal,
  parseDisposableDatabaseUrl,
  runDisposableMigrate,
} from "@/server/internal/disposable-migrate/guard";

const REPOSITORY = path.resolve(".");
const OUTSIDE = path.join(os.tmpdir(), "stell22-guard-outside");
const URL = "postgresql://p1iso:secret@127.0.0.1:45123/p1iso_abc123?schema=public";

function refusal(run: () => void): DisposableMigrateRefusal {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DisposableMigrateRefusal);
    return error as DisposableMigrateRefusal;
  }
  throw new Error("expected refusal");
}

describe("disposable migrate guard", () => {
  it("stops on an absent URL before identity or migrate", () => {
    let probed = false;
    let spawned = false;
    const error = refusal(() => runDisposableMigrate({
      databaseUrl: undefined,
      cwd: OUTSIDE,
      schemaPath: path.join(OUTSIDE, "schema.prisma"),
      repositoryRoot: REPOSITORY,
      probe: () => {
        probed = true;
        return { currentDatabase: "p1iso_abc123" };
      },
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
    }));
    expect(error.code).toBe("ABSENT_URL");
    expect(probed).toBe(false);
    expect(spawned).toBe(false);
  });

  it("rejects persistent database names before opening a connection", () => {
    for (const name of ["stell22", "stell22_dev", "stell22_integrity", "stell22_smoke", "stell22_inc001_dry"]) {
      let probed = false;
      const error = refusal(() => runDisposableMigrate({
        databaseUrl: `postgresql://user:secret@127.0.0.1:45123/${name}`,
        cwd: OUTSIDE,
        schemaPath: path.join(OUTSIDE, "schema.prisma"),
        repositoryRoot: REPOSITORY,
        probe: () => {
          probed = true;
          return { currentDatabase: name };
        },
        spawn: () => ({ status: 0 }),
      }));
      expect(error.code).toBe("PERSISTENT_DATABASE");
      expect(probed).toBe(false);
    }
  });

  it("rejects the persistent local ports and an unapproved name", () => {
    expect(refusal(() => parseDisposableDatabaseUrl("postgresql://u:p@127.0.0.1:5434/p1iso_abc")).code).toBe("PERSISTENT_PORT");
    expect(refusal(() => parseDisposableDatabaseUrl("postgresql://u:p@127.0.0.1/p1iso_abc")).code).toBe("PERSISTENT_PORT");
    expect(refusal(() => parseDisposableDatabaseUrl("postgresql://u:p@127.0.0.1:45123/postgres")).code).toBe("UNAPPROVED_DATABASE");
    expect(refusal(() => parseDisposableDatabaseUrl("postgresql://u:p@db:5432/p1iso_abc")).code).toBe("NON_LOOPBACK");
  });

  it("stops when the working directory or schema is inside the repository", () => {
    let probed = false;
    const error = refusal(() => runDisposableMigrate({
      databaseUrl: URL,
      cwd: REPOSITORY,
      schemaPath: path.join(OUTSIDE, "schema.prisma"),
      repositoryRoot: REPOSITORY,
      probe: () => {
        probed = true;
        return { currentDatabase: "p1iso_abc123" };
      },
      spawn: () => ({ status: 0 }),
    }));
    expect(error.code).toBe("INSIDE_REPOSITORY");
    expect(probed).toBe(false);
  });

  it("stops when the read-only identity does not match, before migrate", () => {
    let spawned = false;
    const error = refusal(() => runDisposableMigrate({
      databaseUrl: URL,
      cwd: OUTSIDE,
      schemaPath: path.join(OUTSIDE, "schema.prisma"),
      repositoryRoot: REPOSITORY,
      probe: () => ({ currentDatabase: "stell22_dev" }),
      spawn: () => {
        spawned = true;
        return { status: 0 };
      },
    }));
    expect(error.code).toBe("IDENTITY_MISMATCH");
    expect(spawned).toBe(false);
  });

  it("spawns migrate only with the explicit disposable URL outside the repository", () => {
    let seen: { cwd: string; databaseUrl: string | undefined } | undefined;
    const result = runDisposableMigrate({
      databaseUrl: URL,
      cwd: OUTSIDE,
      schemaPath: path.join(OUTSIDE, "schema.prisma"),
      repositoryRoot: REPOSITORY,
      parentEnv: {
        PATH: "C:\\Windows",
        DATABASE_URL: "postgresql://stell22:stell22@localhost:5434/stell22_dev",
      },
      probe: () => ({ currentDatabase: "p1iso_abc123" }),
      spawn: (request) => {
        seen = { cwd: request.cwd, databaseUrl: request.env.DATABASE_URL };
        expect(request.env.DATABASE_URL).toBe(URL);
        expect(Object.keys(request.env).some((key) => key.toUpperCase() === "DATABASE_URL" && request.env[key]?.includes("stell22_dev"))).toBe(false);
        return { status: 0 };
      },
    });
    expect(result.status).toBe(0);
    expect(seen).toEqual({ cwd: OUTSIDE, databaseUrl: URL });
  });
});
