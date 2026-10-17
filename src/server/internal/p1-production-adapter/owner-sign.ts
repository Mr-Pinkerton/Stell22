import { createPrivateKey, randomBytes, sign, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTHORIZATION_MAX_WINDOW_MS, type SignedAuthorization } from "@/server/internal/p1-production-adapter/authorization";
import { ATTEMPT_ID, DAEMON_ID, IMAGE_ID, SHA256 } from "@/server/internal/p1-production-adapter/contract";
import { fileIdentity, sameFileIdentity } from "@/server/internal/p1-production-adapter/file-identity";
import { canonicalJson } from "@/server/internal/p1-production-adapter/identity";
import { OwnerSignError } from "@/server/internal/p1-production-adapter/owner-sign-error";
import { assertSingleUserAcl, currentUserSid, restrictSingleUser } from "@/server/internal/p1-production-adapter/windows-acl";

export { OwnerSignError };

/**
 * Offline Owner signing.
 * This module does not connect to production, Docker, or a database.
 * It does not generate a private key, install an approval, or run a migration.
 * Supplied evidence is not independent proof of production state.
 */

export const SIGNING_WINDOW_MS = 15 * 60 * 1000;
export const OWNER_KEY_DIR = ".stell22-owner-keys";
export const OWNER_KEY_FILE = "owner-ed25519.pkcs8.pem";
const PRODUCTION_PREFIX = `${path.sep}var${path.sep}lib${path.sep}stell22`;
const PASSPHRASE_ENV_NAMES = ["PASSPHRASE", "OWNER_PASSPHRASE", "STELL22_PASSPHRASE", "STELL22_OWNER_PASSPHRASE"] as const;
const FORBIDDEN_FLAGS = new Set(["--yes", "--force", "--passphrase", "--authorize", "--authorized", "--production", "--apply-now"]);
const EVIDENCE_KEYS = [
  "attempt",
  "daemonId",
  "dossierSha256",
  "independentlyVerified",
  "kind",
  "oneShotImageId",
  "recoveryEvidence",
  "recoverySha256",
  "scope",
  "signingInputs",
  "source",
  "verdict",
] as const;

export type FileProtection = {
  assertKeyLocation: (filePath: string, directoryPath: string) => void;
  protectNewFile: (filePath: string) => void;
};

export type OwnerEvidence = {
  kind: "UNTRUSTED_OPERATOR_EVIDENCE";
  source: "OWNER_SUPPLIED";
  independentlyVerified: false;
  scope: "PRODUCTION";
  verdict: "RECOVERY_VERIFIED";
  attempt: string;
  daemonId: string;
  dossierSha256: string;
  recoverySha256: string;
  recoveryEvidence: "VERIFIED";
  signingInputs: "COMPLETE";
  oneShotImageId: string;
};

export type OwnerSignIo = {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  readText: (filePath: string) => string;
  confirm: (review: string) => string | Promise<string>;
  readPassphrase: () => Promise<Buffer>;
  log: (line: string) => void;
  now: () => number;
  ownerHome?: string;
  protection?: FileProtection;
  failWrite?: boolean;
  failClose?: boolean;
};

export function parseOwnerEvidence(text: string): OwnerEvidence {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    throw new OwnerSignError(trimmed.includes("verdict=") ? "COPIED_OPERATOR_TEXT" : "EVIDENCE_REJECTED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new OwnerSignError("EVIDENCE_REJECTED");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OwnerSignError("EVIDENCE_REJECTED");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...EVIDENCE_KEYS].sort().join(",")) {
    throw new OwnerSignError("EVIDENCE_REJECTED");
  }
  if (record.kind !== "UNTRUSTED_OPERATOR_EVIDENCE" || record.source !== "OWNER_SUPPLIED") {
    throw new OwnerSignError("EVIDENCE_REJECTED");
  }
  if (record.independentlyVerified !== false) {
    throw new OwnerSignError("EVIDENCE_AUTHORITY_REJECTED");
  }
  if (record.scope !== "PRODUCTION") throw new OwnerSignError("SCOPE_REJECTED");
  if (record.verdict !== "RECOVERY_VERIFIED") throw new OwnerSignError("VERDICT_REJECTED");
  if (record.recoveryEvidence !== "VERIFIED") throw new OwnerSignError("RECOVERY_EVIDENCE_REJECTED");
  if (record.signingInputs !== "COMPLETE") throw new OwnerSignError("SIGNING_INPUTS_REJECTED");
  if (
    typeof record.attempt !== "string" ||
    typeof record.daemonId !== "string" ||
    typeof record.dossierSha256 !== "string" ||
    typeof record.recoverySha256 !== "string" ||
    typeof record.oneShotImageId !== "string" ||
    !ATTEMPT_ID.test(record.attempt) ||
    !DAEMON_ID.test(record.daemonId) ||
    !SHA256.test(record.dossierSha256) ||
    !SHA256.test(record.recoverySha256) ||
    !IMAGE_ID.test(record.oneShotImageId) ||
    record.dossierSha256 === "UNAVAILABLE" ||
    record.recoverySha256 === "UNAVAILABLE" ||
    record.daemonId === "UNAVAILABLE"
  ) {
    throw new OwnerSignError("EVIDENCE_REJECTED");
  }
  return {
    kind: "UNTRUSTED_OPERATOR_EVIDENCE",
    source: "OWNER_SUPPLIED",
    independentlyVerified: false,
    scope: "PRODUCTION",
    verdict: "RECOVERY_VERIFIED",
    attempt: record.attempt,
    daemonId: record.daemonId,
    dossierSha256: record.dossierSha256,
    recoverySha256: record.recoverySha256,
    recoveryEvidence: "VERIFIED",
    signingInputs: "COMPLETE",
    oneShotImageId: record.oneShotImageId,
  };
}

