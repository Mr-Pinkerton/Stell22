import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_MAX_WINDOW_MS, memoryReplayStore, verifySignedAuthorization } from "@/server/internal/p1-production-adapter/authorization";
import { canonicalJson } from "@/server/internal/p1-production-adapter/identity";
import {
  OwnerSignError,
  SIGNING_WINDOW_MS,
  parseOwnerEvidence,
  readOwnerKey,
  runOwnerSignCli,
  signOwnerEvidence,
  type OwnerSignIo,
} from "@/server/internal/p1-production-adapter/owner-sign";
import { RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";

const ATTEMPT = "0123456789abcdef";
const PASSPHRASE = "Correct-Horse-9!battery";
const WRONG_PASSPHRASE = "Wrong-Horse-9!battery";
const IMAGE = `sha256:${"a".repeat(64)}`;

describe("offline owner signing", () => {
  it("signs a reviewed production payload that the existing verifier accepts", () => {
    const dir = tempDir();
    const key = encryptedEd25519(PASSPHRASE);
    const output = path.join(dir, "approval.json");
    const signed = signOwnerEvidence({
      evidenceText: evidence(),
      keyPem: key.pem,
      passphrase: Buffer.from(PASSPHRASE),
      outputPath: output,
      confirmation: ATTEMPT,
    });
    expect(signed.payload).toMatchObject({
      kind: "OWNER_SIGNED_AUTHORIZATION",
      operation: "P1_ONLY_APPLY",
      decision: "AUTHORIZE_P1_ONLY_APPLY",
      scope: "PRODUCTION",
      attemptId: ATTEMPT,
      daemonId: "daemon-local-1",
    });
    expect(canonicalJson(signed.payload)).toBe(canonicalJson({ ...signed.payload, scope: "PRODUCTION" }));
    const span = Date.parse(signed.payload.notAfter) - Date.parse(signed.payload.notBefore);
    expect(span).toBe(SIGNING_WINDOW_MS);
    expect(span).toBeLessThanOrEqual(AUTHORIZATION_MAX_WINDOW_MS);
    const verified = verifySignedAuthorization(signed, key.publicPem, expectedOf(signed.payload), memoryReplayStore());
    expect(verified.attemptId).toBe(ATTEMPT);
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual(signed);
    if (process.platform !== "win32") {
      expect(fs.statSync(output).mode & 0o077).toBe(0);
    }
    expect(fs.readFileSync(output, "utf8")).not.toContain(PASSPHRASE);
    expect(fs.readFileSync(output, "utf8")).not.toContain("PRIVATE KEY");
  });

  it("rejects a bad signature, the wrong bindings, a modified payload, expiry, and replay", () => {
    const key = encryptedEd25519(PASSPHRASE);
    const signed = signAt(Date.now(), key.pem);
    const verify = (value: unknown, expected = expectedOf(signed.payload), now = Date.now()) =>
      verifySignedAuthorization(value, key.publicPem, expected, memoryReplayStore(), now);
    expect(() => verify({ ...signed, signature: Buffer.alloc(64, 1).toString("base64") })).toThrow(RunnerRefusal);
    expect(codeOf(() => verify(signed, { ...expectedOf(signed.payload), daemonId: "other-daemon" }))).toBe("AUTHORIZATION_MISMATCH");
    expect(codeOf(() => verify(signed, { ...expectedOf(signed.payload), dossierSha256: "e".repeat(64) }))).toBe("AUTHORIZATION_MISMATCH");
    expect(codeOf(() => verify(signed, { ...expectedOf(signed.payload), recoverySha256: "f".repeat(64) }))).toBe("AUTHORIZATION_MISMATCH");
    expect(codeOf(() => verify(signed, { ...expectedOf(signed.payload), attemptId: "fedcba9876543210" }))).toBe("AUTHORIZATION_MISMATCH");
    const tampered = { ...signed, payload: { ...signed.payload, nonce: "cd".repeat(16) } };
    expect(codeOf(() => verify(tampered))).toBe("AUTHORIZATION_ORIGIN_REJECTED");
    expect(codeOf(() => verify(signAt(Date.now() - 2 * 60 * 60 * 1000, key.pem)))).toBe("AUTHORIZATION_REPLAY");
    expect(codeOf(() => verify(signAt(Date.now() + 2 * 60 * 60 * 1000, key.pem)))).toBe("AUTHORIZATION_REPLAY");
    const wide = wideWindow();
    expect(codeOf(() => verifySignedAuthorization(wide.signed, wide.publicPem, expectedOf(wide.signed.payload), memoryReplayStore()))).toBe(
      "AUTHORIZATION_REPLAY",
    );
    const replay = memoryReplayStore();
    verifySignedAuthorization(signed, key.publicPem, expectedOf(signed.payload), replay);
    expect(codeOf(() => verifySignedAuthorization(signed, key.publicPem, expectedOf(signed.payload), replay))).toBe("AUTHORIZATION_REPLAY");
  });

  it("rejects incomplete evidence, a copied operator line, and caller-chosen authority", () => {
    expect(codeOf(() => parseOwnerEvidence(evidence({ signingInputs: "INCOMPLETE" })))).toBe("SIGNING_INPUTS_REJECTED");
    expect(codeOf(() => parseOwnerEvidence(evidence({ signingInputs: "UNAVAILABLE" })))).toBe("SIGNING_INPUTS_REJECTED");
    expect(codeOf(() => parseOwnerEvidence(evidence({ recoveryEvidence: "NONE" })))).toBe("RECOVERY_EVIDENCE_REJECTED");
    expect(codeOf(() => parseOwnerEvidence(evidence({ verdict: "STOP" })))).toBe("VERDICT_REJECTED");
    expect(codeOf(() => parseOwnerEvidence(evidence({ verdict: "BLOCKED" })))).toBe("VERDICT_REJECTED");
    expect(codeOf(() => parseOwnerEvidence(evidence({ scope: "TEST_OWNED" })))).toBe("SCOPE_REJECTED");
    expect(codeOf(() => parseOwnerEvidence(evidence({ independentlyVerified: true })))).toBe("EVIDENCE_AUTHORITY_REJECTED");
    expect(codeOf(() => parseOwnerEvidence(evidence({ operation: "P1_ONLY_APPLY" })))).toBe("EVIDENCE_REJECTED");
    expect(codeOf(() => parseOwnerEvidence(`verdict=RECOVERY_VERIFIED attempt=${ATTEMPT} daemonId=daemon-local-1`))).toBe(
      "COPIED_OPERATOR_TEXT",
    );
    expect(codeOf(() => signOwnerEvidence(signInput({ confirmation: "yes" })))).toBe("REVIEW_NOT_CONFIRMED");
  });

  it("rejects the wrong key material and keeps the passphrase out of the error", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = rsa.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: PASSPHRASE }).toString();
    expect(codeOf(() => signOwnerEvidence(signInput({ keyPem: rsaPem })))).toBe("KEY_TYPE_REJECTED");
    const open = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(open.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(codeOf(() => signOwnerEvidence(signInput({ keyPem: open })))).toBe("UNENCRYPTED_KEY_REJECTED");
    const wrong = Buffer.from(WRONG_PASSPHRASE);
    let thrown: unknown;
    try {
      signOwnerEvidence(signInput({ passphrase: wrong }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OwnerSignError);
    expect((thrown as OwnerSignError).code).toBe("PASSPHRASE_REJECTED");
    expect(String(thrown)).not.toContain(WRONG_PASSPHRASE);
    expect(String(thrown)).not.toContain(PASSPHRASE);
    expect(wrong.every((byte) => byte === 0)).toBe(true);
  });

  it("preserves an existing approval and removes a partial write", () => {
    const dir = tempDir();
    const existing = path.join(dir, "approval.json");
    fs.writeFileSync(existing, "keep-existing\n");
    expect(codeOf(() => signOwnerEvidence(signInput({ outputPath: existing })))).toBe("OUTPUT_EXISTS");
    expect(fs.readFileSync(existing, "utf8")).toBe("keep-existing\n");
    const partial = path.join(dir, "partial.json");
    expect(codeOf(() => signOwnerEvidence(signInput({ outputPath: partial, failWrite: true })))).toBe("OUTPUT_WRITE_FAILED");
    expect(fs.existsSync(partial)).toBe(false);
    expect(fs.readdirSync(dir).join("\n")).not.toContain("PRIVATE");
    expect(fs.readFileSync(existing, "utf8")).not.toContain(PASSPHRASE);
  });

  it("does not read the Owner profile and does not accept a passphrase from the command boundary", async () => {
    expect(codeOf(() => readOwnerKey(path.join(os.homedir(), ".stell22-owner-keys", "owner-ed25519.pkcs8.pem")))).toBe(
      "OWNER_PROFILE_REFUSED",
    );
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(await runOwnerSignCli(["--force"], io(log))).toBe(2);
    expect(
      await runOwnerSignCli(["--evidence", "a", "--key", "b", "--output", "c"], io(log, { NODE_ENV: "test", STELL22_OWNER_PASSPHRASE: WRONG_PASSPHRASE })),
    ).toBe(2);
    expect(lines.join("\n")).toContain("code=ARGUMENTS_REJECTED");
    expect(lines.join("\n")).toContain("code=ENV_PASSPHRASE_REJECTED");
    expect(lines.join("\n")).not.toContain(WRONG_PASSPHRASE);
    expect(lines.join("\n")).not.toContain(PASSPHRASE);
    expect(await runOwnerSignCli(["--evidence", "a", "--key", "b", "--output", "c"], { ...io(log), isTTY: false, env: { NODE_ENV: "test" } })).toBe(2);
    expect(lines.join("\n")).toContain("code=NOT_INTERACTIVE");
  });
});

function signAt(now: number, pem: string) {
  return signOwnerEvidence(signInput({ now, keyPem: pem, outputPath: path.join(tempDir(), "approval.json") }));
}

function signInput(overrides: Partial<Parameters<typeof signOwnerEvidence>[0]> = {}): Parameters<typeof signOwnerEvidence>[0] {
  const passphrase = overrides.passphrase ?? Buffer.from(PASSPHRASE);
  return {
    evidenceText: evidence(),
    keyPem: encryptedEd25519(PASSPHRASE).pem,
    passphrase,
    outputPath: path.join(tempDir(), "approval.json"),
    confirmation: ATTEMPT,
    ...overrides,
  };
}

function wideWindow() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const now = Date.now();
  const payload = {
    kind: "OWNER_SIGNED_AUTHORIZATION" as const,
    operation: "P1_ONLY_APPLY" as const,
    decision: "AUTHORIZE_P1_ONLY_APPLY" as const,
    scope: "PRODUCTION" as const,
    attemptId: ATTEMPT,
    dossierSha256: "c".repeat(64),
    recoverySha256: "d".repeat(64),
    daemonId: "daemon-local-1",
    nonce: "ab".repeat(16),
    notBefore: new Date(now).toISOString(),
    notAfter: new Date(now + AUTHORIZATION_MAX_WINDOW_MS + 60_000).toISOString(),
  };
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    signed: {
      payload,
      signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64"),
    },
  };
}

