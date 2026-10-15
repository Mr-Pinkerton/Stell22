import { createHash } from "node:crypto";
import {
  ATTEMPT_ID,
  CONTAINER_ID,
  DAEMON_ID,
  IMAGE_GIT_SHA,
  IMAGE_ID,
  PRODUCTION_APP_CONTAINER,
  PRODUCTION_DATABASE_NAME,
  PRODUCTION_DB_CONTAINER,
  PRODUCTION_DNS_ALIAS,
  PRODUCTION_NETWORK_NAME,
  PRODUCTION_POSTGRES_IMAGE,
  PRODUCTION_POSTGRES_MAJOR,
  PRODUCTION_ROLE_NAME,
  TEST_ROLE_NAME,
  testAppName,
  testDatabaseName,
  testDbName,
  testNetworkName,
  type AdapterScope,
} from "@/server/internal/p1-production-adapter/contract";
import {
  FORBIDDEN_CONTAINER_IDENTIFIERS,
  FORBIDDEN_DATABASE_NAMES,
} from "@/server/internal/p1-isolated-runner/contract";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";

/**
 * Runtime identity of one container.
 * `imageId` is the Docker image id. `imageGitSha` stays UNVERIFIED.
 */
export type ContainerFact = {
  id: string;
  imageId: string;
  imageRef: string;
  startedAt: string;
  running: boolean;
  name: string;
  entrypoint: readonly string[];
  command: readonly string[];
  publishedDbPort: boolean;
  networks: readonly { name: string; aliases: readonly string[] }[];
};

export type TargetFacts = {
  scope: AdapterScope;
  attemptId: string;
  daemonId: string;
  app: ContainerFact;
  db: ContainerFact;
  databaseName: string;
  roleName: string;
  networkName: string;
  dnsAlias: string;
  serverVersionNum: number;
};

export type TargetDeclaration = {
  scope: AdapterScope;
  attemptId: string;
  daemonId: string;
  appId: string;
  appImageId: string;
  appStartedAt: string;
  dbId: string;
  dbImageId: string;
  dbStartedAt: string;
  databaseName: string;
  roleName: string;
  networkName: string;
  dnsAlias: string;
};

const PRODUCTION_NAMES = new Set<string>([
  ...FORBIDDEN_CONTAINER_IDENTIFIERS,
  PRODUCTION_APP_CONTAINER,
  PRODUCTION_DB_CONTAINER,
  PRODUCTION_NETWORK_NAME,
]);

export function authenticateTarget(input: {
  scope: AdapterScope;
  declared: TargetDeclaration;
  observed: TargetFacts;
  productionDaemonPin: string | null;
}): void {
  assertShape(input.observed);
  if (input.declared.scope !== input.scope || input.observed.scope !== input.scope) {
    throw refusal("STOP", "TARGET_SCOPE_MISMATCH", "Declared scope does not match the observation");
  }
  if (!sameDeclaration(input.declared, input.observed)) {
    throw refusal("STOP", "RUNTIME_IDENTITY_MISMATCH", "Declared target does not match the live inspect");
  }
  if (input.scope === "PRODUCTION") {
    assertProductionShape(input.observed, input.productionDaemonPin);
    return;
  }
  assertTestOwnedShape(input.observed);
}

export function sameAppIdentity(left: ContainerFact, right: ContainerFact): boolean {
  return (
    left.id === right.id &&
    left.imageId === right.imageId &&
    left.startedAt === right.startedAt &&
    left.running === right.running &&
    left.name === right.name
  );
}

