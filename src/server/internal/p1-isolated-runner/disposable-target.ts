import {
  FORBIDDEN_CONTAINER_IDENTIFIERS,
  FORBIDDEN_DATABASE_NAMES,
  FORBIDDEN_HOSTS,
  LOOPBACK_HOSTS,
} from "@/server/internal/p1-isolated-runner/contract";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";

const ATTESTATION_KEYS = [
  "kind",
  "version",
  "runId",
  "databaseName",
  "host",
  "port",
  "user",
  "password",
  "containerId",
  "containerName",
  "image",
  "nonce",
  "composeProject",
  "networkName",
  "postgresMajor",
] as const;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{32,}$/;

export type DisposableAttestation = {
  kind: "stell22-p1-disposable-target";
  version: 1;
  runId: string;
  databaseName: string;
  host: string;
  port: number;
  user: string;
  password: string;
  containerId: string;
  containerName: string;
  image: "postgres:17" | "postgres:17-alpine";
  nonce: string;
  composeProject: string;
  networkName: string;
  postgresMajor: 17;
};

export type DisposableProbeResult = {
  currentDatabase: string;
  serverVersionNum: number;
  runId: string;
  nonce: string;
  containerId: string;
};

export type VerifiedDisposableTarget = {
  runId: string;
  databaseName: string;
  containerId: string;
  connectionUrl: string;
};

export function parseDisposableAttestation(raw: unknown): DisposableAttestation {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw refusal("STOP", "MALFORMED_ATTESTATION", "Disposable attestation is not an object");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...ATTESTATION_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw refusal(
      "STOP",
      "MALFORMED_ATTESTATION",
      "Disposable attestation keys are not the required set",
    );
  }
  if (record.kind !== "stell22-p1-disposable-target" || record.version !== 1) {
    throw refusal(
      "STOP",
      "MALFORMED_ATTESTATION",
      "Disposable attestation kind or version is wrong",
    );
  }
  if (typeof record.runId !== "string" || !RUN_ID.test(record.runId)) {
    throw refusal("STOP", "MISSING_DISPOSABLE_IDENTITY", "Disposable run id is missing");
  }
  const runId = record.runId.toLowerCase();
  const databaseName = `p1disp_${runId.replaceAll("-", "")}`;
  if (record.databaseName !== databaseName || isForbiddenDatabase(databaseName)) {
    throw refusal("STOP", "WRONG_DATABASE_IDENTITY", "Database name is not this disposable run");
  }
  if (typeof record.host !== "string" || !isLoopback(record.host) || isForbiddenHost(record.host)) {
    throw refusal("STOP", "WRONG_DATABASE_IDENTITY", "Host is not a loopback disposable target");
  }
  if (
    typeof record.port !== "number" ||
    !Number.isInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535
  ) {
    throw refusal("STOP", "MALFORMED_ATTESTATION", "Port is not a TCP port");
  }
  if (record.user !== "p1disp") {
    throw refusal("STOP", "WRONG_DATABASE_IDENTITY", "Database user is not the disposable role");
  }
  if (typeof record.password !== "string" || record.password.length < 16) {
    throw refusal("STOP", "MISSING_DISPOSABLE_IDENTITY", "Disposable password is missing");
  }
  if (typeof record.containerId !== "string" || !CONTAINER_ID.test(record.containerId)) {
    throw refusal("STOP", "MISSING_DISPOSABLE_IDENTITY", "Disposable container id is missing");
  }
  if (
    isForbiddenContainer(record.containerId) ||
    isForbiddenContainer(String(record.containerName))
  ) {
    throw refusal(
      "STOP",
      "WRONG_DATABASE_IDENTITY",
      "Container identity is a production identifier",
    );
  }
  const containerName = `stell22-p1-disposable-${runId}`;
  if (
    record.containerName !== containerName ||
    record.composeProject !== containerName ||
    record.networkName !== containerName
  ) {
    throw refusal(
      "STOP",
      "MISSING_DISPOSABLE_IDENTITY",
      "Disposable service identity does not match the run id",
    );
  }
  if (record.image !== "postgres:17" && record.image !== "postgres:17-alpine") {
    throw refusal("STOP", "WRONG_DATABASE_IDENTITY", "Image is not PostgreSQL 17");
  }
  if (record.postgresMajor !== 17) {
    throw refusal("STOP", "WRONG_DATABASE_IDENTITY", "PostgreSQL major version is not 17");
  }
  if (typeof record.nonce !== "string" || !NONCE.test(record.nonce)) {
    throw refusal("STOP", "MISSING_DISPOSABLE_NONCE", "Disposable nonce is missing");
  }
  return {
    kind: "stell22-p1-disposable-target",
    version: 1,
    runId,
    databaseName,
    host: record.host,
    port: record.port,
    user: "p1disp",
    password: record.password,
    containerId: record.containerId,
    containerName,
    image: record.image,
    nonce: record.nonce,
    composeProject: containerName,
    networkName: containerName,
    postgresMajor: 17,
  };
}

