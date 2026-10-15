import { createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ATTEMPT_ID,
  PRODUCTION_AUTHORIZATION_REPLAY_PATH,
  PRODUCTION_AUTHORIZATION_TRUST_PATH,
  PRODUCTION_SIGNED_AUTHORIZATION_PATH,
  SHA256,
  type AdapterScope,
} from "@/server/internal/p1-production-adapter/contract";
import { canonicalJson, sha256Text } from "@/server/internal/p1-production-adapter/identity";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";

/**
 * Owner authorization is a signed approval.
 * Matching field names are not authority.
 * This module verifies a signature. It does not sign one.
 * The production trust key is read from a fixed path and is a public key.
 */

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAYLOAD_KEYS = [
  "attemptId",
  "daemonId",
  "decision",
  "dossierSha256",
  "kind",
  "nonce",
  "notAfter",
  "notBefore",
  "operation",
  "recoverySha256",
  "scope",
] as const;

const SHORTCUT_KEYS = new Set([
  "authorized",
  "allowProduction",
  "force",
  "yes",
  "approve",
  "bypass",
]);

export type AuthorizationPayload = {
  kind: "OWNER_SIGNED_AUTHORIZATION";
  operation: "P1_ONLY_APPLY";
  decision: "AUTHORIZE_P1_ONLY_APPLY";
  scope: AdapterScope;
  attemptId: string;
  dossierSha256: string;
  recoverySha256: string;
  daemonId: string;
  nonce: string;
  notBefore: string;
  notAfter: string;
};

export type SignedAuthorization = {
  payload: AuthorizationPayload;
  signature: string;
};

export type ReplayStore = {
  seen(digest: string): boolean;
  consume(digest: string): void;
};

export function verifySignedAuthorization(
  value: unknown,
  publicKeyPem: string,
  expected: {
    scope: AdapterScope;
    attemptId: string;
    dossierSha256: string;
    recoverySha256: string;
    daemonId: string;
  },
  replay: ReplayStore,
  now = Date.now(),
): AuthorizationPayload {
  const signed = parseSigned(value);
  assertSignature(signed, publicKeyPem);
  const payload = signed.payload;
  if (payload.scope !== expected.scope || payload.attemptId !== expected.attemptId) {
    throw refusal("STOP", "AUTHORIZATION_MISMATCH", "Signed authorization is for a different target");
  }
  if (
    payload.dossierSha256 !== expected.dossierSha256 ||
    payload.recoverySha256 !== expected.recoverySha256 ||
    payload.daemonId !== expected.daemonId
  ) {
    throw refusal("STOP", "AUTHORIZATION_MISMATCH", "Signed authorization does not match the live target");
  }
  const start = Date.parse(payload.notBefore);
  const end = Date.parse(payload.notAfter);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_WINDOW_MS) {
    throw refusal("STOP", "AUTHORIZATION_REPLAY", "Signed authorization window is not bounded");
  }
  if (now < start || now > end) {
    throw refusal("STOP", "AUTHORIZATION_REPLAY", "Signed authorization is outside its time window");
  }
  const digest = sha256Text(`${canonicalJson(payload)}.${signed.signature}`);
  if (replay.seen(digest)) {
    throw refusal("STOP", "AUTHORIZATION_REPLAY", "Signed authorization was already used");
  }
  replay.consume(digest);
  return payload;
}

export function readInstalledSignedAuthorization(): unknown {
  if (!fs.existsSync(PRODUCTION_SIGNED_AUTHORIZATION_PATH)) return undefined;
  return JSON.parse(fs.readFileSync(PRODUCTION_SIGNED_AUTHORIZATION_PATH, "utf8")) as unknown;
}

export function readInstalledTrustPublicKey(): string | null {
  if (!fs.existsSync(PRODUCTION_AUTHORIZATION_TRUST_PATH)) return null;
  let pem = "";
  try {
    pem = fs.readFileSync(PRODUCTION_AUTHORIZATION_TRUST_PATH, "utf8");
    if (pem.includes("PRIVATE")) return null;
    const key = createPublicKey(pem);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return null;
  } catch {
    return null;
  }
  return pem;
}

export function memoryReplayStore(): ReplayStore {
  const seen = new Set<string>();
  return {
    seen(digest) {
      return seen.has(digest);
    },
    consume(digest) {
      seen.add(digest);
    },
  };
}

