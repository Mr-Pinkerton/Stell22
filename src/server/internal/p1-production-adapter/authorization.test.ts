import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { fileReplayStore, isDurableReplayStore, memoryReplayStore, verifySignedAuthorization } from "@/server/internal/p1-production-adapter/authorization";
import { canonicalJson } from "@/server/internal/p1-production-adapter/identity";
import { RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";

const DIGEST = "ab".repeat(32);

describe("authorization replay", () => {
  it("rejects a second use after a new store reads the same directory", () => {
    const dir = replayDir();
    const signed = sample();
    verifySignedAuthorization(signed.value, signed.pem, signed.expected, fileReplayStore(dir));
    expect(() => verifySignedAuthorization(signed.value, signed.pem, signed.expected, fileReplayStore(dir))).toThrow(RunnerRefusal);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it("lets only one of two concurrent consumers claim the approval", async () => {
    const dir = replayDir();
    const script = path.join(path.dirname(dir), "consume-once.ts");
    const specifier = pathToFileURL(path.join(process.cwd(), "src/server/internal/p1-production-adapter/authorization.ts")).href;
    fs.writeFileSync(
      script,
      `import { fileReplayStore } from ${JSON.stringify(specifier)};
       try {
         fileReplayStore(process.env.REPLAY_DIR ?? "").consume(process.env.REPLAY_DIGEST ?? "");
         process.exit(0);
       } catch (error) {
         const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
         process.stderr.write(code || String(error));
         process.exit(code === "AUTHORIZATION_REPLAY" ? 2 : 1);
       }`,
    );
    const results = await Promise.all([consumeChild(script, dir, DIGEST), consumeChild(script, dir, DIGEST)]);
    expect(results.map((item) => `${item.code}:${item.stderr}`).join(" | ")).toContain("0:");
    expect(results.filter((item) => item.code === 0)).toHaveLength(1);
    expect(results.filter((item) => item.code === 2)).toHaveLength(1);
    expect(() => fileReplayStore(dir).consume(DIGEST)).toThrow(RunnerRefusal);
  }, 30_000);

  it("rejects an unsafe or unavailable replay store and does not follow a symlink", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "p1pa-replay-unsafe-"));
    const file = path.join(parent, "not-a-directory");
    fs.writeFileSync(file, "x");
    expect(codeOf(() => fileReplayStore(file).consume(DIGEST))).toBe("AUTHORIZATION_REPLAY_UNAVAILABLE");

    if (process.platform !== "win32") {
      const looseParent = path.join(parent, "loose");
      fs.mkdirSync(looseParent, { mode: 0o700 });
      fs.chmodSync(looseParent, 0o777);
      expect(codeOf(() => fileReplayStore(path.join(looseParent, "replay")).consume(DIGEST))).toBe("AUTHORIZATION_REPLAY_UNAVAILABLE");
    }

    const real = path.join(parent, "real");
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(parent, "link");
    fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    expect(codeOf(() => fileReplayStore(link).consume(DIGEST))).toBe("AUTHORIZATION_REPLAY_UNAVAILABLE");

    const durable = replayDir();
    expect(isDurableReplayStore(fileReplayStore(durable))).toBe(true);
    expect(isDurableReplayStore(memoryReplayStore())).toBe(false);
    const outside = path.join(parent, "outside");
    fs.writeFileSync(outside, "kept");
    fs.mkdirSync(durable, { mode: 0o700 });
    try {
      fs.symlinkSync(outside, path.join(durable, DIGEST), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      return;
    }
    expect(codeOf(() => fileReplayStore(durable).consume(DIGEST))).toBe("AUTHORIZATION_REPLAY");
    expect(fs.readFileSync(outside, "utf8")).toBe("kept");
  });
});

function replayDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "p1pa-replay-")), "replay");
}

function sample() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const payload = {
    kind: "OWNER_SIGNED_AUTHORIZATION" as const,
    operation: "P1_ONLY_APPLY" as const,
    decision: "AUTHORIZE_P1_ONLY_APPLY" as const,
    scope: "TEST_OWNED" as const,
    attemptId: "0123456789abcdef",
    dossierSha256: "c".repeat(64),
    recoverySha256: "d".repeat(64),
    daemonId: "daemon-local-1",
    nonce: "ab".repeat(16),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60 * 60_000).toISOString(),
  };
  return {
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    expected: {
      scope: "TEST_OWNED" as const,
      attemptId: payload.attemptId,
      dossierSha256: payload.dossierSha256,
      recoverySha256: payload.recoverySha256,
      daemonId: payload.daemonId,
    },
    value: {
      payload,
      signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64"),
    },
  };
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerRefusal);
    return (error as RunnerRefusal).code;
  }
  throw new Error("expected a refusal");
}

function consumeChild(script: string, dir: string, digest: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", script], {
      cwd: process.cwd(),
      env: { ...process.env, REPLAY_DIR: dir, REPLAY_DIGEST: digest },
      windowsHide: true,
      shell: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
  });
}
