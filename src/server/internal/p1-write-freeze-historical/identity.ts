/**
 * Identity for the disposable historical-application container.
 * The database container stays on the Package A checks. This file
 * refuses an application container that is not the one this run built.
 */

export const HISTORICAL_APPLICATION_COMMIT = "678cbc1d308ddfe568b901ebf53f7e05f9a8c014" as const;
export const HISTORICAL_APPLICATION_TREE = "502f5f5a3c7f2e4ec70427f935485e8184d7b984" as const;
export const APP_LABEL = "stell22.p1.write-freeze-historical" as const;

const FULL_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export type AppExpectation = {
  containerId: string;
  containerName: string;
  imageId: string;
  imageRef: string;
  networkName: string;
  runId: string;
  purpose: "application" | "oneshot" | "created";
};

export type AppCode =
  | "MALFORMED"
  | "FORBIDDEN_NAME"
  | "ID_MISMATCH"
  | "NAME_MISMATCH"
  | "LABEL_MISMATCH"
  | "IMAGE_MISMATCH"
  | "NETWORK_MISMATCH"
  | "PORT_EXPOSED"
  | "COMPOSE_PROJECT"
  | "PRIVILEGED_URL"
  | "URL_MISMATCH";

export type AppVerdict = { ok: true } | { ok: false; code: AppCode };

export function evaluateAppInspect(document: unknown, expected: AppExpectation): AppVerdict {
  const row = asRecord(document);
  if (row === undefined) return { ok: false, code: "MALFORMED" };
  const name = typeof row.Name === "string" ? row.Name.replace(/^\//, "") : "";
  if (isForbidden(name) || isForbidden(expected.containerName) || isForbidden(expected.imageRef)) {
    return { ok: false, code: "FORBIDDEN_NAME" };
  }
  if (name !== expected.containerName || !name.startsWith("stell22-p1wf-")) {
    return { ok: false, code: "NAME_MISMATCH" };
  }
  if (row.Id !== expected.containerId || !FULL_ID.test(expected.containerId)) {
    return { ok: false, code: "ID_MISMATCH" };
  }
  const config = asRecord(row.Config);
  const labels = config ? asRecord(config.Labels) : undefined;
  if (labels?.[APP_LABEL] !== expected.runId) return { ok: false, code: "LABEL_MISMATCH" };
  if (labels?.["com.docker.compose.project"] !== undefined) return { ok: false, code: "COMPOSE_PROJECT" };
  if (config?.Image !== expected.imageRef || row.Image !== expected.imageId || !IMAGE_ID.test(expected.imageId)) {
    return { ok: false, code: "IMAGE_MISMATCH" };
  }
  if (!networkOwned(row, expected.networkName)) return { ok: false, code: "NETWORK_MISMATCH" };
  const url = applicationUser(config?.Env);
  if (url === "privileged") return { ok: false, code: "PRIVILEGED_URL" };
  if (expected.purpose === "application") {
    if (!portsAreLoopback(row)) return { ok: false, code: "PORT_EXPOSED" };
    if (url !== "app") return { ok: false, code: "URL_MISMATCH" };
    return { ok: true };
  }
  if (published(row)) return { ok: false, code: "PORT_EXPOSED" };
  if (expected.purpose === "created") return { ok: true };
  if (url !== "migrator") return { ok: false, code: "URL_MISMATCH" };
  return { ok: true };
}

export function applicationUser(env: unknown): "app" | "migrator" | "privileged" | "missing" {
  if (!Array.isArray(env)) return "missing";
  const line = env.find((item) => typeof item === "string" && item.startsWith("DATABASE_URL="));
  if (typeof line !== "string") return "missing";
  const value = line.slice("DATABASE_URL=".length);
  let username = "";
  try {
    username = decodeURIComponent(new URL(value).username);
  } catch {
    return "missing";
  }
  if (username === "p1wf_app") return "app";
  if (username === "p1wf_migrator") return "migrator";
  if (username.length === 0) return "missing";
  return "privileged";
}

function isForbidden(name: string): boolean {
  return ["stell22-db-prod", "stell22-app", "stell22-caddy"].includes(name.replace(/^\//, "").toLowerCase());
}

function networkOwned(row: Record<string, unknown>, networkName: string): boolean {
  const settings = asRecord(row.NetworkSettings);
  const networks = settings ? asRecord(settings.Networks) : undefined;
  if (networks === undefined) return false;
  const names = Object.keys(networks);
  return names.length === 1 && names[0] === networkName;
}

function published(row: Record<string, unknown>): boolean {
  const host = asRecord(row.HostConfig);
  const bindings = host ? asRecord(host.PortBindings) : undefined;
  if (bindings === undefined || host?.PortBindings == null) return false;
  return Object.values(bindings).some((value) => Array.isArray(value) && value.length > 0);
}

function portsAreLoopback(row: Record<string, unknown>): boolean {
  const host = asRecord(row.HostConfig);
  const bindings = host ? asRecord(host.PortBindings) : undefined;
  if (bindings === undefined) return false;
  const values = Object.values(bindings);
  if (values.length === 0) return false;
  for (const value of values) {
    if (!Array.isArray(value) || value.length === 0) return false;
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
