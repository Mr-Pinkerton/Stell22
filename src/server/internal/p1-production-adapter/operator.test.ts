import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProductionAdapterCli } from "@/server/internal/p1-production-adapter/cli";
import { OBSERVED_PRODUCTION_TOPOLOGY, runOperatorCommand } from "@/server/internal/p1-production-adapter/operator";

const ATTEMPT = "0123456789abcdef";

describe("production operator boundaries", () => {
  it("binds the observed topology constants and refuses injected production dependencies", () => {
    expect(OBSERVED_PRODUCTION_TOPOLOGY).toEqual({
      networkName: "stell22_default",
      dnsAlias: "db",
      databaseName: "stell22",
      roleName: "stell22",
    });
    expect(
      runOperatorCommand({
        command: "preflight",
        scope: "PRODUCTION",
        attemptId: ATTEMPT,
        testSpawn: () => ({ status: 0, signal: null }),
      }).code,
    ).toBe("INJECTED_PRODUCTION_DEPENDENCY");
    expect(
      runOperatorCommand({
        command: "apply",
        scope: "PRODUCTION",
        attemptId: ATTEMPT,
        authorization: { kind: "OWNER_SIGNED_AUTHORIZATION" },
      }).code,
    ).toBe("INJECTED_PRODUCTION_DEPENDENCY");
  });

  it("stops a remote Docker endpoint before any catalog read", () => {
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p1-operator-endpoint-"));
    try {
      const result = runOperatorCommand({
        command: "preflight",
        scope: "TEST_OWNED",
        attemptId: ATTEMPT,
        workRoot,
        testEnv: { PATH: process.env.PATH, DOCKER_HOST: "tcp://127.0.0.1:9" },
      });
      expect(result).toMatchObject({
        code: "DOCKER_ENDPOINT_REMOTE",
        spawned: false,
        imageGitSha: "UNVERIFIED",
        targetClass: "TEST_OWNED_NOT_PRODUCTION",
      });
      expect(fs.existsSync(path.join(workRoot, ATTEMPT, "backup"))).toBe(false);
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("keeps the public CLI on the production scope and off caller authorization files", () => {
    const lines: string[] = [];
    expect(runProductionAdapterCli(["verify-recovery", "--attempt", ATTEMPT], (line) => lines.push(line))).toBe(2);
    expect(lines.at(-1)).toBe(
      process.env.GITHUB_ACTIONS === "true" ? "STOP PRODUCTION_SCOPE_FORBIDDEN_IN_CI" : "STOP PRODUCTION_DAEMON_UNPINNED",
    );
    expect(lines.join("\n")).not.toContain("DATABASE_URL");
  });
});