export function reviewOwnerEvidence(evidence: OwnerEvidence): string {
  return [
    "UNTRUSTED SUPPLIED EVIDENCE",
    "This utility did not contact production, Docker, or a database.",
    "independentlyVerified=false",
    "scope=PRODUCTION",
    "kind=OWNER_SIGNED_AUTHORIZATION",
    "operation=P1_ONLY_APPLY",
    "decision=AUTHORIZE_P1_ONLY_APPLY",
    `verdict=${evidence.verdict}`,
    `attempt=${evidence.attempt}`,
    `daemonId=${evidence.daemonId}`,
    `dossierSha256=${evidence.dossierSha256}`,
    `recoverySha256=${evidence.recoverySha256}`,
    `recoveryEvidence=${evidence.recoveryEvidence}`,
    `signingInputs=${evidence.signingInputs}`,
    `oneShotImageId=${evidence.oneShotImageId}`,
    "Type the attempt id to confirm you reviewed these facts.",
  ].join("\n");
}

export function ownerPrivateKeyPath(home: string = os.homedir()): string {
  return path.join(path.resolve(home), OWNER_KEY_DIR, OWNER_KEY_FILE);
}

export function signOwnerEvidence(input: {
  evidenceText: string;
  keyPem: string;
  passphrase: Buffer;
  outputPath: string;
  confirmation: string;
  now?: number;
  ownerHome?: string;
  protection?: FileProtection;
  failWrite?: boolean;
  failClose?: boolean;
}): SignedAuthorization {
  const evidence = parseOwnerEvidence(input.evidenceText);
  try {
    if (!sameText(input.confirmation, evidence.attempt)) throw new OwnerSignError("REVIEW_NOT_CONFIRMED");
    assertOutputAvailable(input.outputPath, input.ownerHome ?? os.homedir());
    const privateKey = unlockEd25519(input.keyPem, input.passphrase);
    const now = input.now ?? Date.now();
    const payload = buildPayload(evidence, now);
    const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64");
    const signed: SignedAuthorization = { payload, signature };
    writeExclusive(input.outputPath, `${JSON.stringify(signed, null, 2)}\n`, {
      failWrite: input.failWrite === true,
      failClose: input.failClose === true,
      home: input.ownerHome ?? os.homedir(),
      protection: input.protection ?? defaultProtection(),
    });
    return signed;
  } finally {
    input.passphrase.fill(0);
  }
}

export function readOwnerKey(keyPath: string, home: string = os.homedir(), protection: FileProtection = defaultProtection()): string {
  const resolved = path.resolve(keyPath);
  refuseProduction(resolved, "KEY_PATH_REJECTED");
  if (streamSuffix(resolved)) throw new OwnerSignError("KEY_PATH_REJECTED");
  const expected = path.resolve(ownerPrivateKeyPath(home));
  if (resolved.toLowerCase() !== expected.toLowerCase()) throw new OwnerSignError("KEY_PATH_REJECTED");
  const directory = path.dirname(resolved);
  assertRealDirectory(directory);
  let listed: fs.Stats;
  try {
    listed = fs.lstatSync(resolved);
  } catch {
    throw new OwnerSignError("KEY_UNAVAILABLE");
  }
  if (listed.isSymbolicLink() || !listed.isFile()) throw new OwnerSignError("KEY_UNAVAILABLE");
  const handle = fs.openSync(resolved, "r");
  try {
    const opened = fs.fstatSync(handle);
    const openedIdentity = fileIdentity(opened);
    const listedIdentity = fileIdentity(listed);
    if (openedIdentity === null || listedIdentity === null || !sameFileIdentity(openedIdentity, listedIdentity)) {
      throw new OwnerSignError("KEY_PATH_REJECTED");
    }
    if (opened.size <= 0 || opened.size > 16_384) throw new OwnerSignError("KEY_FORMAT_REJECTED");
    protection.assertKeyLocation(resolved, directory);
    const settled = fileIdentity(fs.lstatSync(resolved));
    if (settled === null || !sameFileIdentity(settled, openedIdentity)) throw new OwnerSignError("KEY_PATH_REJECTED");
    const pem = fs.readFileSync(handle, "utf8");
    assertEncryptedPkcs8(pem);
    return pem;
  } finally {
    fs.closeSync(handle);
  }
}

