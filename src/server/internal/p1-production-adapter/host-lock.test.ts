import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import { acquireOperatorHostLock, operatorHostLockPath } from "@/server/internal/p1-production-adapter/host-lock";
import { planProductionOneShot, releaseProductionCredential } from "@/server/internal/p1-production-adapter/oneshot";
import { runOperatorCommand, type OperatorDocker } from "@/server/internal/p1-production-adapter/operator";

const ATTEMPT = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const IMAGE = `sha256:${"a".repeat(64)}`;

describe("operator host lock", () => {
  it("blocks a second attempt and does not steal a stale lock", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-host-lock-"));
    const lockPath = operatorHostLockPath("TEST_OWNED", root);
    try {
      const held = acquireOperatorHostLock(lockPath, { attemptId: ATTEMPT, command: "verify-recovery" });
      expect(() => acquireOperatorHostLock(lockPath, { attemptId: OTHER, command: "apply" })).toThrow(
        expect.objectContaining({ code: "HOST_LOCK_HELD" }),
      );
      const preserved = fs.readFileSync(lockPath, "utf8");
      held.release();
      expect(fs.existsSync(lockPath)).toBe(false);

      fs.writeFileSync(lockPath, preserved);
      expect(() => acquireOperatorHostLock(lockPath, { attemptId: OTHER, command: "apply" })).toThrow(
        expect.objectContaining({ code: "HOST_LOCK_HELD" }),
      );
      expect(fs.readFileSync(lockPath, "utf8")).toBe(preserved);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an unreadable lock and a lock directory without deleting them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-host-uncertain-"));
    const lockPath = operatorHostLockPath("TEST_OWNED", root);
    try {
      fs.writeFileSync(lockPath, "partial");
      expect(() => acquireOperatorHostLock(lockPath, { attemptId: ATTEMPT, command: "apply" })).toThrow(
        expect.objectContaining({ code: "HOST_LOCK_UNCERTAIN" }),
      );
      expect(fs.readFileSync(lockPath, "utf8")).toBe("partial");
      fs.rmSync(lockPath);
      fs.mkdirSync(lockPath);
      fs.writeFileSync(path.join(lockPath, "evidence"), "keep");
      expect(() => acquireOperatorHostLock(lockPath, { attemptId: ATTEMPT, command: "apply" })).toThrow(
        expect.objectContaining({ code: "HOST_LOCK_UNCERTAIN" }),
      );
      expect(fs.readFileSync(path.join(lockPath, "evidence"), "utf8")).toBe("keep");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not release a lock whose owner record changed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-host-owner-"));
    const lockPath = operatorHostLockPath("TEST_OWNED", root);
    try {
      const held = acquireOperatorHostLock(lockPath, { attemptId: ATTEMPT, command: "apply" });
      const replacement = `${JSON.stringify({
        kind: "P1_OPERATOR_HOST_LOCK",
        owner: "b".repeat(32),
        attemptId: OTHER,
        command: "apply",
      })}\n`;
      fs.writeFileSync(lockPath, replacement);
      expect(() => held.release()).toThrow(expect.objectContaining({ code: "HOST_LOCK_OWNER_MISMATCH" }));
      expect(fs.readFileSync(lockPath, "utf8")).toBe(replacement);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the lock directory cannot be created", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-host-storage-"));
    const parent = path.join(root, "not-a-directory");
    fs.writeFileSync(parent, "file");
    try {
      expect(() => acquireOperatorHostLock(path.join(parent, "p1-operator.host.lock"), { attemptId: ATTEMPT, command: "apply" })).toThrow(
        expect.objectContaining({ code: "HOST_LOCK_UNAVAILABLE" }),
      );
      expect(fs.readFileSync(parent, "utf8")).toBe("file");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps preflight off the host lock and stops a second attempt without touching Docker resources", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-host-commands-"));
    const calls: string[] = [];
    const docker: OperatorDocker = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "info") return { status: 0, signal: null, stdout: "daemon-test-1234\n", stderr: "" };
      if (args.includes("rm")) return { status: 0, signal: null, stdout: "", stderr: "" };
      return { status: 1, signal: null, stdout: "", stderr: "error: no such object: missing\n" };
    };
    const env = {
      PATH: process.env.PATH ?? "",
      DOCKER_HOST: process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock",
    };
    try {
      const preflight = runOperatorCommand({
        command: "preflight",
        scope: "TEST_OWNED",
        attemptId: ATTEMPT,
        workRoot: root,
        testEnv: env,
        testDocker: docker,
      });
      expect(preflight.code).not.toBe("HOST_LOCK_HELD");
      expect(fs.existsSync(operatorHostLockPath("TEST_OWNED", root))).toBe(false);

      const held = acquireOperatorHostLock(operatorHostLockPath("TEST_OWNED", root), { attemptId: ATTEMPT, command: "verify-recovery" });
      const before = fs.readFileSync(operatorHostLockPath("TEST_OWNED", root), "utf8");
      calls.length = 0;
      const recovery = runOperatorCommand({
        command: "verify-recovery",
        scope: "TEST_OWNED",
        attemptId: OTHER,
        workRoot: root,
        testEnv: env,
        testDocker: docker,
      });
      const apply = runOperatorCommand({
        command: "apply",
        scope: "TEST_OWNED",
        attemptId: ATTEMPT,
        workRoot: root,
        testEnv: env,
        testDocker: docker,
      });
      expect(recovery.code).toBe("HOST_LOCK_HELD");
      expect(apply.code).toBe("HOST_LOCK_HELD");
      expect(calls.some((call) => call.includes(" rm") || call.startsWith("rm"))).toBe(false);
      expect(fs.readFileSync(operatorHostLockPath("TEST_OWNED", root), "utf8")).toBe(before);
      held.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not follow a credential symlink while cleaning a production secret directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-credential-link-"));
    const credentialDir = path.join(root, "p1-production-credentials");
    const outside = path.join(root, "outside-secret");
    try {
      planProductionOneShot({
        networkName: "p1pa-net",
        dnsAlias: "db",
        databaseName: "stell22",
        roleName: "stell22",
        password: "super-secret-password-1",
        sealedRoot: root,
        credentialDir,
        appContainerId: "c".repeat(12),
        appContainerName: "app",
        dbContainerName: "db",
        imageId: IMAGE,
        ownerToken: ATTEMPT,
      });
      const secretPath = path.join(credentialDir, "database.env");
      fs.rmSync(secretPath);
      if (process.platform === "win32") {
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, "sentinel"), "keep-secret");
        fs.symlinkSync(outside, secretPath, "junction");
      } else {
        fs.writeFileSync(outside, "keep-secret");
        fs.symlinkSync(outside, secretPath, "file");
      }
      expect(() => releaseProductionCredential(credentialDir, ATTEMPT)).toThrow(expect.objectContaining({ code: "SECRET_CLEANUP_FAILED" }));
      const preserved = process.platform === "win32" ? path.join(outside, "sentinel") : outside;
      expect(fs.readFileSync(preserved, "utf8")).toBe("keep-secret");
      expect(fs.lstatSync(secretPath).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("host lock refusal type", () => {
  it("uses RunnerRefusal for a held lock", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-host-type-"));
    const lockPath = operatorHostLockPath("TEST_OWNED", root);
    try {
      const held = acquireOperatorHostLock(lockPath, { attemptId: ATTEMPT, command: "apply" });
      expect(() => acquireOperatorHostLock(lockPath, { attemptId: OTHER, command: "verify-recovery" })).toThrow(RunnerRefusal);
      held.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
