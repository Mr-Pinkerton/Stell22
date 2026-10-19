import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { P1_MIGRATION_PATH, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { COORDINATOR_ROLES, type Binding, type CatalogPort } from "@/server/internal/p1-write-freeze-coordinator/contract";
import { classifyJournalLock, openJournal } from "@/server/internal/p1-write-freeze-coordinator/journal";

export { P1_SHA256, COORDINATOR_ROLES };

export function crashBinding(): Binding {
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

export function crashDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stell22-p1wc-crash-"));
}

export function pinnedSql(): string {
  const shown = spawnSync("git", ["show", `HEAD:${P1_MIGRATION_PATH}`], { encoding: "utf8" });
  if (shown.status !== 0) throw new Error("pinned P1 file is unreadable");
  return shown.stdout ?? "";
}

export function frozenPort(apply: CatalogPort["applyP1"]): CatalogPort {
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
    readIdentity: () => crashBinding(),
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

export function authorizeCrash(dir: string): void {
  const journal = openJournal(dir, crashBinding());
  journal.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
  journal.append("PRIVILEGE_COMMIT", { privilegePhase: "committed" });
  journal.append("BEGIN_DRAIN");
  journal.append("VERIFY_OK", { logicalDigest: "digest-1" });
  journal.append("BEGIN_BACKUP");
  journal.append("BACKUP_OK", { backupDigest: "digest-1" });
  journal.append("RESTORE_OK", { restoreDigest: "digest-1" });
  journal.append("P1_AUTHORIZED", { consumedNonces: ["1".repeat(32), "2".repeat(32)] });
}

export function spawnCrashChild(mode: string, dir: string, ownedFile = ""): { child: ChildProcess; signal: string } {
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
      P1WC_CRASH_OWNED: ownedFile,
    },
    windowsHide: true,
    stdio: "ignore",
  });
  return { child, signal };
}

export function waitForCrashSignal(file: string): void {
  const started = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - started > 60_000) throw new Error(`child did not reach ${path.basename(file)}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

export function killCrashChild(child: ChildProcess): void {
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

export function archiveCrashLock(dir: string): void {
  const lock = path.join(dir, "journal.lock");
  if (classifyJournalLock(dir).kind !== "STALE_UNVERIFIED" || !fs.existsSync(lock)) {
    throw new Error("crash lock is not a stale unverified lock");
  }
  fs.renameSync(lock, `${lock}.operator-archived`);
}

export function recordedCrashEvents(dir: string): string[] {
  return fs
    .readFileSync(path.join(dir, "journal.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { event?: string }).event ?? "");
}
