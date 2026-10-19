import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { P1_MIGRATION_PATH, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { createCoordinator } from "@/server/internal/p1-write-freeze-coordinator/coordinator";
import { COORDINATOR_ROLES, type Binding, type CatalogPort } from "@/server/internal/p1-write-freeze-coordinator/contract";
import { classifyJournalLock, openJournal } from "@/server/internal/p1-write-freeze-coordinator/journal";

const ROLE = process.env.P1WC_CRASH_ROLE ?? "";

function binding(): Binding {
  return {
    scope: "TEST_OWNED",
    invocationId: "12345678-1234-4234-8234-123456789abc",
    endpoint: "npipe:////./pipe/docker_engine",
    daemonId: "daemon-a",
    containerId: "a".repeat(64),
    imageId: `sha256:${"b".repeat(64)}`,
    startedAt: "2026-10-19T00:00:00.000000000Z",
    databaseName: "p1wc_abcdef12",
    databaseOid: "16384",
    systemIdentifier: "7400000000000000000",
    serverVersionNum: "170005",
    applicationPid: 4242,
  };
}

function directory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stell22-p1wc-crash-"));
}

function pinnedSql(): string {
  const shown = spawnSync("git", ["show", `HEAD:${P1_MIGRATION_PATH}`], { encoding: "utf8" });
  if (shown.status !== 0) throw new Error("pinned P1 file is unreadable");
  return shown.stdout ?? "";
}

function frozenPort(apply: CatalogPort["applyP1"]): CatalogPort {
  const denied = { ok: false, sqlstate: "42501" };
  const row = {
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
    canlogin: true,
    inherit: true,
    memberships: [] as string[],
    setRoles: [] as string[],
    databaseCreate: false,
    schemaCreate: false,
    databaseOwner: false,
    tableWrite: false,
    columnWrite: false,
    sequenceMutation: false,
    securityDefinerExecute: false,
    sessions: 0,
    transactions: 0,
  };
  return {
    readIdentity: () => binding(),
    administrator: () => ({ ok: true, user: "p1wc_breakglass" }),
    inventory: () => [
      { ...row, name: "p1wc_app" },
      { ...row, name: "p1wc_migrator", databaseOwner: true },
      { ...row, name: "p1wc_breakglass", superuser: true },
      { ...row, name: "stell22", superuser: true },
      { ...row, name: "PUBLIC", canlogin: false },
    ],
    commitFreeze: () => ({ ok: true }),
    activity: () => [],
    terminate: () => ({ terminated: [], remaining: [] }),
    restrictions: () => ({
      setRoleInsert: denied,
      loginSelect: { ok: true, sqlstate: null },
      loginInsert: denied,
      loginUpdate: denied,
      loginDelete: denied,
      loginTruncate: denied,
      loginNextval: denied,
      loginSetval: denied,
      loginCreate: denied,
      loginSetRole: denied,
      securityDefiner: denied,
    }),
    logicalDigest: () => "digest-1",
    grantsAreFreeze: () => true,
    unfreezePreconditions: () => "unknown",
    commitUnfreeze: () => ({ ok: false, sqlstate: null }),
    ordinaryWrite: () => denied,
    applyP1: apply,
    p1Visible: () => false,
    applicationAlive: () => true,
    containerUnchanged: () => true,
    checkpoint: () => undefined,
  };
}

function authorize(dir: string): void {
  const journal = openJournal(dir, binding());
  journal.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
  journal.append("PRIVILEGE_COMMIT", { privilegePhase: "committed" });
  journal.append("BEGIN_DRAIN");
  journal.append("VERIFY_OK", { logicalDigest: "digest-1" });
  journal.append("BEGIN_BACKUP");
  journal.append("BACKUP_OK", { backupDigest: "digest-1" });
  journal.append("RESTORE_OK", { restoreDigest: "digest-1" });
  journal.append("P1_AUTHORIZED", { consumedNonces: ["1".repeat(32), "2".repeat(32)] });
}

function hold(signal: string): never {
  fs.writeFileSync(signal, "ready\n");
  const gate = new Int32Array(new SharedArrayBuffer(4));
  while (true) Atomics.wait(gate, 0, 0, 1000);
}

