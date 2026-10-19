import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { P1_MIGRATION_PATH } from "@/server/internal/p1-isolated-runner/contract";
import { createCoordinator } from "@/server/internal/p1-write-freeze-coordinator/coordinator";
import {
  COORDINATOR_ROLES,
  CoordinatorFault,
  type ActivityRow,
  type BackupPort,
  type Binding,
  type CatalogPort,
  type Probe,
  type RestrictionReport,
  type TestOwnedApproval,
  type UnfreezeFacts,
  type WriterRow,
} from "@/server/internal/p1-write-freeze-coordinator/contract";

const denied: Probe = { ok: false, sqlstate: "42501" };
const selected: Probe = { ok: true, sqlstate: null };

function binding(patch: Partial<Binding> = {}): Binding {
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
    ...patch,
  };
}

function writer(name: string, patch: Partial<WriterRow> = {}): WriterRow {
  return {
    name,
    superuser: name === "stell22" || name === "p1wc_breakglass",
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
    canlogin: name !== "PUBLIC",
    inherit: true,
    memberships: [],
    setRoles: [],
    databaseCreate: false,
    schemaCreate: false,
    databaseOwner: name === "p1wc_migrator",
    tableWrite: false,
    columnWrite: false,
    sequenceMutation: false,
    securityDefinerExecute: false,
    sessions: 0,
    transactions: 0,
    ...patch,
  };
}

function baseRows(writing: boolean): WriterRow[] {
  return [
    writer("p1wc_app", { tableWrite: writing, sequenceMutation: writing, columnWrite: writing, schemaCreate: writing }),
    writer("p1wc_migrator"),
    writer("p1wc_breakglass"),
    writer("stell22"),
    writer("PUBLIC", { tableWrite: writing, columnWrite: writing }),
  ];
}

function probes(frozen: boolean): RestrictionReport {
  const write = frozen ? denied : { ok: true, sqlstate: null };
  return {
    setRoleInsert: write,
    loginSelect: selected,
    loginInsert: write,
    loginUpdate: write,
    loginDelete: write,
    loginTruncate: write,
    loginNextval: write,
    loginSetval: write,
    loginCreate: denied,
    loginSetRole: denied,
    securityDefiner: denied,
  };
}

class FakePort implements CatalogPort {
  phase: "normal" | "frozen" = "normal";
  live = binding();
  alive = true;
  sameContainer = true;
  adminOk = true;
  activityRows: ActivityRow[] = [];
  remaining: number[] = [];
  grants: boolean | "unknown" = true;
  digest = "digest-1";
  p1: "committed" | "failed" | "ambiguous" = "committed";
  p1Shown = false;
  unfreezeFacts: UnfreezeFacts | "unknown" = {
    databaseOwner: "p1wc_migrator",
    applicationRole: "p1wc_app",
    applicationSuperuser: false,
    applicationCreate: false,
    migratorSuperuser: false,
    migratorCreate: true,
    containerId: "a".repeat(64),
    startedAt: "2026-10-19T00:00:00.000000000Z",
  };
  writes = 0;
  restores = 0;
  dumps = 0;
  unfreezeCommits = 0;
  fault: CoordinatorFault["point"] | null = null;
  rows: WriterRow[] | null = null;

  readIdentity(): Binding {
    return this.live;
  }
  administrator() {
    return this.adminOk
      ? { ok: true as const, user: "p1wc_breakglass" }
      : { ok: false as const, sqlstate: "28P01" };
  }
  inventory(): WriterRow[] {
    return this.rows ?? baseRows(this.phase === "normal");
  }
  commitFreeze() {
    if (this.fault === "before-commit") throw new CoordinatorFault("before-commit");
    this.phase = "frozen";
    if (this.fault === "after-commit") throw new CoordinatorFault("after-commit");
    return { ok: true as const };
  }
  activity(): ActivityRow[] {
    return this.activityRows;
  }
  terminate(pids: readonly number[]) {
    if (this.fault === "during-drain") throw new CoordinatorFault("during-drain");
    return { terminated: pids.filter((pid) => !this.remaining.includes(pid)), remaining: [...this.remaining] };
  }
  restrictions(): RestrictionReport {
    return probes(this.phase === "frozen");
  }
  logicalDigest(): string {
    return this.digest;
  }
  grantsAreFreeze(): boolean | "unknown" {
    return this.phase === "frozen" ? this.grants : false;
  }
  unfreezePreconditions() {
    return this.unfreezeFacts;
  }
  commitUnfreeze() {
    this.unfreezeCommits += 1;
    this.phase = "normal";
    return { ok: true as const };
  }
  ordinaryWrite(): Probe {
    this.writes += 1;
    return this.phase === "normal" ? { ok: true, sqlstate: null } : denied;
  }
  applyP1() {
    if (this.p1 === "failed") return { outcome: "failed" as const, sqlstate: "42P01" };
    this.p1Shown = true;
    if (this.fault === "after-p1-commit") throw new CoordinatorFault("after-p1-commit");
    return { outcome: this.p1, sqlstate: null };
  }
  p1Visible(): boolean | "unknown" {
    return this.p1Shown;
  }
  applicationAlive(): boolean {
    return this.alive;
  }
  containerUnchanged(): boolean {
    return this.sameContainer;
  }
  checkpoint(point: CoordinatorFault["point"]): void {
    if (this.fault === point) throw new CoordinatorFault(point);
  }
}

