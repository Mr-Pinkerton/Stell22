import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  successfulHistoricalRows,
  successfulP1Row,
  type PrismaMigrationRow,
} from "@/server/internal/p1-isolated-runner/classify";
import {
  OWNED_CONTAINER_LABEL,
  POSTGRES_IMAGE_REF,
  createOwnedDisposableContainer,
  type OriginRuntime,
  type OwnedContainerHandle,
} from "@/server/internal/p1-isolated-runner/container-origin";
import type { ProbeSqlClient } from "@/server/internal/p1-isolated-runner/live-read-probe";
import {
  assessOwnedDisposablePreapply,
  type OwnedPreapplyDiagnostic,
} from "@/server/internal/p1-isolated-runner/owned-preapply-gate";

const RUN = "11111111-1111-4111-8111-111111111111";
const ID = "a".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const DAEMON = "daemon-local-1";
const STARTED = "2026-10-12T00:00:00.000000000Z";
const PORT = 54321;
const PASSWORD = "ab".repeat(24);
const NONCE = "cd".repeat(24);
const DATABASE = `p1disp_${RUN.replaceAll("-", "")}`;

describe("owned disposable pre-apply gate", () => {
  it("refuses a forged handle before Docker or SQL", async () => {
    const runtime = scripted();
    let connected = false;
    const result = await assessOwnedDisposablePreapply(
      { containerId: ID } as OwnedContainerHandle,
      {
        runtime,
        connect: async () => {
          connected = true;
          throw new Error(PASSWORD);
        },
      },
    );
    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    expect(result.reason).toBe("binding");
    expect(result.bindingKind).toBe("ownership-not-confirmed");
    expect(result.code).toBe("OWNERSHIP_UNPROVEN");
    expect(result.executionAuthorized).toBe(false);
    expect(connected).toBe(false);
    expect(runtime.commands).toEqual([]);
    expect(sealed(result)).toBe(true);
    expect(textOf(result).includes(PASSWORD)).toBe(false);
  });

  it("refuses Docker drift before SQL", async () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    runtime.env = { DOCKER_HOST: "unix:///var/run/docker.sock" };
    let connected = false;
    const result = await assessOwnedDisposablePreapply(handle, {
      runtime,
      connect: async () => {
        connected = true;
        throw new Error("should not connect");
      },
    });
    expect(result).toMatchObject({
      status: "refused",
      reason: "binding",
      bindingKind: "docker-identity-drift",
      code: "DOCKER_ENDPOINT_CHANGED",
      executionAuthorized: false,
    });
    expect(connected).toBe(false);
  });

  it("refuses Docker drift after SQL", async () => {
    const runtime = scripted();
    const handle = createOwnedDisposableContainer(runtime);
    const result = await assessOwnedDisposablePreapply(handle, {
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
      status: "refused",
      reason: "binding",
      bindingKind: "docker-identity-drift",
      code: "DAEMON_IDENTITY_CHANGED",
      executionAuthorized: false,
    });
    expect(sealed(result)).toBe(true);
  });

  it("refuses connection, session, history, catalog, and incomplete SQL reads", async () => {
    const unavailable = await bound({ failConnect: true });
    expect(unavailable).toMatchObject({
      status: "refused",
      reason: "binding",
      bindingKind: "connection-unavailable",
      code: "CONNECTION_UNAVAILABLE",
      executionAuthorized: false,
    });
    expect(textOf(unavailable).includes(PASSWORD)).toBe(false);

    await expect(bound({ failExecute: true })).resolves.toMatchObject({
      status: "refused",
      bindingKind: "session-continuity-failure",
      code: "TRANSACTION_INIT_FAILED",
    });
    for (const failQuery of ["history", "catalog", "history-incomplete"] as const) {
      const failed = await bound({ failQuery });
      expect(failed).toMatchObject({
        status: "refused",
        reason: "binding",
        bindingKind: "sql-query-failed",
        code: "QUERY_FAILED",
        executionAuthorized: false,
      });
      expect(failed.status).not.toBe("diagnostic-ready");
    }
  });

  it("does not treat an injected connector as live PostgreSQL readiness", async () => {
    const stopped = await bound({});
    expect(stopped).toMatchObject({
      status: "refused",
      reason: "not-live-proof",
      bindingKind: "injected-not-live-proof",
      executionAuthorized: false,
    });
    expect(stopped.classification).toMatchObject({ verdict: "STOP" });
    expect(stopped.status).not.toBe("not-ready");

    const ready = await bound({ history: "historical" });
    expect(ready).toMatchObject({
      status: "refused",
      reason: "not-live-proof",
      executionAuthorized: false,
    });
    expect(ready.classification).toMatchObject({
      verdict: "READY_FOR_DISPOSABLE_APPLY",
      code: "P1_ABSENT",
    });
    expect(ready.status).not.toBe("diagnostic-ready");

    const blocked = await bound({ history: "unfinished-p1" });
    expect(blocked).toMatchObject({
      status: "refused",
      reason: "not-live-proof",
      executionAuthorized: false,
    });
    expect(blocked.classification).toMatchObject({ verdict: "BLOCKED" });
    expect(blocked.status).not.toBe("not-ready");
    expect(textOf(blocked).includes(NONCE)).toBe(false);
    expect(textOf(blocked).includes(PASSWORD)).toBe(false);
    expect(textOf(blocked).includes("postgresql://")).toBe(false);
    expect(sealed(blocked)).toBe(true);
  });

  it("does not authorize execution from this module", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/server/internal/p1-isolated-runner/owned-preapply-gate.ts"),
      "utf8",
    );
    expect(source.includes("executeDisposableApply")).toBe(false);
    expect(source.includes("migrate")).toBe(false);
    expect(source.includes("CREATE TABLE")).toBe(false);
    expect(source.includes("applyEnabled: true")).toBe(false);
  });
});