export async function runOwnerSignCli(argv: readonly string[], io: OwnerSignIo = defaultIo()): Promise<number> {
  try {
    rejectBoundary(argv, io);
    const paths = parseSignArgs(argv);
    const home = io.ownerHome ?? os.homedir();
    refuseOutputPath(path.resolve(paths.output), home);
    const evidenceText = io.readText(paths.evidence);
    const evidence = parseOwnerEvidence(evidenceText);
    const confirmation = await io.confirm(reviewOwnerEvidence(evidence));
    const keyPem = readOwnerKey(paths.key, home, io.protection ?? defaultProtection());
    const passphrase = await io.readPassphrase();
    try {
      signOwnerEvidence({
        evidenceText,
        keyPem,
        passphrase,
        outputPath: paths.output,
        confirmation,
        now: io.now(),
        ownerHome: home,
        protection: io.protection,
        failWrite: io.failWrite,
        failClose: io.failClose,
      });
    } finally {
      passphrase.fill(0);
    }
    io.log("status=WROTE independentlyVerified=false");
    return 0;
  } catch (error) {
    const code = error instanceof OwnerSignError ? error.code : "SIGNING_FAILED";
    io.log(`status=FAILURE code=${code}`);
    return 2;
  }
}

function buildPayload(evidence: OwnerEvidence, now: number) {
  if (!Number.isFinite(now)) throw new OwnerSignError("WINDOW_REJECTED");
  const end = now + SIGNING_WINDOW_MS;
  if (end <= now || end - now > AUTHORIZATION_MAX_WINDOW_MS) throw new OwnerSignError("WINDOW_REJECTED");
  const nonce = randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new OwnerSignError("SIGNING_FAILED");
  return {
    kind: "OWNER_SIGNED_AUTHORIZATION" as const,
    operation: "P1_ONLY_APPLY" as const,
    decision: "AUTHORIZE_P1_ONLY_APPLY" as const,
    scope: "PRODUCTION" as const,
    attemptId: evidence.attempt,
    dossierSha256: evidence.dossierSha256,
    recoverySha256: evidence.recoverySha256,
    daemonId: evidence.daemonId,
    nonce,
    notBefore: new Date(now).toISOString(),
    notAfter: new Date(end).toISOString(),
  };
}

function unlockEd25519(pem: string, passphrase: Buffer): ReturnType<typeof createPrivateKey> {
  assertEncryptedPkcs8(pem);
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey({ key: pem, format: "pem", passphrase });
  } catch {
    throw new OwnerSignError("PASSPHRASE_REJECTED");
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new OwnerSignError("KEY_TYPE_REJECTED");
  }
  return key;
}

function assertEncryptedPkcs8(pem: string): void {
  if (!pem.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----\n") || !pem.includes("-----END ENCRYPTED PRIVATE KEY-----")) {
    throw new OwnerSignError(pem.includes("-----BEGIN PRIVATE KEY-----") ? "UNENCRYPTED_KEY_REJECTED" : "KEY_FORMAT_REJECTED");
  }
  if (pem.includes("-----BEGIN PRIVATE KEY-----") || pem.includes("PUBLIC KEY") || /OPENSSH|BEGIN RSA|BEGIN EC/i.test(pem)) {
    throw new OwnerSignError("KEY_FORMAT_REJECTED");
  }
}

function assertOutputAvailable(filePath: string, home: string): void {
  const resolved = path.resolve(filePath);
  refuseOutputPath(resolved, home);
  if (pathExists(resolved)) throw new OwnerSignError("OUTPUT_EXISTS");
}

