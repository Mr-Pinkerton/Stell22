import { ALLOWED_LOCAL_DOCKER_ENDPOINTS } from "@/server/internal/p1-isolated-runner/container-origin";
import { FORBIDDEN_DATABASE_NAMES } from "@/server/internal/p1-isolated-runner/contract";

const DISPOSABLE_DATABASE_NAME = /^p1as_[0-9a-f]{8}$/;
const DISPOSABLE_CONTAINER_NAME = /^p1as-[a-z0-9-]+$/;
const LOCAL_ENDPOINTS = new Set<string>(ALLOWED_LOCAL_DOCKER_ENDPOINTS);
const PRODUCTION_DATABASES = new Set<string>(FORBIDDEN_DATABASE_NAMES);
const PRODUCTION_CONTAINERS = [
  "stell22-db-prod",
  "stell22-app",
  "stell22-caddy",
  "stell22-db",
] as const;

export type RehearsalTarget = {
  databaseName: string;
  restoreDatabaseName: string | null;
  containerNames: readonly string[];
  credentialPath: string | null;
  dockerEndpoint: string | null;
  releaseEnvironment: string | null;
  sshTarget: string | null;
};

export type IdentityDecision = { ok: true } | { ok: false; code: string };

export function rehearsalIdentity(runId: string): RehearsalTarget {
  if (!/^[0-9a-f]{8}$/.test(runId)) {
    throw new Error("disposable rehearsal id is not 8 hex digits");
  }
  const restoreId = ((Number.parseInt(runId, 16) + 1) >>> 0).toString(16).padStart(8, "0");
  return {
    databaseName: `p1as_${runId}`,
    restoreDatabaseName: `p1as_${restoreId}`,
    containerNames: [
      `p1as-db-${runId}`,
      `p1as-app-${runId}`,
      `p1as-net-${runId}`,
      `p1as-vol-${runId}`,
    ],
    credentialPath: null,
    dockerEndpoint: null,
    releaseEnvironment: "TEST_OWNED",
    sshTarget: null,
  };
}

export function assertRehearsalTarget(target: RehearsalTarget): IdentityDecision {
  if (
    target.databaseName.trim() === "" ||
    target.restoreDatabaseName === null ||
    target.restoreDatabaseName.trim() === ""
  ) {
    return refuse("AMBIGUOUS_IDENTITY");
  }
  if (
    PRODUCTION_DATABASES.has(target.databaseName) ||
    PRODUCTION_DATABASES.has(target.restoreDatabaseName)
  ) {
    return refuse("PRODUCTION_DATABASE_REFUSED");
  }
  if (
    !DISPOSABLE_DATABASE_NAME.test(target.databaseName) ||
    !DISPOSABLE_DATABASE_NAME.test(target.restoreDatabaseName)
  ) {
    return refuse("UNSUPPORTED_IDENTITY");
  }
  if (target.databaseName === target.restoreDatabaseName) return refuse("AMBIGUOUS_IDENTITY");
  if (
    target.containerNames.length === 0 ||
    target.containerNames.some((name) => name.trim() === "")
  ) {
    return refuse("AMBIGUOUS_IDENTITY");
  }
  for (const name of target.containerNames) {
    if (
      PRODUCTION_CONTAINERS.some((production) => name === production || name.includes(production))
    ) {
      return refuse("PRODUCTION_CONTAINER_REFUSED");
    }
    if (!DISPOSABLE_CONTAINER_NAME.test(name)) return refuse("UNSUPPORTED_IDENTITY");
  }
  if (target.credentialPath !== null) return refuse("PRODUCTION_CREDENTIAL_REFUSED");
  if (isRemote(target.sshTarget) || isRemote(target.dockerEndpoint))
    return refuse("PRODUCTION_SSH_REFUSED");
  if (target.dockerEndpoint === null || target.dockerEndpoint.trim() === "")
    return refuse("AMBIGUOUS_IDENTITY");
  if (!LOCAL_ENDPOINTS.has(target.dockerEndpoint)) return refuse("UNSUPPORTED_IDENTITY");
  if (target.releaseEnvironment === null || target.releaseEnvironment.trim() === "")
    return refuse("AMBIGUOUS_IDENTITY");
  if (/production/i.test(target.releaseEnvironment))
    return refuse("PRODUCTION_RELEASE_ENVIRONMENT_REFUSED");
  if (target.releaseEnvironment !== "TEST_OWNED") return refuse("UNSUPPORTED_IDENTITY");
  return { ok: true };
}

function isRemote(value: string | null): boolean {
  if (value === null || value.trim() === "") return false;
  return value.startsWith("ssh://") || value.startsWith("tcp://") || value.includes("@");
}

function refuse(code: string): IdentityDecision {
  return { ok: false, code };
}