function sealed(result: OwnedPreapplyDiagnostic): boolean {
  return (
    result.executionAuthorized === false &&
    result.publicAuthorization.containerOrigin === "NOT_ESTABLISHED" &&
    result.publicAuthorization.fullTargetAuthentication === "NOT_CLAIMED" &&
    result.publicAuthorization.applyEnabled === false
  );
}

function textOf(result: OwnedPreapplyDiagnostic): string {
  return JSON.stringify(result);
}

async function bound(patch: SqlPatch): Promise<OwnedPreapplyDiagnostic> {
  const runtime = scripted();
  const handle = createOwnedDisposableContainer(runtime);
  return assessOwnedDisposablePreapply(handle, {
    runtime,
    connect: async (url) => {
      if (patch.failConnect) throw new Error(PASSWORD);
      const parsed = new URL(url);
      expect(parsed.hostname).toBe("127.0.0.1");
      expect(parsed.username).toBe("p1disp");
      return client(url, patch);
    },
  });
}

type SqlPatch = {
  failConnect?: boolean;
  failExecute?: boolean;
  failQuery?: "history" | "catalog" | "history-incomplete";
  history?: "historical" | "unfinished-p1";
  onEnd?: () => void;
};

function client(url: string, patch: SqlPatch = {}): ProbeSqlClient {
  return {
    readOnlySnapshot: async (fn) =>
      fn({
        execute: async () => {
          if (patch.failExecute) throw new Error("set failed");
        },
        query: async (sql) => {
          if (sql.includes("pg_backend_pid")) return [sessionRow()];
          if (sql.includes("current_database")) {
            return [{ current_database: DATABASE, server_version_num: 170004 }];
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
          if (sql.includes("_prisma_migrations")) return historyRows(patch.history);
          if (sql.includes("stell22_p1_disposable_identity")) {
            return [{ run_id: RUN, nonce: NONCE, container_id: ID }];
          }
          if (sql.includes("foreign_key_count")) return [{ foreign_key_count: 0 }];
          return [];
        },
      }),
    end: async () => {
      patch.onEnd?.();
      void url;
    },
  };
}

function historyRows(mode: SqlPatch["history"]): Record<string, unknown>[] {
  if (!mode) return [];
  const rows = successfulHistoricalRows();
  if (mode === "unfinished-p1") {
    const p1 = successfulP1Row();
    rows.push({ ...p1, finishedAt: null, appliedStepsCount: 0 });
  }
  return rows.map(sqlHistoryRow);
}

function sqlHistoryRow(row: PrismaMigrationRow): Record<string, unknown> {
  return {
    migration_name: row.migrationName,
    checksum: row.checksum,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    rolled_back_at: row.rolledBackAt,
    applied_steps_count: row.appliedStepsCount,
  };
}

function sessionRow(): Record<string, unknown> {
  return {
    transaction_read_only: "on",
    statement_timeout: "5000ms",
    lock_timeout: "2000ms",
    search_path: "pg_catalog",
    transaction_isolation: "repeatable read",
    backend_pid: 7,
    snapshot_id: "10:10:10",
  };
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
      if (action === "image") return JSON.stringify([{ Id: IMAGE_ID, RepoDigests: null }]);
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
    Config: { Image: POSTGRES_IMAGE_REF, Labels: { [OWNED_CONTAINER_LABEL]: RUN } },
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
