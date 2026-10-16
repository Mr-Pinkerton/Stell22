import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import { PRODUCTION_POSTGRES_IMAGE, testNetworkName, testRestoreName } from "@/server/internal/p1-production-adapter/contract";
import {
  disposablePostgresArgv,
  OPERATOR_LOCK_FILE,
  retireOwnedDisposable,
  runOperatorCommand,
  startOwnedDisposable,
  type OperatorDocker,
  type OperatorDockerResult,
  type OwnedDisposable,
} from "@/server/internal/p1-production-adapter/operator";

const ATTEMPT = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const PASSWORD = "super-secret-password-1";
const INVOCATION = "a".repeat(32);
const NETWORK_ID = "b".repeat(64);
const CONTAINER_ID = "c".repeat(64);
const REPLACEMENT_ID = "d".repeat(64);

describe("operator credential, ownership, and preflight boundaries", () => {
  it("keeps the disposable database password out of Docker arguments and deletes the env file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-operator-secret-"));
    const secretDirectory = path.join(root, ".restore-secret");
    const envFile = path.join(secretDirectory, "postgres.env");
    const seen: string[][] = [];
    const owned: OwnedDisposable[] = [];
    try {
      startOwnedDisposable({
        attemptId: ATTEMPT,
        invocationId: INVOCATION,
        name: testRestoreName(ATTEMPT),
        networkName: `${testNetworkName(ATTEMPT)}-restore`,
        image: PRODUCTION_POSTGRES_IMAGE,
        role: "stell22",
        database: "stell22",
        password: PASSWORD,
        secretDirectory,
        env: process.env,
        owned,
        invoke: (args) => {
          seen.push([...args]);
          expect(args.join("\n")).not.toContain(PASSWORD);
          expect(args.join("\n")).not.toContain("POSTGRES_PASSWORD=");
          expect(args.join("\n")).not.toMatch(/postgres(?:ql)?:\/\//i);
          if (args[0] === "network" && args[1] === "create") return ok(`${NETWORK_ID}\n`);
          if (args[0] === "run") {
            expect(fs.existsSync(envFile)).toBe(true);
            expect(fs.readFileSync(envFile, "utf8")).toContain(`POSTGRES_PASSWORD=${PASSWORD}\n`);
            if (process.platform !== "win32") expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
            return ok(`${CONTAINER_ID}\n`);
          }
          return missing();
        },
      });
      expect(fs.existsSync(envFile)).toBe(false);
      expect(fs.existsSync(secretDirectory)).toBe(false);
      expect(seen.some((args) => args[0] === "run" && args.includes("--env-file") && args.includes(envFile))).toBe(true);
      expect(owned.map((resource) => resource.id)).toEqual([NETWORK_ID, CONTAINER_ID]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes the env file when container creation fails and retires only the network id", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-operator-start-fail-"));
    const owned: OwnedDisposable[] = [];
    const removed: string[][] = [];
    try {
      expect(() =>
        startOwnedDisposable({
          attemptId: ATTEMPT,
          invocationId: INVOCATION,
          name: testRestoreName(ATTEMPT),
          networkName: `${testNetworkName(ATTEMPT)}-restore`,
          image: PRODUCTION_POSTGRES_IMAGE,
          role: "stell22",
          database: "stell22",
          password: PASSWORD,
          secretDirectory: path.join(root, ".restore-secret"),
          env: process.env,
          owned,
          invoke: (args) => {
            if (args[0] === "network" && args[1] === "create") return ok(`${NETWORK_ID}\n`);
            if (args[0] === "run") return { status: null, signal: "SIGTERM", stdout: "", stderr: "" };
            return missing();
          },
        }),
      ).toThrow(RunnerRefusal);
      expect(fs.existsSync(path.join(root, ".restore-secret"))).toBe(false);
      const networkName = `${testNetworkName(ATTEMPT)}-restore`;
      retireOwnedDisposable(owned, (args) => {
        removed.push([...args]);
        if (args[0] === "network" && args[1] === "inspect") {
          return ok(`${NETWORK_ID}|${networkName}|${INVOCATION}|${ATTEMPT}|disposable-restore-network\n`);
        }
        return ok("");
      }, process.env);
      expect(removed.map((args) => (args[0] === "network" && args[1] === "inspect" ? ["network", "inspect", NETWORK_ID] : args))).toEqual([
        ["network", "inspect", NETWORK_ID],
        ["network", "rm", NETWORK_ID],
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create credentials or delete anything when the network cannot be created", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-operator-net-fail-"));
    const owned: OwnedDisposable[] = [];
    const removed: string[][] = [];
    try {
      expect(() =>
        startOwnedDisposable({
          attemptId: ATTEMPT,
          invocationId: INVOCATION,
          name: testRestoreName(ATTEMPT),
          networkName: `${testNetworkName(ATTEMPT)}-restore`,
          image: PRODUCTION_POSTGRES_IMAGE,
          role: "stell22",
          database: "stell22",
          password: PASSWORD,
          secretDirectory: path.join(root, ".restore-secret"),
          env: process.env,
          owned,
          invoke: (args) => {
            if (args[0] === "network" && args[1] === "create") return missing();
            if (args.includes("rm")) removed.push([...args]);
            return missing();
          },
        }),
      ).toThrow(RunnerRefusal);
      expect(owned).toEqual([]);
      expect(removed).toEqual([]);
      expect(fs.existsSync(path.join(root, ".restore-secret"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on a foreign container or network and does not remove it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-operator-foreign-"));
    const cases = ["container", "network"] as const;
    try {
      for (const kind of cases) {
        const removed: string[][] = [];
        const owned: OwnedDisposable[] = [];
        expect(() =>
          startOwnedDisposable({
            attemptId: ATTEMPT,
            invocationId: INVOCATION,
            name: testRestoreName(ATTEMPT),
            networkName: `${testNetworkName(ATTEMPT)}-restore`,
            image: PRODUCTION_POSTGRES_IMAGE,
            role: "stell22",
            database: "stell22",
            password: PASSWORD,
            secretDirectory: path.join(root, `.secret-${kind}`),
            env: process.env,
            owned,
            invoke: (args) => {
              if (args.includes("rm")) removed.push([...args]);
              if (kind === "container" && args[0] === "container") return ok(`${"e".repeat(64)}\n`);
              if (kind === "network" && args[0] === "network" && args[1] === "inspect") return ok(`${"f".repeat(64)}\n`);
              return missing();
            },
          }),
        ).toThrow(expect.objectContaining({ code: "DISPOSABLE_NAME_COLLISION" }));
        expect(owned).toEqual([]);
        expect(removed).toEqual([]);
        expect(fs.existsSync(path.join(root, `.secret-${kind}`))).toBe(false);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses cleanup when the recorded id no longer matches and when the resource is unowned", () => {
    const name = testRestoreName(ATTEMPT);
    const networkName = `${testNetworkName(ATTEMPT)}-restore`;
    const resource: OwnedDisposable = {
      id: CONTAINER_ID,
      name,
      kind: "disposable-restore-container",
      attemptId: ATTEMPT,
      invocationId: INVOCATION,
    };
    const removed: string[][] = [];
    retireOwnedDisposable([resource], (args) => {
      removed.push([...args]);
      return missing();
    }, process.env);
    expect(removed).toEqual([["inspect", "--format", expect.any(String), CONTAINER_ID]]);

    const foreign: string[][] = [];
    expect(() =>
      retireOwnedDisposable([resource], (args) => {
        foreign.push([...args]);
        if (args[0] === "inspect") return ok(`${CONTAINER_ID}|/${name}|other-invocation|${ATTEMPT}|disposable-restore-container\n`);
        return ok("");
      }, process.env),
    ).toThrow(expect.objectContaining({ code: "DISPOSABLE_CLEANUP_REFUSED" }));
    expect(foreign.some((args) => args[0] === "rm")).toBe(false);

    const protectedCalls: string[][] = [];
    expect(() =>
      retireOwnedDisposable(
        [{ ...resource, name: "stell22-db-prod" }],
        (args) => {
          protectedCalls.push([...args]);
          if (args[0] === "inspect") return ok(`${CONTAINER_ID}|/stell22-db-prod|${INVOCATION}|${ATTEMPT}|disposable-restore-container\n`);
          return ok("");
        },
        process.env,
      ),
    ).toThrow(expect.objectContaining({ code: "DISPOSABLE_CLEANUP_REFUSED" }));
    expect(protectedCalls.some((args) => args[0] === "rm")).toBe(false);

    const replaced: string[][] = [];
    retireOwnedDisposable([resource], (args) => {
      replaced.push([...args]);
      if (args.at(-1) === REPLACEMENT_ID) return ok("should-not-inspect-replacement");
      return missing();
    }, process.env);
    expect(replaced.some((args) => args.includes(REPLACEMENT_ID) || args.includes(name) && args[0] === "rm")).toBe(false);

    const success: string[][] = [];
    retireOwnedDisposable(
      [
        resource,
        { id: NETWORK_ID, name: networkName, kind: "disposable-restore-network", attemptId: ATTEMPT, invocationId: INVOCATION },
      ],
      (args) => {
        success.push([...args]);
        if (args[0] === "inspect") return ok(`${CONTAINER_ID}|/${name}|${INVOCATION}|${ATTEMPT}|disposable-restore-container\n`);
        if (args[0] === "network" && args[1] === "inspect") return ok(`${NETWORK_ID}|${networkName}|${INVOCATION}|${ATTEMPT}|disposable-restore-network\n`);
        return ok("");
      },
      process.env,
    );
    expect(success).toContainEqual(["rm", "-f", CONTAINER_ID]);
    expect(success).toContainEqual(["network", "rm", NETWORK_ID]);
    expect(success.some((args) => args.includes(name) && (args[0] === "rm" || args[1] === "rm"))).toBe(false);
  });

  it("builds a disposable run command with no credential material", () => {
    const argv = disposablePostgresArgv({
      name: testRestoreName(ATTEMPT),
      networkName: `${testNetworkName(ATTEMPT)}-restore`,
      envFile: path.join(os.tmpdir(), "postgres.env"),
      image: PRODUCTION_POSTGRES_IMAGE,
      attemptId: ATTEMPT,
      invocationId: INVOCATION,
    });
    expect(argv).toContain("--env-file");
    expect(argv).not.toContain("-e");
    expect(argv.join("\n")).not.toContain(PASSWORD);
    expect(argv.join("\n")).not.toContain("POSTGRES_PASSWORD=");
  });

  it("leaves a preflight filesystem unchanged and does not clean up after a lost attempt lock", () => {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p1-operator-lock-"));
    const attemptRoot = path.join(workRoot, ATTEMPT);
    const sealed = path.join(attemptRoot, "sealed", "keep");
    const witness = path.join(attemptRoot, "backup", "backup.witness.json");
    fs.mkdirSync(path.dirname(sealed), { recursive: true });
    fs.mkdirSync(path.dirname(witness), { recursive: true });
    fs.writeFileSync(sealed, "foreign-sealed");
    fs.writeFileSync(witness, "{\"keep\":true}\n");
    fs.writeFileSync(path.join(attemptRoot, OPERATOR_LOCK_FILE), "held-by-another\n");
    const calls: string[] = [];
    const docker = recordingDocker(calls);
    try {
      const blocked = runOperatorCommand({
        command: "verify-recovery",
        scope: "TEST_OWNED",
        attemptId: ATTEMPT,
        workRoot,
        testEnv: localDockerEnv(),
        testDocker: docker,
      });
      expect(blocked).toMatchObject({ verdict: "BLOCKED", code: "CONCURRENT_EXECUTION", spawned: false });
      expect(fs.readFileSync(sealed, "utf8")).toBe("foreign-sealed");
      expect(fs.readFileSync(witness, "utf8")).toBe("{\"keep\":true}\n");
      expect(fs.readFileSync(path.join(attemptRoot, OPERATOR_LOCK_FILE), "utf8")).toBe("held-by-another\n");
      expect(calls.some((call) => call.startsWith("rm") || call.includes(" network rm") || call.includes("network create"))).toBe(false);

      const otherRoot = path.join(workRoot, "other");
      fs.mkdirSync(otherRoot);
      const other = runOperatorCommand({
        command: "apply",
        scope: "TEST_OWNED",
        attemptId: OTHER,
        workRoot: otherRoot,
        testEnv: localDockerEnv(),
        testDocker: docker,
      });
      expect(other.code).toBe("BACKUP_EVIDENCE_INVALID");
      expect(fs.readFileSync(sealed, "utf8")).toBe("foreign-sealed");

      const apply = runOperatorCommand({
        command: "apply",
        scope: "TEST_OWNED",
        attemptId: ATTEMPT,
        workRoot,
        testEnv: localDockerEnv(),
        testDocker: docker,
      });
      expect(apply.code).toBe("CONCURRENT_EXECUTION");
      expect(fs.readFileSync(witness, "utf8")).toBe("{\"keep\":true}\n");
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("does not delete another run's sealed tree when apply cannot take the attempt", () => {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p1-operator-sealed-"));
    const sealed = path.join(workRoot, ATTEMPT, "sealed", "keep");
    fs.mkdirSync(path.dirname(sealed), { recursive: true });
    fs.writeFileSync(sealed, "other-run");
    try {
      const result = runOperatorCommand({
        command: "apply",
        scope: "TEST_OWNED",
        attemptId: ATTEMPT,
        workRoot,
        testEnv: localDockerEnv(),
        testDocker: (args) => (args[0] === "info" ? ok("daemon-test-1234\n") : missing()),
      });
      expect(result.code).toBe("BACKUP_EVIDENCE_INVALID");
      expect(fs.readFileSync(sealed, "utf8")).toBe("other-run");
      expect(fs.existsSync(path.join(workRoot, ATTEMPT, OPERATOR_LOCK_FILE))).toBe(false);
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });
});

function recordingDocker(calls: string[]): OperatorDocker {
  return (args) => {
    calls.push(args.join(" "));
    if (args[0] === "info") return ok("daemon-test-1234\n");
    return missing();
  };
}

function localDockerEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    DOCKER_HOST: process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock",
  };
}

function ok(stdout: string): OperatorDockerResult {
  return { status: 0, signal: null, stdout, stderr: "" };
}

function missing(): OperatorDockerResult {
  return { status: 1, signal: null, stdout: "", stderr: "" };
}