function writeExclusive(
  filePath: string,
  body: string,
  fault: { failWrite: boolean; failClose: boolean; home: string; protection: FileProtection },
): void {
  const resolved = path.resolve(filePath);
  refuseOutputPath(resolved, fault.home);
  const parent = path.dirname(resolved);
  let parentStat: fs.Stats;
  try {
    parentStat = fs.lstatSync(parent);
  } catch {
    throw new OwnerSignError("OUTPUT_UNAVAILABLE");
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new OwnerSignError("OUTPUT_UNAVAILABLE");
  if (pathExists(resolved)) throw new OwnerSignError("OUTPUT_EXISTS");
  const handle = fs.openSync(resolved, "wx", 0o600);
  let identity = fileIdentity(fs.fstatSync(handle));
  let closed = false;
  const closeOwned = () => {
    if (closed) return;
    closed = true;
    fs.closeSync(handle);
  };
  try {
    if (fault.failWrite) {
      fs.writeFileSync(handle, body.slice(0, 1), "utf8");
      throw new OwnerSignError("OUTPUT_WRITE_FAILED");
    }
    fs.writeFileSync(handle, body, "utf8");
    fs.fsyncSync(handle);
    identity = fileIdentity(fs.fstatSync(handle));
    if (identity === null) throw new OwnerSignError("OUTPUT_WRITE_FAILED");
    fs.fchmodSync(handle, 0o600);
    fault.protection.protectNewFile(resolved);
    if (fault.failClose) throw new OwnerSignError("OUTPUT_CLOSE_FAILED");
    closeOwned();
  } catch (error) {
    if (identity) unlinkIfSame(resolved, identity);
    try {
      closeOwned();
    } catch {
      throw new OwnerSignError("OUTPUT_CLOSE_FAILED");
    }
    if (error instanceof OwnerSignError) throw error;
    throw new OwnerSignError("OUTPUT_WRITE_FAILED");
  }
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new OwnerSignError("OUTPUT_UNAVAILABLE");
  }
}

function unlinkIfSame(filePath: string, identity: NonNullable<ReturnType<typeof fileIdentity>>): void {
  try {
    const current = fs.lstatSync(filePath);
    const settled = fileIdentity(current);
    if (!current.isSymbolicLink() && settled && sameFileIdentity(settled, identity)) fs.unlinkSync(filePath);
  } catch {
    // The partial file stays only when its identity can no longer be removed.
  }
}

function refuseOutputPath(resolved: string, home: string): void {
  refuseProduction(resolved, "OUTPUT_PATH_REJECTED");
  const ownerDir = path.resolve(home, OWNER_KEY_DIR).toLowerCase();
  const normalized = resolved.toLowerCase();
  if (normalized === ownerDir || normalized.startsWith(`${ownerDir}${path.sep}`)) {
    throw new OwnerSignError("OUTPUT_PATH_REJECTED");
  }
}

function refuseProduction(resolved: string, code: string): void {
  const production = path.resolve(PRODUCTION_PREFIX).toLowerCase();
  const normalized = resolved.toLowerCase();
  if (normalized === production || normalized.startsWith(`${production}${path.sep}`)) {
    throw new OwnerSignError(code);
  }
}

function streamSuffix(resolved: string): boolean {
  return resolved.slice(path.parse(resolved).root.length).includes(":");
}

function assertRealDirectory(directory: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    throw new OwnerSignError("KEY_UNAVAILABLE");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new OwnerSignError("KEY_UNAVAILABLE");
  const real = fs.realpathSync.native(directory);
  if (path.resolve(real).toLowerCase() !== path.resolve(directory).toLowerCase()) {
    throw new OwnerSignError("KEY_PATH_REJECTED");
  }
}

function defaultProtection(): FileProtection {
  if (process.platform === "win32") {
    const sid = currentUserSid();
    return {
      assertKeyLocation(filePath, directoryPath) {
        assertSingleUserAcl(directoryPath, sid);
        assertSingleUserAcl(filePath, sid);
      },
      protectNewFile(filePath) {
        restrictSingleUser(filePath, "file", sid);
      },
    };
  }
  return {
    assertKeyLocation(filePath, directoryPath) {
      assertUnixPrivate(directoryPath, true);
      assertUnixPrivate(filePath, false);
    },
    protectNewFile(filePath) {
      fs.chmodSync(filePath, 0o600);
      assertUnixPrivate(filePath, false);
    },
  };
}

function assertUnixPrivate(target: string, directory: boolean): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new OwnerSignError(directory ? "KEY_UNAVAILABLE" : "KEY_PERMISSIONS_REJECTED");
  }
  if ((stat.mode & 0o077) !== 0) throw new OwnerSignError("KEY_PERMISSIONS_REJECTED");
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  const equal = a.length === b.length && timingSafeEqual(a, b);
  a.fill(0);
  b.fill(0);
  return equal;
}