export function authenticateDisposableTarget(
  raw: unknown,
  probe: (attestation: DisposableAttestation) => DisposableProbeResult,
): VerifiedDisposableTarget {
  const attestation = parseDisposableAttestation(raw);
  let probed: DisposableProbeResult;
  try {
    probed = probe(attestation);
  } catch {
    throw refusal("STOP", "MISSING_DISPOSABLE_IDENTITY", "Disposable identity probe failed");
  }
  if (!probed || typeof probed.nonce !== "string" || probed.nonce.length === 0) {
    throw refusal(
      "STOP",
      "MISSING_DISPOSABLE_NONCE",
      "Disposable nonce was not stored in the target",
    );
  }
  if (probed.nonce !== attestation.nonce) {
    throw refusal(
      "STOP",
      "DISPOSABLE_NONCE_MISMATCH",
      "Disposable nonce does not match the target",
    );
  }
  if (
    probed.currentDatabase !== attestation.databaseName ||
    isForbiddenDatabase(probed.currentDatabase)
  ) {
    throw refusal("STOP", "WRONG_DATABASE_IDENTITY", "Probe database is not this disposable run");
  }
  if (probed.runId !== attestation.runId || probed.containerId !== attestation.containerId) {
    throw refusal(
      "STOP",
      "DISPOSABLE_IDENTITY_MISMATCH",
      "Probe identity does not match the attestation",
    );
  }
  if (
    !Number.isInteger(probed.serverVersionNum) ||
    probed.serverVersionNum < 170000 ||
    probed.serverVersionNum >= 180000
  ) {
    throw refusal("STOP", "WRONG_DATABASE_IDENTITY", "Probe server is not PostgreSQL 17");
  }
  return {
    runId: attestation.runId,
    databaseName: attestation.databaseName,
    containerId: attestation.containerId,
    connectionUrl: connectionUrl(attestation),
  };
}

function connectionUrl(attestation: DisposableAttestation): string {
  const url = new URL("postgresql://127.0.0.1");
  url.username = attestation.user;
  url.password = attestation.password;
  url.hostname = attestation.host;
  url.port = String(attestation.port);
  url.pathname = `/${attestation.databaseName}`;
  url.searchParams.set("schema", "public");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database !== attestation.databaseName || isForbiddenDatabase(database)) {
    throw refusal("STOP", "WRONG_DATABASE_IDENTITY", "Constructed URL database is not disposable");
  }
  return url.toString();
}

function isForbiddenDatabase(name: string): boolean {
  return FORBIDDEN_DATABASE_NAMES.includes(
    name.toLowerCase() as (typeof FORBIDDEN_DATABASE_NAMES)[number],
  );
}

function isForbiddenHost(host: string): boolean {
  return FORBIDDEN_HOSTS.includes(host.toLowerCase() as (typeof FORBIDDEN_HOSTS)[number]);
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host.toLowerCase() as (typeof LOOPBACK_HOSTS)[number]);
}

function isForbiddenContainer(value: string): boolean {
  const lower = value.toLowerCase();
  return FORBIDDEN_CONTAINER_IDENTIFIERS.some((name) => lower === name || lower.includes(name));
}