export function dossierDigest(facts: TargetFacts): string {
  const body = canonicalJson({
    scope: facts.scope,
    attemptId: facts.attemptId,
    daemonId: facts.daemonId,
    networkName: facts.networkName,
    dnsAlias: facts.dnsAlias,
    databaseName: facts.databaseName,
    roleName: facts.roleName,
    serverVersionNum: facts.serverVersionNum,
    imageGitSha: IMAGE_GIT_SHA,
    app: {
      id: facts.app.id,
      imageId: facts.app.imageId,
      startedAt: facts.app.startedAt,
      name: facts.app.name,
    },
    db: {
      id: facts.db.id,
      imageId: facts.db.imageId,
      startedAt: facts.db.startedAt,
      name: facts.db.name,
    },
    historicalMigrationCount: 45,
    p1Present: false,
    incompleteMigrationCount: 0,
    publishedDbPort: false,
  });
  return sha256Text(body);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function declarationFromFacts(facts: TargetFacts): TargetDeclaration {
  return {
    scope: facts.scope,
    attemptId: facts.attemptId,
    daemonId: facts.daemonId,
    appId: facts.app.id,
    appImageId: facts.app.imageId,
    appStartedAt: facts.app.startedAt,
    dbId: facts.db.id,
    dbImageId: facts.db.imageId,
    dbStartedAt: facts.db.startedAt,
    databaseName: facts.databaseName,
    roleName: facts.roleName,
    networkName: facts.networkName,
    dnsAlias: facts.dnsAlias,
  };
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertProductionShape(facts: TargetFacts, pin: string | null): void {
  if (pin === null || !DAEMON_ID.test(pin)) {
    throw refusal(
      "STOP",
      "PRODUCTION_DAEMON_UNPINNED",
      "Production Docker daemon id is not independently pinned",
    );
  }
  if (facts.daemonId !== pin) {
    throw refusal("STOP", "DAEMON_MISMATCH", "Live Docker daemon does not match the production pin");
  }
  if (
    facts.app.name !== PRODUCTION_APP_CONTAINER ||
    facts.db.name !== PRODUCTION_DB_CONTAINER ||
    facts.networkName !== PRODUCTION_NETWORK_NAME ||
    facts.databaseName !== PRODUCTION_DATABASE_NAME ||
    facts.roleName !== PRODUCTION_ROLE_NAME ||
    facts.dnsAlias !== PRODUCTION_DNS_ALIAS
  ) {
    throw refusal("STOP", "TARGET_ARCHITECTURE_MISMATCH", "Target is not the Stell22 production topology");
  }
  if (facts.db.imageRef !== PRODUCTION_POSTGRES_IMAGE) {
    throw refusal("STOP", "POSTGRES_IMAGE_MISMATCH", "Database image is not postgres:17-alpine");
  }
  assertCommonRuntime(facts);
}

function assertTestOwnedShape(facts: TargetFacts): void {
  const names = [facts.app.name, facts.db.name, facts.networkName, facts.databaseName, facts.roleName];
  if (
    names.some((name) => PRODUCTION_NAMES.has(name)) ||
    FORBIDDEN_DATABASE_NAMES.some((name) => name === facts.databaseName.toLowerCase())
  ) {
    throw refusal(
      "STOP",
      "PRODUCTION_TARGET_REFUSED",
      "Test-owned scope cannot claim production names",
    );
  }
  if (
    facts.app.name !== testAppName(facts.attemptId) ||
    facts.db.name !== testDbName(facts.attemptId) ||
    facts.networkName !== testNetworkName(facts.attemptId) ||
    facts.databaseName !== testDatabaseName(facts.attemptId) ||
    facts.roleName !== TEST_ROLE_NAME ||
    facts.dnsAlias !== PRODUCTION_DNS_ALIAS
  ) {
    throw refusal("STOP", "TEST_TARGET_MISMATCH", "Test-owned names are not bound to this attempt");
  }
  if (!facts.db.imageRef.startsWith("postgres:17")) {
    throw refusal("STOP", "POSTGRES_IMAGE_MISMATCH", "Test database image is not PostgreSQL 17");
  }
  assertCommonRuntime(facts);
}

function assertCommonRuntime(facts: TargetFacts): void {
  if (!facts.app.running || !facts.db.running) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "App or database container is not running");
  }
  if (facts.db.publishedDbPort || facts.app.id === facts.db.id) {
    throw refusal("STOP", "DATABASE_PORT_PUBLISHED", "Database port is published or container ids collide");
  }
  const major = Math.floor(facts.serverVersionNum / 10_000);
  if (major !== PRODUCTION_POSTGRES_MAJOR) {
    throw refusal("STOP", "POSTGRES_MAJOR_MISMATCH", "Database server is not PostgreSQL 17");
  }
  const dbNetwork = facts.db.networks.find((network) => network.name === facts.networkName);
  const appNetwork = facts.app.networks.find((network) => network.name === facts.networkName);
  if (!dbNetwork || !appNetwork || !dbNetwork.aliases.includes(facts.dnsAlias)) {
    throw refusal("STOP", "NETWORK_ALIAS_MISMATCH", "App and database do not share the dns alias");
  }
  if (facts.dnsAlias === "127.0.0.1" || facts.dnsAlias === "localhost") {
    throw refusal("STOP", "DATABASE_URL_REJECTED", "Loopback is not the production connection scheme");
  }
}

function assertShape(facts: TargetFacts): void {
  if (!ATTEMPT_ID.test(facts.attemptId) || !DAEMON_ID.test(facts.daemonId)) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Attempt or daemon id is missing");
  }
  for (const container of [facts.app, facts.db]) {
    if (!CONTAINER_ID.test(container.id)) {
      throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Container id is not a full digest");
    }
    if (isGitSha(container.imageId)) {
      throw refusal("STOP", "IMAGE_ID_NOT_GIT_SHA", "Image id is not a Git SHA");
    }
    if (!IMAGE_ID.test(container.imageId)) {
      throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Image id is not a Docker digest");
    }
    if (!container.startedAt.startsWith("20")) {
      throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Container start time is missing");
    }
  }
}

function isGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function sameDeclaration(declared: TargetDeclaration, observed: TargetFacts): boolean {
  return (
    declared.attemptId === observed.attemptId &&
    declared.daemonId === observed.daemonId &&
    declared.appId === observed.app.id &&
    declared.appImageId === observed.app.imageId &&
    declared.appStartedAt === observed.app.startedAt &&
    declared.dbId === observed.db.id &&
    declared.dbImageId === observed.db.imageId &&
    declared.dbStartedAt === observed.db.startedAt &&
    declared.databaseName === observed.databaseName &&
    declared.roleName === observed.roleName &&
    declared.networkName === observed.networkName &&
    declared.dnsAlias === observed.dnsAlias
  );
}