export function fileReplayStore(filePath = PRODUCTION_AUTHORIZATION_REPLAY_PATH): ReplayStore {
  const load = (): Set<string> => {
    if (!fs.existsSync(filePath)) return new Set();
    return new Set(
      fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  };
  return {
    seen(digest) {
      return load().has(digest);
    },
    consume(digest) {
      const next = load();
      if (next.has(digest)) return;
      next.add(digest);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${[...next].join("\n")}\n`, { mode: 0o600 });
    },
  };
}

function assertSignature(signed: SignedAuthorization, publicKeyPem: string): void {
  if (publicKeyPem.includes("PRIVATE")) {
    throw refusal("STOP", "AUTHORIZATION_ORIGIN_REJECTED", "A private key is not a trust source");
  }
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw refusal("STOP", "AUTHORIZATION_ORIGIN_REJECTED", "Authorization trust key is not usable");
  }
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw refusal("STOP", "AUTHORIZATION_ORIGIN_REJECTED", "Authorization trust key is not an Ed25519 public key");
  }
  const signature = Buffer.from(signed.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== signed.signature) {
    throw refusal("STOP", "AUTHORIZATION_ORIGIN_REJECTED", "Authorization signature is not intact");
  }
  const intact = verify(null, Buffer.from(canonicalJson(signed.payload)), publicKey, signature);
  if (!intact) {
    throw refusal("STOP", "AUTHORIZATION_ORIGIN_REJECTED", "Authorization signature does not match the trust key");
  }
}

function parseSigned(value: unknown): SignedAuthorization {
  if (typeof value === "boolean" || typeof value === "string" || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal("STOP", "AUTHORIZATION_REQUIRED", "Production apply has no signed owner authorization");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => SHORTCUT_KEYS.has(key))) {
    throw refusal("STOP", "SHORTCUT_AUTHORIZATION", "A flag cannot authorize production apply");
  }
  if (Object.keys(record).sort().join(",") !== "payload,signature") {
    throw refusal("STOP", "AUTHORIZATION_REQUIRED", "An unsigned authorization object is not authority");
  }
  if (typeof record.signature !== "string" || record.signature.length === 0) {
    throw refusal("STOP", "AUTHORIZATION_ORIGIN_REJECTED", "Authorization signature is missing");
  }
  const payload = parsePayload(record.payload);
  return { payload, signature: record.signature };
}

function parsePayload(value: unknown): AuthorizationPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal("STOP", "AUTHORIZATION_REQUIRED", "Authorization payload is missing");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => SHORTCUT_KEYS.has(key))) {
    throw refusal("STOP", "SHORTCUT_AUTHORIZATION", "A flag cannot authorize production apply");
  }
  if (Object.keys(record).sort().join(",") !== [...PAYLOAD_KEYS].sort().join(",")) {
    throw refusal("STOP", "AUTHORIZATION_REQUIRED", "Authorization payload is not the signed P1 decision");
  }
  if (
    record.kind !== "OWNER_SIGNED_AUTHORIZATION" ||
    record.operation !== "P1_ONLY_APPLY" ||
    record.decision !== "AUTHORIZE_P1_ONLY_APPLY"
  ) {
    throw refusal("STOP", "AUTHORIZATION_REQUIRED", "Authorization is not an explicit P1-only decision");
  }
  if (record.scope !== "PRODUCTION" && record.scope !== "TEST_OWNED") {
    throw refusal("STOP", "AUTHORIZATION_MISMATCH", "Authorization scope is not recognized");
  }
  if (
    typeof record.attemptId !== "string" ||
    typeof record.daemonId !== "string" ||
    typeof record.dossierSha256 !== "string" ||
    typeof record.recoverySha256 !== "string" ||
    typeof record.nonce !== "string" ||
    typeof record.notBefore !== "string" ||
    typeof record.notAfter !== "string" ||
    !ATTEMPT_ID.test(record.attemptId) ||
    !SHA256.test(record.dossierSha256) ||
    !SHA256.test(record.recoverySha256) ||
    !/^[0-9a-f]{32}$/.test(record.nonce)
  ) {
    throw refusal("STOP", "AUTHORIZATION_MISMATCH", "Authorization is not bound to the dossier");
  }
  return record as AuthorizationPayload;
}