function evidence(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    kind: "UNTRUSTED_OPERATOR_EVIDENCE",
    source: "OWNER_SUPPLIED",
    independentlyVerified: false,
    scope: "PRODUCTION",
    verdict: "RECOVERY_VERIFIED",
    attempt: ATTEMPT,
    daemonId: "daemon-local-1",
    dossierSha256: "c".repeat(64),
    recoverySha256: "d".repeat(64),
    recoveryEvidence: "VERIFIED",
    signingInputs: "COMPLETE",
    oneShotImageId: IMAGE,
    ...overrides,
  });
}

function expectedOf(payload: { attemptId: string; dossierSha256: string; recoverySha256: string; daemonId: string }) {
  return {
    scope: "PRODUCTION" as const,
    attemptId: payload.attemptId,
    dossierSha256: payload.dossierSha256,
    recoverySha256: payload.recoverySha256,
    daemonId: payload.daemonId,
  };
}

function encryptedEd25519(passphrase: string): { pem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function io(log: (line: string) => void, env: NodeJS.ProcessEnv = { NODE_ENV: "test" }): OwnerSignIo {
  return {
    env,
    isTTY: true,
    readText: () => evidence(),
    confirm: () => ATTEMPT,
    readPassphrase: async () => Buffer.from(PASSPHRASE),
    log,
    now: () => Date.now(),
  };
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof OwnerSignError || error instanceof RunnerRefusal) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p1-owner-sign-"));
}
