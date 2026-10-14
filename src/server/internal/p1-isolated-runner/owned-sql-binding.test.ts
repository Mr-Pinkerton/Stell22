import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OWNED_CONTAINER_LABEL,
  POSTGRES_IMAGE_REF,
  createOwnedDisposableContainer,
  removeOwnedDisposableContainer,
  type OriginRuntime,
  type OwnedContainerHandle,
} from "@/server/internal/p1-isolated-runner/container-origin";
import {
  bindOwnedDisposableSql,
  type OwnedSqlBindingResult,
} from "@/server/internal/p1-isolated-runner/owned-sql-binding";
import type { ProbeSqlClient } from "@/server/internal/p1-isolated-runner/live-read-probe";

const RUN = "11111111-1111-4111-8111-111111111111";
const ID = "a".repeat(64);
const OTHER_ID = "c".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const DAEMON = "daemon-local-1";
const STARTED = "2026-10-12T00:00:00.000000000Z";
const PORT = 54321;
const PASSWORD = "ab".repeat(24);
const NONCE = "cd".repeat(24);
const DATABASE = `p1disp_${RUN.replaceAll("-", "")}`;

describe("owned disposable SQL binding", () => {
  it("refuses a forged handle before Docker or SQL", async () => {
    const runtime = scripted();
    let connected = false;
    const result = await bindOwnedDisposableSql({ containerId: ID } as OwnedContainerHandle, {
      runtime,
      connect: async () => {
        connected = true;
        throw new Error("should not connect");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("ownership-not-confirmed");
    expect(result.code).toBe("OWNERSHIP_UNPROVEN");
    expect(result.publicAuthorization.applyEnabled).toBe(false);
    expect(connected).toBe(false);
    expect(runtime.commands).toEqual([]);
    expect(authorizesApply(result)).toBe(false);
  });

  it("refuses endpoint, daemon, replacement, stop, restart, and port drift before SQL", async () => {
    const cases: Array<{ prepare: (runtime: ScriptedRuntime) => void; code: string }> = [
      {
        prepare: (runtime) => {
          runtime.env = { DOCKER_HOST: "unix:///var/run/docker.sock" };
        },
        code: "DOCKER_ENDPOINT_CHANGED",
      },
      {
        prepare: (runtime) => {
          runtime.daemonId = "daemon-local-2";
          runtime.daemonIds = [];
        },
        code: "DAEMON_IDENTITY_CHANGED",
      },
      {
        prepare: (runtime) => {
          runtime.inspectId = OTHER_ID;
        },
        code: "INSPECT_ID_MISMATCH",
      },
      {
        prepare: (runtime) => {
          runtime.inspectMutator = (row) => {
            row.State = { Running: false, Status: "exited", StartedAt: STARTED, Pid: 0 };
          };
        },
        code: "CONTAINER_STOPPED",
      },
      {
        prepare: (runtime) => {
          runtime.inspectMutator = (row) => {
            row.State = {
              Running: true,
              Status: "running",
              StartedAt: "2026-10-12T00:00:01.000000000Z",
              Pid: 99,
            };
          };
        },
        code: "CONTAINER_RESTARTED",
      },
      {
        prepare: (runtime) => {
          runtime.inspectMutator = (row) => {
            row.NetworkSettings = {
              Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54329" }] },
            };
          };
        },
        code: "PORT_CHANGED",
      },
    ];
    for (const item of cases) {
      const runtime = scripted();
      const handle = createOwnedDisposableContainer(runtime);
      runtime.commands.length = 0;
      item.prepare(runtime);
      let connected = false;
      const result = await bindOwnedDisposableSql(handle, {
        runtime,
        connect: async () => {
          connected = true;
          throw new Error("should not connect");
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.kind).toBe("docker-identity-drift");
      expect(result.code).toBe(item.code);
      expect(result.publicAuthorization.applyEnabled).toBe(false);
      expect(connected).toBe(false);
      expect(authorizesApply(result)).toBe(false);
    }
  });

  it("reports connection and transaction failures without apply authorization", async () => {
    const first = scriptedOwned();
    const unavailable = await bindOwnedDisposableSql(first.handle, {
      runtime: first.runtime,
      connect: async () => {
        throw new Error(`down ${PASSWORD}`);
      },
    });
    expect(unavailable).toMatchObject({
      ok: false,
      kind: "connection-unavailable",
      code: "CONNECTION_UNAVAILABLE",
    });
    expect(textOf(unavailable).includes(PASSWORD)).toBe(false);

    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    const init = await bindOwnedDisposableSql(handle, {
      runtime,
      connect: async (url) => client(url, { failExecute: true }),
    });
    expect(init).toMatchObject({
      ok: false,
      kind: "session-continuity-failure",
      code: "TRANSACTION_INIT_FAILED",
    });
    expect(init.publicAuthorization.applyEnabled).toBe(false);
  });

  it("refuses a missing identity table, an empty identity, and duplicate rows", async () => {
    await expect(bound({ identity: "absent-table" })).resolves.toMatchObject({
      ok: false,
      kind: "sql-identity-missing",
      code: "MISSING_IDENTITY_TABLE",
    });
    await expect(bound({ identity: "empty" })).resolves.toMatchObject({
      ok: false,
      kind: "sql-identity-missing",
      code: "MISSING_DISPOSABLE_IDENTITY",
    });
    await expect(bound({ identity: "duplicate" })).resolves.toMatchObject({
      ok: false,
      kind: "sql-identity-mismatch",
      code: "DUPLICATE_IDENTITY_ROW",
    });
  });

  it("refuses the wrong database, version, run id, nonce, and container id", async () => {
    await expect(bound({ databaseName: "postgres" })).resolves.toMatchObject({
      ok: false,
      kind: "sql-identity-mismatch",
      code: "WRONG_DATABASE_IDENTITY",
    });
    await expect(bound({ serverVersionNum: 160000 })).resolves.toMatchObject({
      ok: false,
      kind: "sql-identity-mismatch",
      code: "WRONG_DATABASE_IDENTITY",
    });
    await expect(bound({ runId: "22222222-2222-4222-8222-222222222222" })).resolves.toMatchObject({
      ok: false,
      kind: "sql-identity-mismatch",
      code: "DISPOSABLE_IDENTITY_MISMATCH",
    });
    const nonce = await bound({ nonce: "e".repeat(32) });
    expect(nonce).toMatchObject({
      ok: false,
      kind: "sql-identity-mismatch",
      code: "DISPOSABLE_NONCE_MISMATCH",
    });
    expect(textOf(nonce).includes(NONCE)).toBe(false);
    expect(textOf(nonce).includes(PASSWORD)).toBe(false);
    await expect(bound({ containerId: OTHER_ID })).resolves.toMatchObject({
      ok: false,
      kind: "sql-identity-mismatch",
      code: "DISPOSABLE_IDENTITY_MISMATCH",
    });
  });

  it("refuses a changed backend pid or snapshot", async () => {
    await expect(bound({ pidDrift: true })).resolves.toMatchObject({
      ok: false,
      kind: "session-continuity-failure",
      code: "CONNECTION_CONTINUITY_FAILED",
    });
    await expect(bound({ snapshotDrift: true })).resolves.toMatchObject({
      ok: false,
      kind: "session-continuity-failure",
      code: "SNAPSHOT_NOT_PROVEN",
    });
  });

  it("does not treat injected matching rows as live PostgreSQL proof", async () => {
    const result = await bound({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("injected-not-live-proof");
    expect(result.kind).not.toBe("sql-query-failed");
    expect(result.publicAuthorization).toMatchObject({
      containerOrigin: "NOT_ESTABLISHED",
      fullTargetAuthentication: "NOT_CLAIMED",
      applyEnabled: false,
    });
    expect(result.classification).toMatchObject({ verdict: "STOP" });
    expect(textOf(result).includes(NONCE)).toBe(false);
    expect(textOf(result).includes(PASSWORD)).toBe(false);
    expect(textOf(result).includes("postgresql://")).toBe(false);
  });

  it("refuses history and catalog failures after a valid identity", async () => {
    for (const failQuery of ["history", "catalog", "history-incomplete"] as const) {
      const result = await bound({ failQuery });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.kind).toBe("sql-query-failed");
      expect(result.kind).not.toBe("sql-identity-missing");
      expect(result.kind).not.toBe("verified-readonly-binding");
      expect(result.code).toBe("QUERY_FAILED");
      expect(result.publicAuthorization).toMatchObject({
        containerOrigin: "NOT_ESTABLISHED",
        fullTargetAuthentication: "NOT_CLAIMED",
        applyEnabled: false,
      });
      expect(textOf(result).includes(NONCE)).toBe(false);
      expect(textOf(result).includes(PASSWORD)).toBe(false);
      expect(textOf(result).includes("postgresql://")).toBe(false);
    }
  });

  it("reconfirms Docker after a failed SQL read and after a thrown client error", async () => {
    const missing = scripted();
    const missingHandle = createOwnedDisposableContainer(missing);
    const missingResult = await bindOwnedDisposableSql(missingHandle, {
      runtime: missing,
      connect: async (url) =>
        client(url, {
          identity: "absent-table",
          onEnd: () => {
            missing.daemonId = "daemon-local-2";
            missing.daemonIds = [];
          },
        }),
    });
    expect(missingResult).toMatchObject({
      ok: false,
      kind: "docker-identity-drift",
      code: "DAEMON_IDENTITY_CHANGED",
    });
    expect(missingResult.publicAuthorization.applyEnabled).toBe(false);

    const thrown = scripted();
    const thrownHandle = createOwnedDisposableContainer(thrown);
    const thrownResult = await bindOwnedDisposableSql(thrownHandle, {
      runtime: thrown,
      connect: async (url) =>
        client(url, {
          failEnd: true,
          onEnd: () => {
            thrown.daemonId = "daemon-local-2";
            thrown.daemonIds = [];
          },
        }),
    });
    expect(thrownResult.ok).toBe(false);
    if (!thrownResult.ok) expect(thrownResult.kind).toBe("docker-identity-drift");
    expect(textOf(thrownResult).includes(PASSWORD)).toBe(false);
    expect(textOf(thrownResult).includes(NONCE)).toBe(false);

    const stableThrow = await bound({ failEnd: true });
    expect(stableThrow).toMatchObject({
      ok: false,
      kind: "sql-query-failed",
      code: "SQL_QUERY_FAILED",
    });
    expect(textOf(stableThrow).includes(PASSWORD)).toBe(false);
    expect(textOf(stableThrow).includes("postgresql://")).toBe(false);
  });

  it("refuses Docker drift after the SQL read and does not clean up by a broad command", async () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    const result = await bindOwnedDisposableSql(handle, {
      runtime,
      connect: async (url) =>
        client(url, {
          onEnd: () => {
            runtime.daemonId = "daemon-local-2";
            runtime.daemonIds = [];
          },
        }),
    });
    expect(result).toMatchObject({
      ok: false,
      kind: "docker-identity-drift",
      code: "DAEMON_IDENTITY_CHANGED",
    });
    runtime.commands.length = 0;
    const removed = removal(() => removeOwnedDisposableContainer(handle, runtime));
    expect(removed.code).toBe("DAEMON_IDENTITY_CHANGED");
    expect(removed.disposition).toEqual({
      kind: "orphaned",
      containerId: ID,
      cleanup: "refused",
    });
    expect(runtime.commands.some((command) => verb(command.args) === "rm")).toBe(false);
    expect(runtime.commands.some((command) => command.args.includes("prune"))).toBe(false);
  });

  it("does not authorize migration or apply from this module", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/server/internal/p1-isolated-runner/owned-sql-binding.ts"),
      "utf8",
    );
    expect(source.includes("executeDisposableApply")).toBe(false);
    expect(source.includes("migrate")).toBe(false);
    expect(source.includes("migration.sql")).toBe(false);
    expect(source.includes("CREATE TABLE")).toBe(false);
  });
});

function authorizesApply(result: OwnedSqlBindingResult): boolean {
  return result.publicAuthorization.applyEnabled !== false;
}

function textOf(result: OwnedSqlBindingResult): string {
  return JSON.stringify(result);
}

async function bound(patch: SqlPatch): Promise<OwnedSqlBindingResult> {
  const { runtime, handle } = scriptedOwned();
  return bindOwnedDisposableSql(handle, {
    runtime,
    connect: async (url) => {
      const parsed = new URL(url);
      expect(parsed.hostname).toBe("127.0.0.1");
      expect(parsed.port).toBe(String(handle.port));
      expect(decodeURIComponent(parsed.pathname.replace(/^\//, ""))).toBe(handle.databaseName);
      expect(parsed.username).toBe("p1disp");
      return client(url, patch);
    },
  });
}

function scriptedOwned(): { runtime: ScriptedRuntime; handle: OwnedContainerHandle } {
  const runtime = scripted();
  return { runtime, handle: createOwnedDisposableContainer(runtime) };
}

type SqlPatch = {
  failExecute?: boolean;
  databaseName?: string;
  serverVersionNum?: number;
  runId?: string;
  nonce?: string;
  containerId?: string;
  identity?: "absent-table" | "empty" | "duplicate";
  pidDrift?: boolean;
  snapshotDrift?: boolean;
  onEnd?: () => void;
  failQuery?: "history" | "catalog" | "history-incomplete";
  failEnd?: boolean;
};

function client(url: string, patch: SqlPatch = {}): ProbeSqlClient {
  let sessionReads = 0;
  return {
    readOnlySnapshot: async (fn) =>
      fn({
        execute: async () => {
          if (patch.failExecute) throw new Error("set failed");
        },
        query: async (sql) => {
          if (sql.includes("pg_backend_pid")) {
            sessionReads += 1;
            const drifted = sessionReads > 1;
            return [
              sessionRow(
                patch.pidDrift && drifted ? 8 : 7,
                patch.snapshotDrift && drifted ? "11:11:11" : "10:10:10",
              ),
            ];
          }
          if (sql.includes("current_database")) {
            return [
              {
                current_database: patch.databaseName ?? DATABASE,
                server_version_num: patch.serverVersionNum ?? 170004,
              },
            ];
          }
          if (patch.failQuery === "history" && sql.includes("_prisma_migrations")) {
            throw new Error("history query failed");
          }
          if (patch.failQuery === "history-incomplete" && sql.includes("_prisma_migrations")) {
            return { failed: false };
          }
          if (patch.failQuery === "catalog" && sql.includes("receiptProvenanceSnapshot")) {
            throw new Error("catalog query failed");
          }
          if (sql.includes("stell22_p1_disposable_identity")) {
            if (patch.identity === "absent-table") {
              const error = new Error("missing") as Error & { meta?: { code?: string } };
              error.meta = { code: "42P01" };
              throw error;
            }
            if (patch.identity === "empty") return [];
            const row = {
              run_id: patch.runId ?? RUN,
              nonce: patch.nonce ?? NONCE,
              container_id: patch.containerId ?? ID,
            };
            return patch.identity === "duplicate" ? [row, row] : [row];
          }
          if (sql.includes("foreign_key_count")) return [{ foreign_key_count: 0 }];
          return [];
        },
      }),
    end: async () => {
      patch.onEnd?.();
      void url;
      if (patch.failEnd) throw new Error(PASSWORD);
    },
  };
}

function sessionRow(pid: number, snapshot: string): Record<string, unknown> {
  return {
    transaction_read_only: "on",
    statement_timeout: "5000ms",
    lock_timeout: "2000ms",
    search_path: "pg_catalog",
    transaction_isolation: "repeatable read",
    backend_pid: pid,
    snapshot_id: snapshot,
  };
}

function removal(run: () => void): { code: string; disposition: unknown } {
  try {
    run();
  } catch (error) {
    const refusal = error as { code?: string; disposition?: unknown };
    return { code: refusal.code ?? "", disposition: refusal.disposition };
  }
  throw new Error("expected cleanup refusal");
}

function verb(args: readonly string[]): string {
  return args[0] === "-H" ? (args[2] ?? "") : (args[0] ?? "");
}

type ScriptedCommand = { command: string; args: readonly string[] };

type ScriptedRuntime = OriginRuntime & {
  commands: ScriptedCommand[];
  daemonIds: string[];
  daemonId: string;
  inspectId: string;
  inspectMutator: ((row: Record<string, unknown>) => void) | null;
};

function scripted(): ScriptedRuntime {
  const runtime: ScriptedRuntime = {
    platform: "win32",
    env: {},
    homedir: path.join("K:", "docker-config"),
    commands: [],
    daemonIds: [DAEMON],
    daemonId: DAEMON,
    inspectId: ID,
    inspectMutator: null,
    randomUUID: () => RUN,
    randomBytes: (() => {
      let calls = 0;
      return () => Buffer.from(calls++ === 0 ? PASSWORD : NONCE, "hex");
    })(),
    readFile: () => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
    execFileSync: (command, args) => {
      runtime.commands.push({ command, args });
      if (command !== "docker" || args[0] !== "-H" || args.length < 3) {
        throw new Error("unpinned docker command");
      }
      const action = args[2];
      if (action === "info") {
        const next = runtime.daemonIds.shift();
        if (next !== undefined) runtime.daemonId = next;
        return `${runtime.daemonId}\n`;
      }
      if (action === "image") {
        return JSON.stringify([{ Id: IMAGE_ID, RepoDigests: null }]);
      }
      if (action === "run") return `${ID}\n`;
      if (action === "inspect") {
        return JSON.stringify(
          document((row) => {
            row.Id = runtime.inspectId;
            runtime.inspectMutator?.(row);
          }),
        );
      }
      if (action === "rm") return ID;
      throw new Error(`unexpected docker args ${action ?? ""}`);
    },
  };
  return runtime;
}

function document(patch?: (row: Record<string, unknown>) => void): unknown {
  const row: Record<string, unknown> = {
    Id: ID,
    Name: `/${`stell22-p1-disposable-${RUN}`}`,
    Image: IMAGE_ID,
    Config: {
      Image: POSTGRES_IMAGE_REF,
      Labels: { [OWNED_CONTAINER_LABEL]: RUN },
    },
    State: { Running: true, Status: "running", StartedAt: STARTED, Pid: 7 },
    HostConfig: {
      NetworkMode: "bridge",
      PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
    },
    NetworkSettings: {
      Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT) }] },
    },
  };
  patch?.(row);
  return [row];
}