function rejectBoundary(argv: readonly string[], io: OwnerSignIo): void {
  if (argv.some((token) => FORBIDDEN_FLAGS.has(token) || token.startsWith("--passphrase=") || token.includes("DATABASE_URL"))) {
    throw new OwnerSignError("ARGUMENTS_REJECTED");
  }
  for (const name of PASSPHRASE_ENV_NAMES) {
    if (io.env[name]) throw new OwnerSignError("ENV_PASSPHRASE_REJECTED");
  }
  if (!io.isTTY) throw new OwnerSignError("NOT_INTERACTIVE");
}

function parseSignArgs(argv: readonly string[]): { evidence: string; key: string; output: string } {
  if (argv.length !== 6) throw new OwnerSignError("ARGUMENTS_REJECTED");
  const evidence = flag(argv, "--evidence");
  const key = flag(argv, "--key");
  const output = flag(argv, "--output");
  if (!evidence || !key || !output) throw new OwnerSignError("ARGUMENTS_REJECTED");
  return { evidence, key, output };
}

function flag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0 || index % 2 !== 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

function defaultIo(): OwnerSignIo {
  return {
    env: process.env,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    readText: (filePath) => fs.readFileSync(filePath, "utf8"),
    confirm: async (review) => {
      process.stdout.write(`${review}\n`);
      return readConfirmLine("Reviewed attempt id: ");
    },
    readPassphrase: () => readHiddenPassphrase(process.stdin, "Owner private-key passphrase: "),
    log: (line) => console.log(line),
    now: () => Date.now(),
  };
}

type HiddenInput = {
  setRawMode: (mode: boolean) => void;
  resume: () => void;
  pause: () => void;
  on: (event: "data", listener: (chunk: Buffer) => void) => void;
  off: (event: "data", listener: (chunk: Buffer) => void) => void;
};

export function readHiddenPassphrase(stdin: HiddenInput, prompt: string, write: (text: string) => void = (text) => process.stdout.write(text)): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let raw = false;
    let secret = Buffer.alloc(0);
    const wipe = () => {
      secret.fill(0);
      secret = Buffer.alloc(0);
    };
    const restore = () => {
      try {
        if (raw) stdin.setRawMode(false);
      } catch {
        // Node cannot guarantee the terminal mode if this call fails. The secret buffer is still wiped.
      }
      raw = false;
      try {
        stdin.off("data", onData);
      } catch {
        // The listener is already gone.
      }
      try {
        stdin.pause();
      } catch {
        // The stream is already paused.
      }
      try {
        write("\n");
      } catch {
        // The newline is not the passphrase.
      }
    };
    const onData = (chunk: Buffer) => {
      if (!Buffer.isBuffer(chunk)) {
        restore();
        wipe();
        reject(new OwnerSignError("NOT_INTERACTIVE"));
        return;
      }
      for (const byte of chunk) {
        if (byte === 0x03) {
          restore();
          wipe();
          reject(new OwnerSignError("ABORTED"));
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          const returned = Buffer.from(secret);
          restore();
          wipe();
          resolve(returned);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          if (secret.length === 0) continue;
          const next = Buffer.alloc(secret.length - 1);
          secret.copy(next, 0, 0, next.length);
          secret.fill(0);
          secret = next;
          continue;
        }
        if (byte >= 0x20) {
          const next = Buffer.alloc(secret.length + 1);
          secret.copy(next);
          next[secret.length] = byte;
          secret.fill(0);
          secret = next;
        }
      }
    };
    try {
      write(prompt);
      stdin.setRawMode(true);
      raw = true;
      stdin.resume();
      stdin.on("data", onData);
    } catch {
      restore();
      wipe();
      reject(new OwnerSignError("NOT_INTERACTIVE"));
    }
  });
}

function readConfirmLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let raw = false;
    let value = "";
    const restore = () => {
      try {
        if (raw) stdin.setRawMode(false);
      } catch {
        // The attempt id is not a passphrase. The mode is still restored when the process exits.
      }
      raw = false;
      stdin.off("data", onData);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer | string) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const character of text) {
        if (character === "\u0003") {
          restore();
          reject(new OwnerSignError("ABORTED"));
          return;
        }
        if (character === "\r" || character === "\n") {
          restore();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    try {
      process.stdout.write(prompt);
      stdin.setRawMode(true);
      raw = true;
      stdin.resume();
      stdin.on("data", onData);
    } catch {
      restore();
      reject(new OwnerSignError("NOT_INTERACTIVE"));
    }
  });
}
