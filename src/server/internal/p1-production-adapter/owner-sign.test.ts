import { createCipheriv, generateKeyPairSync, pbkdf2Sync, randomBytes, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_MAX_WINDOW_MS, memoryReplayStore, verifySignedAuthorization } from "@/server/internal/p1-production-adapter/authorization";
import { canonicalJson } from "@/server/internal/p1-production-adapter/identity";
import {
  OWNER_KEY_FILE,
  OwnerSignError,
  SIGNING_WINDOW_MS,
  ownerPrivateKeyPath,
  parseOwnerEvidence,
  readHiddenPassphrase,
  readOwnerKey,
  runOwnerSignCli,
  signOwnerEvidence,
  type OwnerSignIo,
} from "@/server/internal/p1-production-adapter/owner-sign";
import { RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import { assertSingleUserAcl, currentUserSid, restrictSingleUser } from "@/server/internal/p1-production-adapter/windows-acl";

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

  it("does not read an arbitrary key path or the real Owner profile and does not accept a passphrase from the command boundary", async () => {
    const loose = path.join(tempDir(), "not-the-owner-key.pem");
    fs.writeFileSync(loose, "keep");
    expect(codeOf(() => readOwnerKey(loose))).toBe("KEY_PATH_REJECTED");
    expect(fs.readFileSync(loose, "utf8")).toBe("keep");
    expect(ownerPrivateKeyPath()).toBe(path.join(path.resolve(os.homedir()), ".stell22-owner-keys", "owner-ed25519.pkcs8.pem"));
    expect(codeOf(() => readOwnerKey(`${path.sep}var${path.sep}lib${path.sep}stell22${path.sep}owner-ed25519.pkcs8.pem`))).toBe("KEY_PATH_REJECTED");
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

  it("signs through the CLI with a disposable R1 PKCS#8 key and the existing verifier", async () => {
    const world = keyWorld();
    const lines: string[] = [];
    const passphrase = Buffer.from(PASSPHRASE);
    const code = await runOwnerSignCli(["--evidence", world.evidencePath, "--key", world.keyPath, "--output", world.output], {
      ...io((line) => lines.push(line)),
      ownerHome: world.home,
      readText: (filePath) => fs.readFileSync(filePath, "utf8"),
      readPassphrase: async () => passphrase,
    });
    expect(code).toBe(0);
    expect(passphrase.every((byte) => byte === 0)).toBe(true);
    expect(lines.join("\n")).toBe("status=WROTE independentlyVerified=false");
    expect(lines.join("\n")).not.toContain(PASSPHRASE);
    if (process.platform === "win32") assertSingleUserAcl(world.output, currentUserSid());
    else expect(fs.statSync(world.output).mode & 0o077).toBe(0);
    const signed = JSON.parse(fs.readFileSync(world.output, "utf8")) as { payload: { attemptId: string; dossierSha256: string; recoverySha256: string; daemonId: string; notBefore: string; notAfter: string }; signature: string };
    expect(Date.parse(signed.payload.notAfter) - Date.parse(signed.payload.notBefore)).toBe(SIGNING_WINDOW_MS);
    const replay = memoryReplayStore();
    const verified = verifySignedAuthorization(signed, world.publicPem, expectedOf(signed.payload), replay);
    expect(verified.attemptId).toBe(ATTEMPT);
    expect(() => verifySignedAuthorization(signed, world.publicPem, expectedOf(signed.payload), replay)).toThrow(RunnerRefusal);
    const issued = 1_700_000_000_000;
    const edge = signAt(issued, world.pem);
    expect(verifySignedAuthorization(edge, world.publicPem, expectedOf(edge.payload), memoryReplayStore(), issued + SIGNING_WINDOW_MS).attemptId).toBe(ATTEMPT);
    expect(codeOf(() => verifySignedAuthorization(edge, world.publicPem, expectedOf(edge.payload), memoryReplayStore(), issued + SIGNING_WINDOW_MS + 1))).toBe("AUTHORIZATION_REPLAY");
  }, 30_000);

  it("rejects a wrong passphrase, a permissive key, a missing ACL check, substitution, and a close failure", async () => {
    const world = keyWorld();
    const wrong = Buffer.from(WRONG_PASSPHRASE);
    const lines: string[] = [];
    const refused = await runOwnerSignCli(["--evidence", world.evidencePath, "--key", world.keyPath, "--output", world.output], {
      ...io((line) => lines.push(line)),
      ownerHome: world.home,
      readText: (filePath) => fs.readFileSync(filePath, "utf8"),
      readPassphrase: async () => wrong,
    });
    expect(refused).toBe(2);
    expect(lines.join("\n")).toContain("code=PASSPHRASE_REJECTED");
    expect(lines.join("\n")).not.toContain(WRONG_PASSPHRASE);
    expect(wrong.every((byte) => byte === 0)).toBe(true);
    expect(fs.existsSync(world.output)).toBe(false);

    const permissive = keyWorld({ protect: false });
    expect(codeOf(() => readOwnerKey(permissive.keyPath, permissive.home))).toBe("KEY_PERMISSIONS_REJECTED");
    expect(codeOf(() => readOwnerKey(world.keyPath, world.home, { assertKeyLocation: () => { throw new OwnerSignError("ACL_UNVERIFIED"); }, protectNewFile: () => undefined }))).toBe("ACL_UNVERIFIED");

    const outside = path.join(world.home, "outside.pem");
    fs.writeFileSync(outside, "foreign-key");
    const linkDir = path.join(world.home, "linked-home", ".stell22-owner-keys");
    fs.mkdirSync(path.dirname(linkDir));
    fs.symlinkSync(path.dirname(world.keyPath), linkDir, process.platform === "win32" ? "junction" : "dir");
    expect(codeOf(() => readOwnerKey(path.join(linkDir, OWNER_KEY_FILE), path.join(world.home, "linked-home")))).toBe("KEY_UNAVAILABLE");
    expect(fs.readFileSync(outside, "utf8")).toBe("foreign-key");

    const closed = path.join(world.home, "closed.json");
    expect(codeOf(() => signOwnerEvidence(signInput({ outputPath: closed, failClose: true })))).toBe("OUTPUT_CLOSE_FAILED");
    expect(fs.existsSync(closed)).toBe(false);
    const foreign = path.join(world.home, "foreign.txt");
    fs.writeFileSync(foreign, "foreign");
    expect(fs.readFileSync(foreign, "utf8")).toBe("foreign");

    const rsa = keyWorld({ protect: false });
    const rsaKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: PASSPHRASE,
    }).toString();
    fs.writeFileSync(rsa.keyPath, rsaKey, { mode: 0o600 });
    if (process.platform === "win32") {
      const sid = currentUserSid();
      restrictSingleUser(path.dirname(rsa.keyPath), "dir", sid);
      restrictSingleUser(rsa.keyPath, "file", sid);
    } else {
      fs.chmodSync(path.dirname(rsa.keyPath), 0o700);
      fs.chmodSync(rsa.keyPath, 0o600);
    }
    const rsaPem = readOwnerKey(rsa.keyPath, rsa.home);
    const rsaOut = path.join(rsa.home, "rsa-out.json");
    expect(codeOf(() => signOwnerEvidence(signInput({ keyPem: rsaPem, outputPath: rsaOut, ownerHome: rsa.home })))).toBe("KEY_TYPE_REJECTED");
    expect(fs.existsSync(rsaOut)).toBe(false);
    expect(codeOf(() => readOwnerKey(path.join(rsa.home, ".stell22-owner-keys", "sibling.pem"), rsa.home))).toBe("KEY_PATH_REJECTED");
    expect(codeOf(() => signOwnerEvidence(signInput({ outputPath: path.join(rsa.home, ".stell22-owner-keys", "approval.json"), ownerHome: rsa.home })))).toBe("OUTPUT_PATH_REJECTED");
  }, 30_000);

  it("wipes a passphrase buffer when entry is interrupted and restores raw mode", async () => {
    const stdin = fakeInput();
    const pending = readHiddenPassphrase(stdin, "Owner private-key passphrase: ", () => undefined);
    stdin.emit(Buffer.from(PASSPHRASE));
    stdin.emit(Buffer.from([0x03]));
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    expect(stdin.modes).toEqual([true, false]);
    const entered = fakeInput();
    const accepted = readHiddenPassphrase(entered, "Owner private-key passphrase: ", () => undefined);
    entered.emit(Buffer.from("ab"));
    entered.emit(Buffer.from([0x7f]));
    entered.emit(Buffer.from([0x63, 0x0d]));
    const returned = await accepted;
    expect(returned.toString("utf8")).toBe("ac");
    expect(entered.modes).toEqual([true, false]);
    returned.fill(0);
    try {
      await pending;
    } catch (error) {
      expect(String(error)).not.toContain(PASSPHRASE);
    }
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

function keyWorld(options: { protect?: boolean } = {}): { home: string; keyPath: string; evidencePath: string; output: string; pem: string; publicPem: string } {
  const home = tempDir();
  const directory = path.join(home, ".stell22-owner-keys");
  fs.mkdirSync(directory, { mode: 0o700 });
  const keyPath = path.join(directory, OWNER_KEY_FILE);
  const pair = r1EncryptedKey(PASSPHRASE);
  fs.writeFileSync(keyPath, pair.pem, { mode: 0o600 });
  if (options.protect !== false) {
    if (process.platform === "win32") {
      const sid = currentUserSid();
      restrictSingleUser(directory, "dir", sid);
      restrictSingleUser(keyPath, "file", sid);
    } else {
      fs.chmodSync(directory, 0o700);
      fs.chmodSync(keyPath, 0o600);
    }
  } else if (process.platform !== "win32") {
    fs.chmodSync(keyPath, 0o644);
    fs.chmodSync(directory, 0o755);
  }
  const evidencePath = path.join(home, "evidence.json");
  fs.writeFileSync(evidencePath, evidence());
  const output = path.join(home, "approvals", "approval.json");
  fs.mkdirSync(path.dirname(output), { mode: 0o700 });
  return { home, keyPath, evidencePath, output, pem: pair.pem, publicPem: pair.publicPem };
}

function r1EncryptedKey(passphrase: string): { pem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const secret = Buffer.from(passphrase);
  const plain = privateKey.export({ type: "pkcs8", format: "der" });
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = pbkdf2Sync(secret, salt, 600_000, 32, "sha256");
  secret.fill(0);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  key.fill(0);
  const oid = (body: Buffer) => derTag(0x06, body);
  const prf = derTag(0x30, Buffer.concat([oid(Buffer.from("2a864886f70d0209", "hex")), Buffer.from([0x05, 0x00])]));
  const kdf = derTag(0x30, Buffer.concat([oid(Buffer.from("2a864886f70d01050c", "hex")), derTag(0x30, Buffer.concat([derTag(0x04, salt), derInteger(600_000), prf]))]));
  const scheme = derTag(0x30, Buffer.concat([oid(Buffer.from("60864801650304012a", "hex")), derTag(0x04, iv)]));
  const pbes2 = derTag(0x30, Buffer.concat([oid(Buffer.from("2a864886f70d01050d", "hex")), derTag(0x30, Buffer.concat([kdf, scheme]))]));
  const info = derTag(0x30, Buffer.concat([pbes2, derTag(0x04, encrypted)]));
  const body = info.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return {
    pem: `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${body}\n-----END ENCRYPTED PRIVATE KEY-----\n`,
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function derTag(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length <= 0xff) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

function derInteger(value: number): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let body = Buffer.from(hex, "hex");
  if (body.length === 0 || (body[0] ?? 0) & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return derTag(0x02, body);
}

function fakeInput(): { modes: boolean[]; setRawMode: (mode: boolean) => void; resume: () => void; pause: () => void; on: (event: "data", listener: (chunk: Buffer) => void) => void; off: (event: "data", listener: (chunk: Buffer) => void) => void; emit: (chunk: Buffer) => void } {
  const listeners: ((chunk: Buffer) => void)[] = [];
  const modes: boolean[] = [];
  return {
    modes,
    setRawMode(mode: boolean) {
      modes.push(mode);
    },
    resume() {
      return undefined;
    },
    pause() {
      return undefined;
    },
    on(_event: "data", listener: (chunk: Buffer) => void) {
      listeners.push(listener);
    },
    off(_event: "data", listener: (chunk: Buffer) => void) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit(chunk: Buffer) {
      for (const listener of [...listeners]) listener(chunk);
    },
  };
}
