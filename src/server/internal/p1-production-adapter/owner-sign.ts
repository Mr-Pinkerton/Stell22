import { createPrivateKey, randomBytes, sign, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTHORIZATION_MAX_WINDOW_MS, type SignedAuthorization } from "@/server/internal/p1-production-adapter/authorization";
import { ATTEMPT_ID, DAEMON_ID, IMAGE_ID, SHA256 } from "@/server/internal/p1-production-adapter/contract";
import { fileIdentity, sameFileIdentity } from "@/server/internal/p1-production-adapter/file-identity";
import { canonicalJson } from "@/server/internal/p1-production-adapter/identity";

/**
 * Offline Owner signing.
 * This module does not connect to production, Docker, or a database.
 * It does not generate a private key, install an approval, or run a migration.
 * Supplied evidence is not independent proof of production state.
 */

export const SIGNING_WINDOW_MS = 15 * 60 * 1000;
const OWNER_KEY_DIR = ".stell22-owner-keys";
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

export class OwnerSignError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "OwnerSignError";
    this.code = code;
  }
}

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
  failWrite?: boolean;
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

export function signOwnerEvidence(input: {
  evidenceText: string;
  keyPem: string;
  passphrase: Buffer;
  outputPath: string;
  confirmation: string;
  now?: number;
  failWrite?: boolean;
}): SignedAuthorization {
  const evidence = parseOwnerEvidence(input.evidenceText);
  const secret = Buffer.from(input.passphrase);
  try {
    if (!sameText(input.confirmation, evidence.attempt)) throw new OwnerSignError("REVIEW_NOT_CONFIRMED");
    assertOutputAvailable(input.outputPath);
    const privateKey = unlockEd25519(input.keyPem, secret);
    const now = input.now ?? Date.now();
    const payload = buildPayload(evidence, now);
    const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64");
    const signed: SignedAuthorization = { payload, signature };
    writeExclusive(input.outputPath, `${JSON.stringify(signed, null, 2)}\n`, input.failWrite === true);
    return signed;
  } finally {
    secret.fill(0);
    input.passphrase.fill(0);
  }
}

export function readOwnerKey(keyPath: string): string {
  const resolved = path.resolve(keyPath);
  refuseProtectedPath(resolved, "OWNER_PROFILE_REFUSED");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new OwnerSignError("KEY_UNAVAILABLE");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new OwnerSignError("KEY_UNAVAILABLE");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new OwnerSignError("KEY_PERMISSIONS_REJECTED");
  if (stat.size <= 0 || stat.size > 16_384) throw new OwnerSignError("KEY_FORMAT_REJECTED");
  const pem = fs.readFileSync(resolved, "utf8");
  assertEncryptedPkcs8(pem);
  return pem;
}

export async function runOwnerSignCli(argv: readonly string[], io: OwnerSignIo = defaultIo()): Promise<number> {
  try {
    rejectBoundary(argv, io);
    const paths = parseSignArgs(argv);
    refuseProtectedPath(path.resolve(paths.output), "OUTPUT_PATH_REJECTED");
    const evidenceText = io.readText(paths.evidence);
    const evidence = parseOwnerEvidence(evidenceText);
    const confirmation = await io.confirm(reviewOwnerEvidence(evidence));
    const keyPem = readOwnerKey(paths.key);
    const passphrase = Buffer.from(await io.readPassphrase());
    signOwnerEvidence({
      evidenceText,
      keyPem,
      passphrase,
      outputPath: paths.output,
      confirmation,
      now: io.now(),
      failWrite: io.failWrite,
    });
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

function assertOutputAvailable(filePath: string): void {
  const resolved = path.resolve(filePath);
  refuseProtectedPath(resolved, "OUTPUT_PATH_REJECTED");
  try {
    fs.lstatSync(resolved);
    throw new OwnerSignError("OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof OwnerSignError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new OwnerSignError("OUTPUT_UNAVAILABLE");
  }
}

function writeExclusive(filePath: string, body: string, failWrite: boolean): void {
  const resolved = path.resolve(filePath);
  refuseProtectedPath(resolved, "OUTPUT_PATH_REJECTED");
  const parent = path.dirname(resolved);
  let parentStat: fs.Stats;
  try {
    parentStat = fs.lstatSync(parent);
  } catch {
    throw new OwnerSignError("OUTPUT_UNAVAILABLE");
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new OwnerSignError("OUTPUT_UNAVAILABLE");
  try {
    fs.lstatSync(resolved);
    throw new OwnerSignError("OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof OwnerSignError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new OwnerSignError("OUTPUT_UNAVAILABLE");
  }
  const handle = fs.openSync(resolved, "wx", 0o600);
  let identity = fileIdentity(fs.fstatSync(handle));
  try {
    if (failWrite) {
      fs.writeFileSync(handle, body.slice(0, 1), "utf8");
      throw new OwnerSignError("OUTPUT_WRITE_FAILED");
    }
    fs.writeFileSync(handle, body, "utf8");
    fs.fsyncSync(handle);
    identity = fileIdentity(fs.fstatSync(handle));
    if (identity === null) throw new OwnerSignError("OUTPUT_WRITE_FAILED");
    fs.fchmodSync(handle, 0o600);
  } catch (error) {
    if (identity) {
      try {
        const current = fs.lstatSync(resolved);
        const settled = fileIdentity(current);
        if (!current.isSymbolicLink() && settled && sameFileIdentity(settled, identity)) fs.unlinkSync(resolved);
      } catch {
        // The partial file stays only when its identity can no longer be removed.
      }
    }
    try {
      fs.closeSync(handle);
    } catch {
      // The ownership decision was already made while this descriptor was open.
    }
    if (error instanceof OwnerSignError) throw error;
    throw new OwnerSignError("OUTPUT_WRITE_FAILED");
  }
  fs.closeSync(handle);
}

function refuseProtectedPath(resolved: string, code: string): void {
  const ownerDir = path.resolve(path.join(os.homedir(), OWNER_KEY_DIR));
  const normalized = resolved.toLowerCase();
  const protectedOwner = ownerDir.toLowerCase();
  if (normalized === protectedOwner || normalized.startsWith(`${protectedOwner}${path.sep}`)) {
    throw new OwnerSignError(code === "OUTPUT_PATH_REJECTED" ? code : "OWNER_PROFILE_REFUSED");
  }
  const production = path.resolve(PRODUCTION_PREFIX).toLowerCase();
  if (normalized === production || normalized.startsWith(`${production}${path.sep}`)) {
    throw new OwnerSignError(code);
  }
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
      const typed = await readHidden("Reviewed attempt id: ");
      return typed.toString("utf8");
    },
    readPassphrase: () => readHidden("Owner private-key passphrase: "),
    log: (line) => console.log(line),
    now: () => Date.now(),
  };
}

function readHidden(prompt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (error: OwnerSignError | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(Buffer.from(value));
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new OwnerSignError("ABORTED"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(null);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    stdin.on("data", onData);
  });
}
