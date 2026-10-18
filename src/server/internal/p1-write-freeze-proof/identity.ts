/**
 * Pure identity checks for the disposable write-freeze proof.
 * A database named stell22 is allowed only inside a container this
 * invocation created. Production container names are refused even
 * when the database name matches.
 */

export const PROOF_LABEL = "stell22.p1.write-freeze-proof" as const;
export const IMAGE_REF = "postgres:17-alpine" as const;

export const FORBIDDEN_RESOURCE_NAMES = [
  "stell22-db-prod",
  "stell22-app",
  "stell22-caddy",
] as const;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type OwnedNames = {
  runId: string;
  containerName: string;
  networkName: string;
  volumeName: string;
};

export type OwnedExpectation = OwnedNames & {
  containerId: string;
  imageId: string;
};

export type InspectCode =
  | "MALFORMED"
  | "FORBIDDEN_NAME"
  | "ID_MISMATCH"
  | "NAME_MISMATCH"
  | "LABEL_MISMATCH"
  | "NOT_RUNNING"
  | "IMAGE_MISMATCH"
  | "ENV_MISMATCH"
  | "MOUNT_MISMATCH"
  | "NETWORK_MISMATCH"
  | "PORT_EXPOSED"
  | "COMPOSE_PROJECT";

export type InspectVerdict = { ok: true } | { ok: false; code: InspectCode };

export function namesForRun(runId: string): OwnedNames {
  if (!RUN_ID.test(runId)) throw new Error("refusing run id");
  const prefix = `stell22-p1wf-${runId}`;
  return {
    runId,
    containerName: prefix,
    networkName: `${prefix}-net`,
    volumeName: `${prefix}-vol`,
  };
}

export function assertResourceName(name: string): void {
  const bare = name.replace(/^\//, "").toLowerCase();
  if (FORBIDDEN_RESOURCE_NAMES.some((forbidden) => forbidden === bare)) {
    throw new Error("refusing production resource name");
  }
  if (!bare.startsWith("stell22-p1wf-")) {
    throw new Error("refusing resource outside this proof prefix");
  }
}

export function assertDatabaseName(name: string): void {
  if (name === "stell22" || /^p1wf_[a-z0-9_]+$/.test(name)) return;
  throw new Error("refusing database name");
}

export function evaluateInspect(
  document: unknown,
  expected: OwnedExpectation,
  purpose: "mutate" | "cleanup",
): InspectVerdict {
  const row = asRecord(document);
  if (row === undefined) return { ok: false, code: "MALFORMED" };
  const name = typeof row.Name === "string" ? row.Name.replace(/^\//, "") : "";
  if (isForbidden(name) || isForbidden(expected.containerName)) {
    return { ok: false, code: "FORBIDDEN_NAME" };
  }
  if (name !== expected.containerName || !name.startsWith("stell22-p1wf-")) {
    return { ok: false, code: "NAME_MISMATCH" };
  }
  if (row.Id !== expected.containerId || !/^[0-9a-f]{64}$/.test(expected.containerId)) {
    return { ok: false, code: "ID_MISMATCH" };
  }
  const config = asRecord(row.Config);
  const labels = config ? asRecord(config.Labels) : undefined;
  if (labels?.[PROOF_LABEL] !== expected.runId) return { ok: false, code: "LABEL_MISMATCH" };
  if (labels?.["com.docker.compose.project"] !== undefined) {
    return { ok: false, code: "COMPOSE_PROJECT" };
  }
  const state = asRecord(row.State);
  if (purpose === "mutate" && state?.Running !== true) return { ok: false, code: "NOT_RUNNING" };
  if (config?.Image !== IMAGE_REF && row.Image !== expected.imageId) {
    return { ok: false, code: "IMAGE_MISMATCH" };
  }
  if (!envHas(config?.Env, "POSTGRES_USER=stell22") || !envHas(config?.Env, "POSTGRES_DB=stell22")) {
    return { ok: false, code: "ENV_MISMATCH" };
  }
  if (!volumeOwned(row, expected.volumeName)) return { ok: false, code: "MOUNT_MISMATCH" };
  if (!networkOwned(row, expected.networkName)) return { ok: false, code: "NETWORK_MISMATCH" };
  if (!portsArePrivate(row)) return { ok: false, code: "PORT_EXPOSED" };
  return { ok: true };
}

export function volumeCleanupAllowed(
  document: unknown,
  expected: OwnedExpectation,
): InspectVerdict {
  const row = asRecord(document);
  if (row === undefined) return { ok: false, code: "MALFORMED" };
  if (typeof row.Name !== "string" || row.Name !== expected.volumeName) {
    return { ok: false, code: "NAME_MISMATCH" };
  }
  if (isForbidden(row.Name)) return { ok: false, code: "FORBIDDEN_NAME" };
  const labels = asRecord(row.Labels);
  if (labels?.[PROOF_LABEL] !== expected.runId) return { ok: false, code: "LABEL_MISMATCH" };
  return { ok: true };
}

export function networkCleanupAllowed(
  document: unknown,
  expected: OwnedExpectation,
): InspectVerdict {
  const row = asRecord(document);
  if (row === undefined) return { ok: false, code: "MALFORMED" };
  if (typeof row.Name !== "string" || row.Name !== expected.networkName) {
    return { ok: false, code: "NAME_MISMATCH" };
  }
  if (isForbidden(row.Name)) return { ok: false, code: "FORBIDDEN_NAME" };
  const labels = asRecord(row.Labels);
  if (labels?.[PROOF_LABEL] !== expected.runId) return { ok: false, code: "LABEL_MISMATCH" };
  const containers = asRecord(row.Containers) ?? {};
  const attached = Object.keys(containers);
  if (attached.some((id) => id !== expected.containerId)) {
    return { ok: false, code: "ID_MISMATCH" };
  }
  return { ok: true };
}

function isForbidden(name: string): boolean {
  const bare = name.replace(/^\//, "").toLowerCase();
  return FORBIDDEN_RESOURCE_NAMES.some((forbidden) => forbidden === bare);
}

function envHas(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((item) => item === expected);
}

function volumeOwned(row: Record<string, unknown>, volumeName: string): boolean {
  if (!Array.isArray(row.Mounts) || row.Mounts.length !== 1) return false;
  const mount = asRecord(row.Mounts[0]);
  return (
    mount?.Type === "volume" &&
    mount.Name === volumeName &&
    mount.Destination === "/var/lib/postgresql/data"
  );
}

function networkOwned(row: Record<string, unknown>, networkName: string): boolean {
  const settings = asRecord(row.NetworkSettings);
  const networks = settings ? asRecord(settings.Networks) : undefined;
  if (networks === undefined) return false;
  const names = Object.keys(networks);
  return names.length === 1 && names[0] === networkName;
}

function portsArePrivate(row: Record<string, unknown>): boolean {
  const host = asRecord(row.HostConfig);
  if (host?.PortBindings == null) return true;
  const bindings = asRecord(host.PortBindings);
  if (bindings === undefined) return false;
  for (const value of Object.values(bindings)) {
    if (!Array.isArray(value)) return false;
    for (const binding of value) {
      const item = asRecord(binding);
      if (item?.HostIp !== "127.0.0.1") return false;
    }
  }
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