function backup(port: FakePort, fail: "dump" | "restore" | null = null): BackupPort & { restoreCalls: number } {
  return {
    restoreCalls: 0,
    dump() {
      port.dumps += 1;
      if (fail === "dump") return { ok: false as const, reason: "dump failed" };
      return { ok: true as const, digest: port.digest };
    },
    restore() {
      port.restores += 1;
      if (fail === "restore") return { ok: false as const, reason: "restore failed" };
      return { ok: true as const, digest: port.digest };
    },
  };
}

function approval(kind: TestOwnedApproval["kind"], digest: string, nonce: string, patch: Partial<TestOwnedApproval> = {}): TestOwnedApproval {
  return {
    scope: "TEST_OWNED",
    kind,
    invocationId: binding().invocationId,
    nonce,
    notBefore: "2026-10-19T00:00:00.000Z",
    notAfter: "2026-10-19T00:15:00.000Z",
    databaseName: "p1wc_abcdef12",
    containerId: "a".repeat(64),
    daemonId: "daemon-a",
    digest,
    ...patch,
  };
}

function world(port = new FakePort(), fail: "dump" | "restore" | null = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-p1wc-"));
  const coordinator = createCoordinator({
    directory,
    binding: binding(),
    roles: COORDINATOR_ROLES,
    port,
    backup: backup(port, fail),
    clock: () => new Date("2026-10-19T00:01:00.000Z"),
  });
  return { directory, coordinator, port };
}

const pinned = pinnedMigration();