function runChild(): void {
  const dir = process.env.P1WC_CRASH_DIR ?? "";
  const mode = process.env.P1WC_CRASH_MODE ?? "";
  const signal = process.env.P1WC_CRASH_SIGNAL ?? "";
  const container = process.env.P1WC_CRASH_CONTAINER ?? "";
  const coordinator = createCoordinator({
    directory: dir,
    binding: binding(),
    roles: COORDINATOR_ROLES,
    port: frozenPort(() => {
      if (mode !== "after-sql") return { outcome: "committed", sqlstate: null };
      const committed = spawnSync(
        "docker",
        ["exec", container, "psql", "-U", "stell22", "-d", "stell22", "-v", "ON_ERROR_STOP=1", "-c",
          "BEGIN; CREATE TABLE p1wc_crash_witness(id int primary key); INSERT INTO p1wc_crash_witness VALUES (1); COMMIT;"],
        { encoding: "utf8", windowsHide: true },
      );
      if (committed.status !== 0) throw new Error(committed.stderr.slice(0, 400));
      fs.writeFileSync(signal, "committed\n");
      hold(signal);
    }),
    backup: { dump: () => ({ ok: false, reason: "no" }), restore: () => ({ ok: false, reason: "no" }) },
    clock: () => new Date("2026-10-19T00:01:00.000Z"),
    probes: {
      beforeIntentFsync() {
        if (mode === "before-intent") hold(signal);
      },
      afterIntentFsync() {
        if (mode === "after-intent") hold(signal);
        if (mode === "exit-after-intent") {
          fs.writeFileSync(signal, "worker-exit\n");
          process.exit(0);
        }
      },
    },
  });
  coordinator.applyPinnedP1(pinnedSql());
}

function spawnChild(mode: string, dir: string, container = ""): { child: ChildProcess; signal: string } {
  const signal = path.join(dir, `signal-${mode}`);
  const child = spawn(process.execPath, ["scripts/vitest-run.mjs", "run", "src/server/internal/p1-write-freeze-coordinator/p1-intent-crash.test.ts"], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      P1WC_CRASH_ROLE: "child",
      P1WC_CRASH_MODE: mode,
      P1WC_CRASH_DIR: dir,
      P1WC_CRASH_SIGNAL: signal,
      P1WC_CRASH_CONTAINER: container,
    },
    windowsHide: true,
    stdio: "ignore",
  });
  return { child, signal };
}

