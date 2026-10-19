import {
  COORDINATOR_LABEL,
  FORBIDDEN_RESOURCE_NAMES,
  IMAGE_REF,
  type Binding,
} from "@/server/internal/p1-write-freeze-coordinator/contract";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATABASE_NAME = /^p1wc_[0-9a-f]{8}$/;
const RESTORE_DATABASE_NAME = /^p1wcr_[0-9a-f]{8}$/;

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
  const prefix = `stell22-p1wc-${runId}`;
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
  if (!bare.startsWith("stell22-p1wc-")) throw new Error("refusing resource outside this coordinator prefix");
}

export function assertCoordinatorDatabase(name: string): void {
  if (!DATABASE_NAME.test(name)) throw new Error("refusing database name");
}

export function assertRestoreDatabase(name: string, source: string): void {
  if (!RESTORE_DATABASE_NAME.test(name) || name === source) throw new Error("refusing restore database");
}

export function assertBinding(binding: Binding): void {
  if (binding.scope !== "TEST_OWNED") throw new Error("refusing scope");
  assertCoordinatorDatabase(binding.databaseName);
  if (!/^[0-9a-f]{64}$/.test(binding.containerId)) throw new Error("refusing container id");
  if (!/^sha256:[0-9a-f]{64}$/.test(binding.imageId)) throw new Error("refusing image id");
  if (!/^17\d{4}$/.test(binding.serverVersionNum)) throw new Error("refusing postgres version");
  if (!Number.isInteger(binding.applicationPid) || binding.applicationPid <= 0) {
    throw new Error("refusing application pid");
  }
}

export function rejectCallerTarget(value: { mode?: string; databaseUrl?: string; database?: string }): void {
  if (value.mode !== undefined && value.mode !== "TEST_OWNED") throw new Error("refusing production mode");
  if (value.databaseUrl !== undefined) throw new Error("refusing caller dsn");
  if (value.database !== undefined) assertCoordinatorDatabase(value.database);
}

export function sameBinding(left: Binding, right: Binding): boolean {
  return (
    left.scope === right.scope &&
    left.invocationId === right.invocationId &&
    left.endpoint === right.endpoint &&
    left.daemonId === right.daemonId &&
    left.containerId === right.containerId &&
    left.imageId === right.imageId &&
    left.startedAt === right.startedAt &&
    left.databaseName === right.databaseName &&
    left.databaseOid === right.databaseOid &&
    left.systemIdentifier === right.systemIdentifier &&
    left.serverVersionNum === right.serverVersionNum &&
    left.applicationPid === right.applicationPid
  );
}

export function evaluateInspect(
  document: unknown,
  expected: OwnedExpectation,
  purpose: "mutate" | "cleanup",
): InspectVerdict {
  const row = asRecord(document);
  if (row === undefined) return { ok: false, code: "MALFORMED" };
  const name = typeof row.Name === "string" ? row.Name.replace(/^\//, "") : "";
  if (isForbidden(name) || isForbidden(expected.containerName)) return { ok: false, code: "FORBIDDEN_NAME" };
  if (name !== expected.containerName || !name.startsWith("stell22-p1wc-")) return { ok: false, code: "NAME_MISMATCH" };
  if (row.Id !== expected.containerId || !/^[0-9a-f]{64}$/.test(expected.containerId)) {
    return { ok: false, code: "ID_MISMATCH" };
  }
  const config = asRecord(row.Config);
  const labels = config ? asRecord(config.Labels) : undefined;
  if (labels?.[COORDINATOR_LABEL] !== expected.runId) return { ok: false, code: "LABEL_MISMATCH" };
  if (labels?.["com.docker.compose.project"] !== undefined) return { ok: false, code: "COMPOSE_PROJECT" };
  const state = asRecord(row.State);
  if (purpose === "mutate" && state?.Running !== true) return { ok: false, code: "NOT_RUNNING" };
  if (config?.Image !== IMAGE_REF || row.Image !== expected.imageId || !/^sha256:[0-9a-f]{64}$/.test(expected.imageId)) {
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

export function volumeCleanupAllowed(document: unknown, expected: OwnedExpectation): InspectVerdict {
  const row = asRecord(document);
  if (row === undefined) return { ok: false, code: "MALFORMED" };
  if (typeof row.Name !== "string" || row.Name !== expected.volumeName) return { ok: false, code: "NAME_MISMATCH" };
  if (isForbidden(row.Name)) return { ok: false, code: "FORBIDDEN_NAME" };
  const labels = asRecord(row.Labels);
  if (labels?.[COORDINATOR_LABEL] !== expected.runId) return { ok: false, code: "LABEL_MISMATCH" };
  if (labels?.["com.docker.compose.project"] !== undefined) return { ok: false, code: "COMPOSE_PROJECT" };
  return { ok: true };
}

export function networkCleanupAllowed(document: unknown, expected: OwnedExpectation): InspectVerdict {
  const row = asRecord(document);
  if (row === undefined) return { ok: false, code: "MALFORMED" };
  if (typeof row.Name !== "string" || row.Name !== expected.networkName) return { ok: false, code: "NAME_MISMATCH" };
  if (isForbidden(row.Name)) return { ok: false, code: "FORBIDDEN_NAME" };
  const labels = asRecord(row.Labels);
  if (labels?.[COORDINATOR_LABEL] !== expected.runId) return { ok: false, code: "LABEL_MISMATCH" };
  if (labels?.["com.docker.compose.project"] !== undefined) return { ok: false, code: "COMPOSE_PROJECT" };
  const containers = asRecord(row.Containers) ?? {};
  if (Object.keys(containers).some((id) => id !== expected.containerId)) return { ok: false, code: "ID_MISMATCH" };
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
  return mount?.Type === "volume" && mount.Name === volumeName && mount.Destination === "/var/lib/postgresql/data";
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