describe("disposable write-freeze coordinator", () => {
  it("freezes, preserves the logical digest, and unfreezes only after a separate approval", () => {
    const { coordinator } = world();
    expect(coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32))).state).toBe(
      "FREEZE_REQUESTED",
    );
    const frozen = coordinator.freeze();
    expect(frozen.state).toBe("FROZEN_VERIFIED");
    expect(frozen.code).toContain("does not stop a superuser");
    expect(coordinator.head().logicalDigest).toBe("digest-1");
    expect(coordinator.head().privilegePhase).toBe("committed");
    expect(coordinator.backupAndRestore().state).toBe("AWAITING_OWNER_AUTHORIZATION");
    expect(coordinator.acceptP1(approval("P1_APPLY", "digest-1", "2".repeat(32))).state).toBe("P1_APPLY");
    expect(coordinator.applyPinnedP1(pinned).state).toBe("P1_POSTCHECK");
    expect(coordinator.postcheck()).toMatchObject({ state: "P1_POSTCHECK", ok: true });
    expect(coordinator.unfreeze(approval("FREEZE_REQUEST", "digest-1", "3".repeat(32))).code).toBe("KIND");
    expect(coordinator.unfreeze(approval("UNFREEZE", "digest-1", "3".repeat(32))).state).toBe("NORMAL");
    expect(coordinator.head().note).toContain("DDL remains revoked");
  });

  it("keeps the freeze when backup, restore, approval, P1, or postcheck fails", () => {
    const dumped = world(new FakePort(), "dump");
    dumped.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    dumped.coordinator.freeze();
    expect(dumped.coordinator.backupAndRestore().state).toBe("BLOCKED");
    expect(dumped.port.restores).toBe(0);
    expect(dumped.port.unfreezeCommits).toBe(0);

    const restored = world(new FakePort(), "restore");
    restored.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    restored.coordinator.freeze();
    expect(restored.coordinator.backupAndRestore().state).toBe("BLOCKED");
    expect(restored.coordinator.unfreeze(approval("UNFREEZE", "digest-1", "3".repeat(32))).code).toBe(
      "UNFREEZE_PRECONDITION",
    );

    const waiting = reachAwaiting();
    const expired = waiting.coordinator.acceptP1(
      approval("P1_APPLY", "digest-1", "2".repeat(32), { notAfter: "2026-10-19T00:00:30.000Z" }),
    );
    expect(expired).toMatchObject({ state: "AWAITING_OWNER_AUTHORIZATION", code: "EXPIRED" });
    expect(waiting.coordinator.head().consumedNonces).not.toContain("2".repeat(32));

    const failed = reachApply(new FakePort());
    failed.port.p1 = "failed";
    expect(failed.coordinator.applyPinnedP1(pinned)).toMatchObject({ state: "BLOCKED", sqlstate: "42P01" });
    expect(failed.coordinator.rejectDestructiveRestore().code).toBe("DESTRUCTIVE_RESTORE_FORBIDDEN");
    expect(failed.port.restores).toBe(1);

    const ambiguous = reachApply(new FakePort());
    ambiguous.port.fault = "after-p1-commit";
    expect(ambiguous.coordinator.applyPinnedP1(pinned).state).toBe("MANUAL_RECOVERY_REQUIRED");
    expect(ambiguous.coordinator.rejectDestructiveRestore().state).toBe("MANUAL_RECOVERY_REQUIRED");
    expect(ambiguous.coordinator.reread().code).toBe("INVALID_TRANSITION");

    const post = reachApply(new FakePort());
    post.coordinator.applyPinnedP1(pinned);
    post.port.p1Shown = false;
    expect(post.coordinator.postcheck().state).toBe("BLOCKED");
    expect(post.coordinator.unfreeze(approval("UNFREEZE", "digest-1", "9".repeat(32))).code).toBe("UNFREEZE_PRECONDITION");
  });

  it("fails closed across crash windows and does not verify a privileged session", () => {
    const before = world();
    before.port.fault = "before-commit";
    before.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    expect(before.coordinator.freeze().state).toBe("FREEZE_REQUESTED");
    expect(before.coordinator.head().privilegePhase).toBe("rolled-back");
    expect(before.port.phase).toBe("normal");

    const after = world();
    after.port.fault = "after-commit";
    after.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    expect(after.coordinator.freeze().state).toBe("UNCERTAIN");
    expect(after.coordinator.head().privilegePhase).toBe("committed");
    expect(after.coordinator.head().state).not.toBe("FROZEN_VERIFIED");

    const draining = world();
    draining.port.fault = "during-drain";
    draining.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    expect(draining.coordinator.freeze().state).toBe("UNCERTAIN");

    const verified = world();
    verified.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    verified.port.fault = "after-verified";
    expect(verified.coordinator.freeze().state).toBe("FROZEN_VERIFIED");

    const privileged = world();
    privileged.port.activityRows = [{ pid: 7, user: "stell22", inTransaction: true }];
    privileged.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    expect(privileged.coordinator.freeze().state).toBe("UNCERTAIN");
    expect(privileged.coordinator.freeze().code).not.toBe("FROZEN_VERIFIED");
  });

  it("rejects repeated requests, a wrong daemon, a torn journal, and a second actor", () => {
    const { coordinator, directory, port } = world();
    coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    coordinator.freeze();
    expect(coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "4".repeat(32))).code).toBe(
      "INVALID_TRANSITION",
    );
    expect(coordinator.unfreeze(approval("UNFREEZE", "digest-1", "5".repeat(32))).code).toBe("UNFREEZE_PRECONDITION");
    port.live = binding({ daemonId: "other-daemon" });
    expect(coordinator.backupAndRestore()).toMatchObject({ state: "UNCERTAIN", code: "IDENTITY_UNREADABLE" });

    const torn = world();
    torn.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    fs.appendFileSync(path.join(torn.directory, "journal.ndjson"), "{\"torn\":");
    expect(torn.coordinator.freeze().state).toBe("UNCERTAIN");

    const held = world();
    fs.writeFileSync(path.join(held.directory, "journal.lock"), "held");
    expect(held.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32))).code).toBe(
      "LOCK_HELD",
    );
    expect(directory.length).toBeGreaterThan(0);
  });

  it("does not declare a freeze for a missing administrator, an unknown writer, or a pin mismatch", () => {
    const missing = world();
    missing.port.adminOk = false;
    missing.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    expect(missing.coordinator.freeze()).toMatchObject({ state: "BLOCKED", sqlstate: "28P01" });
    expect(missing.port.phase).toBe("normal");

    const unknown = world();
    unknown.port.rows = [...baseRows(true), writer("intruder", { superuser: false, tableWrite: true })];
    unknown.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
    expect(unknown.coordinator.freeze().state).toBe("BLOCKED");
    expect(unknown.port.phase).toBe("normal");

    const pinnedWorld = reachApply(new FakePort());
    expect(pinnedWorld.coordinator.applyPinnedP1("not the pinned file").code).toBe("P1_PIN_MISMATCH");
    expect(pinnedWorld.coordinator.head().state).toBe("P1_APPLY");
    expect(pinnedWorld.coordinator.acceptP1(approval("P1_APPLY", "digest-1", "2".repeat(32))).code).toBe("REPLAY");
  });
});

function pinnedMigration(): string {
  const shown = spawnSync("git", ["show", `HEAD:${P1_MIGRATION_PATH}`], { encoding: "utf8" });
  if (shown.status !== 0) throw new Error("pinned P1 file is unreadable");
  return shown.stdout ?? "";
}

function reachAwaiting() {
  const item = world();
  item.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
  item.coordinator.freeze();
  item.coordinator.backupAndRestore();
  return item;
}

function reachApply(port: FakePort) {
  const item = world(port);
  item.coordinator.requestFreeze(approval("FREEZE_REQUEST", "freeze-request", "1".repeat(32)));
  item.coordinator.freeze();
  item.coordinator.backupAndRestore();
  item.coordinator.acceptP1(approval("P1_APPLY", "digest-1", "2".repeat(32)));
  return item;
}
