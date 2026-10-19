import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { P1_MIGRATION_PATH, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { releaseInvocation, type DockerWorld, type Invocation } from "@/server/internal/p1-write-freeze-coordinator/cleanup";
import {
  containerStartedAt,
  createBusinessDatabase,
  createCluster,
  destroyCluster,
  sql,
  startBackgroundSql,
  stopBackgroundSql,
  type Cluster,
} from "@/server/internal/p1-write-freeze-coordinator/cluster";
import { createCoordinator, type Coordinator } from "@/server/internal/p1-write-freeze-coordinator/coordinator";
import { COORDINATOR_ROLES, type Binding, type TestOwnedApproval } from "@/server/internal/p1-write-freeze-coordinator/contract";
import { livePort, type LiveHandle } from "@/server/internal/p1-write-freeze-coordinator/live-port";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
let cluster: Cluster | undefined;
let supervisor: ChildProcess | undefined;

describe.skipIf(!LIVE)("disposable PostgreSQL 17 write-freeze coordinator", () => {

  beforeAll(() => {
    supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", windowsHide: true });
    cluster = createCluster();
  }, 180_000);

  afterAll(() => {
    stopBackgroundSql();
    if (supervisor && supervisor.exitCode === null) supervisor.kill();
    if (cluster) destroyCluster(cluster);
  }, 180_000);

  it("keeps the application and database identities while business writes stay denied", () => {
    const fixture = openFixture();
    const version = one(sql(cluster!, "breakglass", "SELECT current_setting('server_version');", fixture.database));
    expect(version.startsWith("17.")).toBe(true);
    const before = fixture.port.logicalDigest();
    startBackgroundSql(
      cluster!,
      "app",
      fixture.database,
      "BEGIN; INSERT INTO p1wc_inventory (id, sku, qty) VALUES (2, 'open', 1); SELECT pg_sleep(40); COMMIT;",
    );
    waitForUser(fixture, "p1wc_app");
    fixture.coordinator.requestFreeze(approval(fixture.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    const frozen = fixture.coordinator.freeze();
    expect(frozen.state).toBe("FROZEN_VERIFIED");
    expect(frozen.code).toContain("does not stop a superuser");
    expect(one(sql(cluster!, "breakglass", "SELECT count(*)::text FROM p1wc_inventory WHERE id = 1;", fixture.database))).toBe("1");
    expect(one(sql(cluster!, "breakglass", "SELECT count(*)::text FROM p1wc_inventory WHERE id = 2;", fixture.database))).toBe("0");
    expect(fixture.port.logicalDigest()).toBe(before);
    const inserted = sql(cluster!, "app", "INSERT INTO p1wc_inventory (id, sku, qty) VALUES (3, 'new', 1);", fixture.database);
    expect(inserted.sqlstate).toBe("42501");
    const nextval = sql(cluster!, "app", "SELECT nextval('p1wc_business_seq');", fixture.database);
    expect(nextval.sqlstate).toBe("42501");
    const created = sql(cluster!, "app", "CREATE TABLE p1wc_should_not_exist (id int);", fixture.database);
    expect(created.sqlstate).toBe("42501");
    const setRole = sql(cluster!, "app", "SET ROLE p1wc_migrator;", fixture.database);
    expect(setRole.sqlstate).toBe("42501");
    const hidden = sql(cluster!, "app", "SELECT p1wc_hidden_write();", fixture.database);
    expect(hidden.sqlstate).toBe("42501");
    const selected = sql(cluster!, "app", "SELECT count(*)::text FROM p1wc_inventory;", fixture.database);
    expect(selected.status).toBe(0);
    expect(fixture.coordinator.backupAndRestore().state).toBe("AWAITING_OWNER_AUTHORIZATION");
    const expired = fixture.coordinator.acceptP1(
      approval(fixture.binding, "P1_APPLY", fixture.coordinator.head().backupDigest ?? "", nonce(), true),
    );
    expect(expired).toMatchObject({ state: "AWAITING_OWNER_AUTHORIZATION", code: "EXPIRED" });
    expect(fixture.coordinator.acceptP1(approval(fixture.binding, "P1_APPLY", fixture.coordinator.head().backupDigest ?? "", nonce())).state).toBe(
      "P1_APPLY",
    );
    const pinned = pinnedSql();
    expect(sha(pinned)).toBe(P1_SHA256);
    expect(fixture.coordinator.applyPinnedP1(pinned).state).toBe("P1_POSTCHECK");
    expect(fixture.coordinator.postcheck().ok).toBe(true);
    const duringP1 = sql(cluster!, "app", pinned, fixture.database);
    expect(duringP1.status).not.toBe(0);
    expect(fixture.port.logicalDigest()).toBe(before);
    expect(fixture.coordinator.unfreeze(approval(fixture.binding, "UNFREEZE", before, nonce())).state).toBe("NORMAL");
    const resumed = sql(cluster!, "app", "INSERT INTO p1wc_inventory (id, sku, qty) VALUES (4, 'resumed', 1);", fixture.database);
    expect(resumed.status).toBe(0);
    expect(sql(cluster!, "app", "CREATE TABLE p1wc_still_denied (id int);", fixture.database).sqlstate).toBe("42501");
    expect(containerStartedAt(cluster!)).toBe(cluster!.startedAt);
    expect(cluster!.containerId).toBe(fixture.binding.containerId);
    expect(supervisorAlive()).toBe(true);
    stopBackgroundSql();
  }, 420_000);

  it("does not verify a freeze while a bootstrap superuser session is open", () => {
    const fixture = openFixture();
    startBackgroundSql(cluster!, "bootstrap", fixture.database, "BEGIN; INSERT INTO p1wc_inventory (id, sku, qty) VALUES (8, 'super', 1); SELECT pg_sleep(30); COMMIT;");
    waitForUser(fixture, "stell22");
    fixture.coordinator.requestFreeze(approval(fixture.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    const result = fixture.coordinator.freeze();
    expect(result.state).toBe("UNCERTAIN");
    expect(result.state).not.toBe("FROZEN_VERIFIED");
    const stillWrites = sql(cluster!, "bootstrap", "INSERT INTO p1wc_inventory (id, sku, qty) VALUES (9, 'super-new', 1);", fixture.database);
    expect(stillWrites.status).toBe(0);
    expect(fixture.coordinator.unfreeze(approval(fixture.binding, "UNFREEZE", "digest", nonce())).code).toBe("UNFREEZE_PRECONDITION");
    stopBackgroundSql();
  }, 180_000);

  it("rolls back an uncommitted freeze and stays uncertain after a committed revoke without a drain", () => {
    const before = openFixture();
    before.port.setFault("before-commit");
    before.coordinator.requestFreeze(approval(before.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    expect(before.coordinator.freeze().state).toBe("FREEZE_REQUESTED");
    expect(sql(cluster!, "app", "INSERT INTO p1wc_inventory (id, sku, qty) VALUES (11, 'still', 1);", before.database).status).toBe(0);

    const after = openFixture();
    startBackgroundSql(cluster!, "app", after.database, "BEGIN; INSERT INTO p1wc_inventory (id, sku, qty) VALUES (12, 'late', 1); SELECT pg_sleep(8); COMMIT;");
    waitForUser(after, "p1wc_app");
    after.port.setFault("after-commit");
    after.coordinator.requestFreeze(approval(after.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    expect(after.coordinator.freeze().state).toBe("UNCERTAIN");
    expect(after.coordinator.head().privilegePhase).toBe("committed");
    expect(sql(cluster!, "app", "INSERT INTO p1wc_inventory (id, sku, qty) VALUES (13, 'denied', 1);", after.database).sqlstate).toBe("42501");
    expect(waitForRow(after.database, 12)).toBe("1");
    expect(after.coordinator.rejectDestructiveRestore().code).toBe("DESTRUCTIVE_RESTORE_FORBIDDEN");

    const draining = openFixture();
    draining.port.setFault("during-drain");
    draining.coordinator.requestFreeze(approval(draining.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    expect(draining.coordinator.freeze().state).toBe("UNCERTAIN");
    expect(draining.coordinator.reread().state).toBe("FROZEN_VERIFIED");
    stopBackgroundSql();
  }, 240_000);

  it("keeps the freeze after a failed or ambiguous pinned P1 and refuses a source restore", () => {
    const failed = openFixture();
    prepare(failed);
    expect(sql(cluster!, "bootstrap", 'ALTER TABLE "BatchCreationCommand" ADD COLUMN "receiptProvenanceSnapshot" jsonb;', failed.database).status).toBe(0);
    expect(failed.coordinator.applyPinnedP1(pinnedSql())).toMatchObject({ state: "BLOCKED" });
    expect(sql(cluster!, "app", "INSERT INTO p1wc_inventory (id, sku, qty) VALUES (21, 'blocked', 1);", failed.database).sqlstate).toBe("42501");
    expect(failed.coordinator.rejectDestructiveRestore().state).toBe("BLOCKED");

    const ambiguous = openFixture();
    prepare(ambiguous);
    ambiguous.port.setFault("after-p1-commit");
    expect(ambiguous.coordinator.applyPinnedP1(pinnedSql()).state).toBe("MANUAL_RECOVERY_REQUIRED");
    expect(one(sql(cluster!, "breakglass", "SELECT count(*)::text FROM information_schema.columns WHERE column_name = 'receiptProvenanceSnapshot';", ambiguous.database))).toBe("1");
    expect(ambiguous.coordinator.rejectDestructiveRestore().code).toBe("DESTRUCTIVE_RESTORE_FORBIDDEN");
    expect(sql(cluster!, "app", "INSERT INTO p1wc_inventory (id, sku, qty) VALUES (22, 'manual', 1);", ambiguous.database).sqlstate).toBe("42501");
  }, 420_000);

  it("records a missing administrator and leaves a foreign daemon's container in place", () => {
    const database = createBusinessDatabase(cluster!);
    const port = livePort({ cluster: cluster!, database, applicationPid: supervisorPid(), missingAdministrator: true });
    const binding = port.readIdentity();
    const coordinator = coordinatorFor(port, binding);
    coordinator.requestFreeze(approval(binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    const result = coordinator.freeze();
    expect(result.state).toBe("BLOCKED");
    expect(result.sqlstate).toMatch(/28(000|P01)/);
    const report = releaseInvocation(invocationOf(cluster!), foreignWorld());
    expect(report.removed).toEqual([]);
    const inspect = spawnSync("docker", ["inspect", cluster!.containerId], { encoding: "utf8", windowsHide: true });
    expect(inspect.status).toBe(0);
  }, 180_000);

  it("stops backup, approval, apply, postcheck, and unfreeze when privileged authority appears after the freeze", () => {
    const beforeBackup = openFixture();
    beforeBackup.coordinator.requestFreeze(approval(beforeBackup.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    expect(beforeBackup.coordinator.freeze().state).toBe("FROZEN_VERIFIED");
    startBackgroundSql(cluster!, "bootstrap", beforeBackup.database, "SELECT pg_sleep(30);");
    waitForUser(beforeBackup, "stell22");
    expect(beforeBackup.coordinator.backupAndRestore().state).toBe("UNCERTAIN");
    expect(beforeBackup.coordinator.head().state).not.toBe("AWAITING_OWNER_AUTHORIZATION");
    expect(beforeBackup.coordinator.unfreeze(approval(beforeBackup.binding, "UNFREEZE", "digest", nonce())).code).toBe(
      "UNFREEZE_PRECONDITION",
    );
    expect(beforeBackup.coordinator.rejectDestructiveRestore().code).toBe("DESTRUCTIVE_RESTORE_FORBIDDEN");
    stopBackgroundSql();

    const beforeApproval = openFixture();
    beforeApproval.coordinator.requestFreeze(approval(beforeApproval.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    expect(beforeApproval.coordinator.freeze().state).toBe("FROZEN_VERIFIED");
    expect(beforeApproval.coordinator.backupAndRestore().state).toBe("AWAITING_OWNER_AUTHORIZATION");
    startBackgroundSql(cluster!, "migrator", beforeApproval.database, "SELECT pg_sleep(30);");
    waitForUser(beforeApproval, "p1wc_migrator");
    expect(beforeApproval.coordinator.acceptP1(approval(beforeApproval.binding, "P1_APPLY", beforeApproval.coordinator.head().backupDigest ?? "", nonce())).state).toBe(
      "BLOCKED",
    );
    expect(beforeApproval.coordinator.head().state).not.toBe("P1_APPLY");
    expect(beforeApproval.coordinator.applyPinnedP1(pinnedSql()).code).toBe("INVALID_TRANSITION");
    stopBackgroundSql();

    const beforeApply = openFixture();
    prepare(beforeApply);
    startBackgroundSql(cluster!, "migrator", beforeApply.database, "SELECT pg_sleep(30);");
    waitForUser(beforeApply, "p1wc_migrator");
    expect(beforeApply.coordinator.applyPinnedP1(pinnedSql()).state).toBe("BLOCKED");
    expect(
      one(
        sql(
          cluster!,
          "breakglass",
          "SELECT count(*)::text FROM information_schema.columns WHERE column_name = 'receiptProvenanceSnapshot';",
          beforeApply.database,
        ),
      ),
    ).toBe("0");
    stopBackgroundSql();

    const beforePostcheck = openFixture();
    prepare(beforePostcheck);
    expect(beforePostcheck.coordinator.applyPinnedP1(pinnedSql()).state).toBe("P1_POSTCHECK");
    startBackgroundSql(cluster!, "bootstrap", beforePostcheck.database, "SELECT pg_sleep(30);");
    waitForUser(beforePostcheck, "stell22");
    expect(beforePostcheck.coordinator.postcheck().state).toBe("UNCERTAIN");
    expect(beforePostcheck.coordinator.unfreeze(approval(beforePostcheck.binding, "UNFREEZE", "digest", nonce())).code).toBe(
      "UNFREEZE_PRECONDITION",
    );
    stopBackgroundSql();

    const beforeUnfreeze = openFixture();
    prepare(beforeUnfreeze);
    expect(beforeUnfreeze.coordinator.applyPinnedP1(pinnedSql()).state).toBe("P1_POSTCHECK");
    expect(beforeUnfreeze.coordinator.postcheck().ok).toBe(true);
    startBackgroundSql(cluster!, "breakglass", beforeUnfreeze.database, "SELECT pg_sleep(30);");
    waitForUser(beforeUnfreeze, "p1wc_breakglass");
    expect(beforeUnfreeze.coordinator.unfreeze(approval(beforeUnfreeze.binding, "UNFREEZE", beforeUnfreeze.coordinator.head().logicalDigest ?? "", nonce())).state).toBe(
      "UNCERTAIN",
    );
    expect(sql(cluster!, "app", "INSERT INTO p1wc_inventory (id, sku, qty) VALUES (31, 'still-frozen', 1);", beforeUnfreeze.database).sqlstate).toBe(
      "42501",
    );
    stopBackgroundSql();

    const granted = openFixture();
    granted.coordinator.requestFreeze(approval(granted.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    expect(granted.coordinator.freeze().state).toBe("FROZEN_VERIFIED");
    expect(sql(cluster!, "breakglass", "GRANT INSERT ON p1wc_inventory TO p1wc_app;", granted.database).status).toBe(0);
    expect(granted.coordinator.backupAndRestore().state).toBe("BLOCKED");

    const publicGrant = openFixture();
    publicGrant.coordinator.requestFreeze(approval(publicGrant.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    expect(publicGrant.coordinator.freeze().state).toBe("FROZEN_VERIFIED");
    expect(sql(cluster!, "breakglass", "GRANT UPDATE (qty) ON p1wc_inventory TO PUBLIC;", publicGrant.database).status).toBe(0);
    expect(publicGrant.coordinator.backupAndRestore().state).toBe("BLOCKED");

    const changed = openFixture();
    changed.coordinator.requestFreeze(approval(changed.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    expect(changed.coordinator.freeze().state).toBe("FROZEN_VERIFIED");
    expect(sql(cluster!, "breakglass", "UPDATE p1wc_inventory SET qty = qty + 1 WHERE id = 1;", changed.database).status).toBe(0);
    const stopped = changed.coordinator.backupAndRestore();
    expect(stopped.state).toBe("BLOCKED");
    expect(stopped.code).toBe("DIGEST");
    expect(changed.coordinator.rejectDestructiveRestore().state).toBe("BLOCKED");

    const restored = openFixture();
    restored.coordinator.requestFreeze(approval(restored.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
    const frozen = restored.coordinator.freeze();
    expect(frozen.state).toBe("FROZEN_VERIFIED");
    expect(frozen.code).toContain("equal digests do not prove");
    expect(one(sql(cluster!, "breakglass", "SELECT qty::text FROM p1wc_inventory WHERE id = 1;", restored.database))).toBe("4");
    const changedRow = sql(cluster!, "breakglass", "UPDATE p1wc_inventory SET qty = qty + 1 WHERE id = 1;", restored.database);
    expect(changedRow.status, changedRow.stderr).toBe(0);
    const cleared = sql(cluster!, "breakglass", "DELETE FROM p1wc_finance WHERE id = 1001;", restored.database);
    expect(cleared.status, cleared.stderr).toBe(0);
    const reverted = sql(cluster!, "breakglass", "UPDATE p1wc_inventory SET qty = 4 WHERE id = 1;", restored.database);
    expect(reverted.status, reverted.stderr).toBe(0);
    const clearedAgain = sql(cluster!, "breakglass", "DELETE FROM p1wc_finance WHERE id = 1001;", restored.database);
    expect(clearedAgain.status, clearedAgain.stderr).toBe(0);
    expect(restored.coordinator.backupAndRestore().state).toBe("AWAITING_OWNER_AUTHORIZATION");
  }, 1_500_000);
});

function openFixture() {
  const database = createBusinessDatabase(cluster!);
  const port = livePort({ cluster: cluster!, database, applicationPid: supervisorPid() });
  const binding = port.readIdentity();
  return { database, port, binding, coordinator: coordinatorFor(port, binding) };
}

function coordinatorFor(port: LiveHandle, binding: Binding): Coordinator {
  return createCoordinator({
    directory: fs.mkdtempSync(path.join(os.tmpdir(), "stell22-p1wc-")),
    binding,
    roles: COORDINATOR_ROLES,
    port,
    backup: port,
    clock: () => new Date(),
  });
}

function prepare(fixture: { coordinator: Coordinator; binding: Binding }) {
  fixture.coordinator.requestFreeze(approval(fixture.binding, "FREEZE_REQUEST", "freeze-request", nonce()));
  expect(fixture.coordinator.freeze().state).toBe("FROZEN_VERIFIED");
  expect(fixture.coordinator.backupAndRestore().state).toBe("AWAITING_OWNER_AUTHORIZATION");
  expect(
    fixture.coordinator.acceptP1(approval(fixture.binding, "P1_APPLY", fixture.coordinator.head().backupDigest ?? "", nonce())).state,
  ).toBe("P1_APPLY");
}

function approval(
  binding: Binding,
  kind: TestOwnedApproval["kind"],
  digest: string,
  id: string,
  expired = false,
): TestOwnedApproval {
  const now = Date.now();
  return {
    scope: "TEST_OWNED",
    kind,
    invocationId: binding.invocationId,
    nonce: id,
    notBefore: new Date(now - (expired ? 120_000 : 1_000)).toISOString(),
    notAfter: new Date(now + (expired ? -60_000 : 10 * 60_000)).toISOString(),
    databaseName: binding.databaseName,
    containerId: binding.containerId,
    daemonId: binding.daemonId,
    digest,
  };
}

function waitForUser(fixture: { port: LiveHandle }, user: string): void {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (fixture.port.activity().some((row) => row.user === user)) return;
    sleep(250);
  }
  throw new Error(`session for ${user} did not appear`);
}

function waitForRow(database: string, id: number): string {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const count = one(sql(cluster!, "breakglass", `SELECT count(*)::text FROM p1wc_inventory WHERE id = ${id};`, database));
    if (count === "1") return count;
    sleep(500);
  }
  return one(sql(cluster!, "breakglass", `SELECT count(*)::text FROM p1wc_inventory WHERE id = ${id};`, database));
}

let nonceCount = 0;

function nonce(): string {
  nonceCount += 1;
  return nonceCount.toString(16).padStart(32, "a");
}

function one(result: { status: number | null; stdout: string; stderr: string; sqlstate: string | null }): string {
  if (result.status !== 0) throw new Error(`sql failed ${result.sqlstate ?? ""} ${result.stderr.slice(0, 400)}`);
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "SET");
  return lines[lines.length - 1] ?? "";
}

function supervisorPid(): number {
  const pid = supervisor?.pid;
  if (!pid) throw new Error("application supervisor is not running");
  return pid;
}

function supervisorAlive(): boolean {
  try {
    process.kill(supervisorPid(), 0);
    return true;
  } catch {
    return false;
  }
}

function pinnedSql(): string {
  const shown = spawnSync("git", ["show", `HEAD:${P1_MIGRATION_PATH}`], { encoding: "utf8" });
  if (shown.status !== 0) throw new Error("pinned P1 file is unreadable");
  return shown.stdout ?? "";
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invocationOf(owned: Cluster): Invocation {
  return {
    endpoint: owned.endpoint,
    daemonId: owned.daemonId,
    imageId: owned.imageId,
    names: {
      runId: owned.runId,
      containerName: owned.containerName,
      networkName: owned.networkName,
      volumeName: owned.volumeName,
    },
    networkCreated: true,
    volumeCreated: true,
    containerId: owned.containerId,
    containerPhase: "confirmed",
  };
}

function foreignWorld(): DockerWorld {
  return {
    endpoint: () => "tcp://10.1.1.1:2375",
    daemonId: () => "foreign-daemon",
    exec: () => {
      throw new Error("foreign daemon was asked to remove a resource");
    },
  };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