function waitFor(file: string): void {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started > 60_000) throw new Error(`child did not reach ${path.basename(file)}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function killAndWait(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
  } else if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  const started = Date.now();
  while (child.exitCode === null && Date.now() - started < 15_000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function archiveStaleLock(dir: string): void {
  const lock = path.join(dir, "journal.lock");
  expect(classifyJournalLock(dir).kind).toBe("STALE_UNVERIFIED");
  expect(fs.existsSync(lock)).toBe(true);
  fs.renameSync(lock, `${lock}.operator-archived`);
}

function events(dir: string): string[] {
  return fs.readFileSync(path.join(dir, "journal.ndjson"), "utf8").split("\n").filter((line) => line.length > 0);
}

function recordedEvents(dir: string): string[] {
  return events(dir).map((line) => (JSON.parse(line) as { event?: string }).event ?? "");
}

function postgresImagePresent(): boolean {
  return spawnSync("docker", ["image", "inspect", "postgres:17-alpine"], { windowsHide: true, stdio: "ignore" }).status === 0;
}

describe.skipIf(ROLE === "child")("P1 intent process death", () => {
  it("does not start SQL when the process dies before the intent fsync", () => {
    const dir = directory();
    authorize(dir);
    const { child, signal } = spawnChild("before-intent", dir);
    waitFor(signal);
    killAndWait(child);
    expect(recordedEvents(dir)).not.toContain("P1_SPAWN_INTENT");
    expect(classifyJournalLock(dir).kind).toBe("STALE_UNVERIFIED");
    const calls = { count: 0 };
    const blocked = createCoordinator({
      directory: dir,
      binding: binding(),
      roles: COORDINATOR_ROLES,
      port: frozenPort(() => {
        calls.count += 1;
        return { outcome: "committed", sqlstate: null };
      }),
      backup: { dump: () => ({ ok: false, reason: "no" }), restore: () => ({ ok: false, reason: "no" }) },
      clock: () => new Date("2026-10-19T00:01:00.000Z"),
    });
    expect(blocked.applyPinnedP1(pinnedSql()).code).toBe("LOCK_STALE_UNVERIFIED");
    expect(calls.count).toBe(0);
    archiveStaleLock(dir);
    expect(openJournal(dir, binding()).head().state).toBe("P1_APPLY");
    expect(blocked.rejectDestructiveRestore().code).toBe("DESTRUCTIVE_RESTORE_FORBIDDEN");
  }, 120_000);

  it("fails closed after a durable intent when the process dies before SQL", () => {
    const dir = directory();
    authorize(dir);
    const { child, signal } = spawnChild("after-intent", dir);
    waitFor(signal);
    killAndWait(child);
    expect(recordedEvents(dir)).toContain("P1_SPAWN_INTENT");
    expect(recordedEvents(dir)).not.toContain("P1_COMMITTED");
    archiveStaleLock(dir);
    const heads = [openJournal(dir, binding()).head(), openJournal(dir, binding()).head(), openJournal(dir, binding()).head()];
    expect(heads[0]).toEqual(heads[1]);
    expect(heads[1]).toEqual(heads[2]);
    expect(heads[2].state).toBe("MANUAL_RECOVERY_REQUIRED");
    expect(heads[2].p1Status).toBe("ambiguous");
    const calls = { count: 0 };
    const blocked = createCoordinator({
      directory: dir,
      binding: binding(),
      roles: COORDINATOR_ROLES,
      port: frozenPort(() => {
        calls.count += 1;
        return { outcome: "committed", sqlstate: null };
      }),
      backup: { dump: () => ({ ok: false, reason: "no" }), restore: () => ({ ok: false, reason: "no" }) },
      clock: () => new Date("2026-10-19T00:01:00.000Z"),
    });
    expect(blocked.applyPinnedP1(pinnedSql()).code).toBe("INVALID_TRANSITION");
    expect(calls.count).toBe(0);
    expect(blocked.unfreeze({
      scope: "TEST_OWNED",
      kind: "UNFREEZE",
      invocationId: binding().invocationId,
      nonce: "3".repeat(32),
      notBefore: "2026-10-19T00:00:00.000Z",
      notAfter: "2026-10-19T00:15:00.000Z",
      databaseName: binding().databaseName,
      containerId: binding().containerId,
      daemonId: binding().daemonId,
      digest: "digest-1",
    }).code).toBe("UNFREEZE_PRECONDITION");
    expect(blocked.rejectDestructiveRestore().code).toBe("DESTRUCTIVE_RESTORE_FORBIDDEN");
  }, 120_000);

  it("reopens after the child exits with a durable intent and no SQL call", () => {
    const dir = directory();
    authorize(dir);
    const { child, signal } = spawnChild("exit-after-intent", dir);
    waitFor(signal);
    killAndWait(child);
    if (fs.existsSync(path.join(dir, "journal.lock"))) archiveStaleLock(dir);
    const head = openJournal(dir, binding()).head();
    expect(head.state).toBe("MANUAL_RECOVERY_REQUIRED");
    expect(head.p1Sha).toBe(P1_SHA256);
    expect(recordedEvents(dir)).not.toContain("P1_COMMITTED");
  }, 120_000);

  it.skipIf(!postgresImagePresent())("does not append P1_COMMITTED or retry after a killed process commits disposable SQL", () => {
    const name = `stell22-p1wc-crash-${Date.now().toString(16)}`;
    const started = spawnSync("docker", ["run", "-d", "--pull", "never", "--restart", "no", "--name", name,
      "-e", "POSTGRES_PASSWORD=stell22", "-e", "POSTGRES_USER=stell22", "-e", "POSTGRES_DB=stell22",
      "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17-alpine"], { encoding: "utf8", windowsHide: true });
    expect(started.status).toBe(0);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
        const probe = spawnSync("docker", ["exec", name, "pg_isready", "-U", "stell22", "-d", "stell22"], { windowsHide: true });
        ready = probe.status === 0;
        if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
      expect(ready).toBe(true);
      const dir = directory();
      authorize(dir);
      const { child, signal } = spawnChild("after-sql", dir, name);
      waitFor(signal);
      killAndWait(child);
      const count = spawnSync("docker", ["exec", name, "psql", "-U", "stell22", "-d", "stell22", "-At", "-c", "SELECT count(*) FROM p1wc_crash_witness;"], { encoding: "utf8", windowsHide: true });
      expect(count.stdout.trim()).toBe("1");
      expect(recordedEvents(dir)).toContain("P1_SPAWN_INTENT");
      expect(recordedEvents(dir)).not.toContain("P1_COMMITTED");
      archiveStaleLock(dir);
      expect(openJournal(dir, binding()).head().state).toBe("MANUAL_RECOVERY_REQUIRED");
      const calls = { count: 0 };
      const blocked = createCoordinator({
        directory: dir,
        binding: binding(),
        roles: COORDINATOR_ROLES,
        port: frozenPort(() => {
          calls.count += 1;
          return { outcome: "committed", sqlstate: null };
        }),
        backup: { dump: () => ({ ok: false, reason: "no" }), restore: () => ({ ok: false, reason: "no" }) },
        clock: () => new Date("2026-10-19T00:01:00.000Z"),
      });
      expect(blocked.applyPinnedP1(pinnedSql()).code).toBe("INVALID_TRANSITION");
      expect(calls.count).toBe(0);
      expect(blocked.rejectDestructiveRestore().code).toBe("DESTRUCTIVE_RESTORE_FORBIDDEN");
      const still = spawnSync("docker", ["exec", name, "psql", "-U", "stell22", "-d", "stell22", "-At", "-c", "SELECT count(*) FROM p1wc_crash_witness;"], { encoding: "utf8", windowsHide: true });
      expect(still.stdout.trim()).toBe("1");
    } finally {
      spawnSync("docker", ["rm", "-f", name], { windowsHide: true });
    }
  }, 180_000);
});

describe.skipIf(ROLE !== "child")("P1 intent crash child", () => {
  it("runs the injected crash point", () => {
    runChild();
  }, 120_000);
});
