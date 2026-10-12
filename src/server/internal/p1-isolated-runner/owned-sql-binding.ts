import {
  reconfirmOwnedContainer,
  type ContainerOriginCode,
  type OriginRuntime,
  type OwnedConnection,
  type OwnedContainerHandle,
  ContainerOriginRefusal,
} from "@/server/internal/p1-isolated-runner/container-origin";
import type { Classification } from "@/server/internal/p1-isolated-runner/classify";
import { parseDisposableAttestation } from "@/server/internal/p1-isolated-runner/disposable-target";
import {
  previewDisposableRead,
  readDisposablePostgreSql,
  type LiveReadReport,
  type ProbeSqlClient,
} from "@/server/internal/p1-isolated-runner/live-read-probe";
import type { RunnerVerdict } from "@/server/internal/p1-isolated-runner/contract";

/**
 * Stage B read-only binding. Docker ownership comes from the Stage A handle.
 * SQL evidence comes only from the existing disposable probe against the
 * reconfirmed loopback connection. A verified binding does not authorize
 * apply, migration, or production authentication.
 */

export type PublicProbeAuthorization = {
  readonly containerOrigin: "NOT_ESTABLISHED";
  readonly fullTargetAuthentication: "NOT_CLAIMED";
  readonly applyEnabled: false;
  readonly verdict: RunnerVerdict | "NOT_RUN";
  readonly code: string;
};

export type OwnedSqlBindingKind =
  | "ownership-not-confirmed"
  | "connection-unavailable"
  | "sql-identity-missing"
  | "sql-identity-mismatch"
  | "session-continuity-failure"
  | "docker-identity-drift"
  | "injected-not-live-proof"
  | "verified-readonly-binding";

type BindingFailureKind = Exclude<OwnedSqlBindingKind, "verified-readonly-binding">;

export type OwnedSqlBindingResult =
  | {
      readonly ok: false;
      readonly kind: BindingFailureKind;
      readonly code: string;
      readonly message: string;
      readonly classification: Classification | null;
      readonly publicAuthorization: PublicProbeAuthorization;
    }
  | {
      readonly ok: true;
      readonly kind: "verified-readonly-binding";
      readonly evidenceSource: "postgresql-query";
      readonly code: string;
      readonly message: string;
      readonly runId: string;
      readonly containerId: string;
      readonly databaseName: string;
      readonly serverVersionNum: number;
      readonly classification: Classification | null;
      readonly publicAuthorization: PublicProbeAuthorization;
    };

export type OwnedSqlBindingDependencies = {
  readonly runtime?: OriginRuntime;
  readonly connect?: (url: string) => Promise<ProbeSqlClient>;
};

const FAILURE_TEXT: Record<BindingFailureKind, string> = {
  "ownership-not-confirmed": "Container ownership was not confirmed.",
  "connection-unavailable": "PostgreSQL connection to the owned container is unavailable.",
  "sql-identity-missing": "Disposable SQL identity is missing.",
  "sql-identity-mismatch": "Disposable SQL identity does not match the owned container.",
  "session-continuity-failure": "Read-only PostgreSQL session continuity failed.",
  "docker-identity-drift": "Docker identity changed around the SQL read.",
  "injected-not-live-proof": "Injected SQL rows are not live PostgreSQL evidence.",
};

const VERIFIED_TEXT =
  "Owned Docker object and disposable SQL identity match for this read-only operation.";

const DRIFT_CODES = new Set<ContainerOriginCode>([
  "DOCKER_ENDPOINT_REMOTE",
  "DOCKER_ENDPOINT_UNDETERMINED",
  "DOCKER_ENDPOINT_AMBIGUOUS",
  "DOCKER_ENDPOINT_CHANGED",
  "DAEMON_IDENTITY_CHANGED",
  "IMAGE_INSPECT_FAILED",
  "IMAGE_ID_UNEXPECTED",
  "INSPECT_ID_MISMATCH",
  "NAME_MISMATCH",
  "LABEL_MISMATCH",
  "CONTAINER_STOPPED",
  "CONTAINER_RESTARTED",
  "CONTAINER_DISAPPEARED",
  "PORT_NOT_LOOPBACK",
  "PORT_MAPPING_MISMATCH",
  "PORT_CHANGED",
  "NETWORK_MODE_UNSUPPORTED",
]);

export async function bindOwnedDisposableSql(
  handle: OwnedContainerHandle,
  dependencies: OwnedSqlBindingDependencies = {},
): Promise<OwnedSqlBindingResult> {
  const runtime = dependencies.runtime;
  let connection: OwnedConnection;
  try {
    connection = reconfirmOwnedContainer(handle, runtime);
  } catch (error) {
    return dockerFailure(error);
  }

  let report: LiveReadReport;
  try {
    const attestation = parseDisposableAttestation(probeInput(connection, handle));
    report = dependencies.connect
      ? await previewDisposableRead(attestation, dependencies.connect)
      : await readDisposablePostgreSql(attestation);
  } catch {
    return failure("ownership-not-confirmed", "PROBE_INPUT_REFUSED", null);
  }

  const interpreted = interpretProbe(report);
  if (interpreted.ok === false) return interpreted;

  try {
    const after = reconfirmOwnedContainer(handle, runtime);
    if (
      after.containerId !== connection.containerId ||
      after.port !== connection.port ||
      after.databaseName !== connection.databaseName ||
      after.runId !== connection.runId
    ) {
      return failure(
        "docker-identity-drift",
        "DOCKER_IDENTITY_DRIFT",
        report.classification,
        report.verdict,
      );
    }
  } catch (error) {
    return dockerFailure(error, report.classification, report.verdict);
  }

  if (report.evidenceSource !== "postgresql-query") {
    return failure(
      "injected-not-live-proof",
      "INJECTED_SQL_NOT_LIVE",
      report.classification,
      report.verdict,
    );
  }
  if (
    report.connection.currentDatabase !== connection.databaseName ||
    report.connection.serverVersionNum === null ||
    report.postgresIdentity.runId !== connection.runId ||
    report.postgresIdentity.containerId !== connection.containerId ||
    report.postgresIdentity.rowCount !== 1
  ) {
    return failure(
      "sql-identity-mismatch",
      "SQL_IDENTITY_MISMATCH",
      report.classification,
      report.verdict,
    );
  }

  return {
    ok: true,
    kind: "verified-readonly-binding",
    evidenceSource: "postgresql-query",
    code: report.code,
    message: VERIFIED_TEXT,
    runId: connection.runId,
    containerId: connection.containerId,
    databaseName: connection.databaseName,
    serverVersionNum: report.connection.serverVersionNum,
    classification: report.classification,
    publicAuthorization: authorization(report.verdict, report.code),
  };
}

function probeInput(connection: OwnedConnection, handle: OwnedContainerHandle) {
  return {
    kind: "stell22-p1-disposable-target",
    version: 1,
    runId: connection.runId,
    databaseName: connection.databaseName,
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    containerId: connection.containerId,
    containerName: connection.containerName,
    image: handle.imageRef,
    nonce: connection.nonce,
    composeProject: connection.containerName,
    networkName: connection.containerName,
    postgresMajor: 17,
  };
}

function interpretProbe(report: LiveReadReport): OwnedSqlBindingResult | { ok: true } {
  const kind = failureKind(report);
  if (kind) return failure(kind, report.code, report.classification, report.verdict);
  if (report.postgresIdentity.status !== "row-read" || report.postgresIdentity.rowCount !== 1) {
    return failure("sql-identity-missing", report.code, report.classification, report.verdict);
  }
  return { ok: true };
}

function failureKind(report: LiveReadReport): BindingFailureKind | null {
  if (report.code === "CONNECTION_UNAVAILABLE") return "connection-unavailable";
  if (
    report.code === "TRANSACTION_INIT_FAILED" ||
    report.code === "SESSION_PROTECTION_FAILED" ||
    report.code === "CONNECTION_CONTINUITY_FAILED" ||
    report.code === "SNAPSHOT_NOT_PROVEN"
  ) {
    return "session-continuity-failure";
  }
  if (report.code === "MISSING_IDENTITY_TABLE" || report.code === "MISSING_DISPOSABLE_IDENTITY") {
    return "sql-identity-missing";
  }
  if (
    report.code === "WRONG_DATABASE_IDENTITY" ||
    report.code === "DUPLICATE_IDENTITY_ROW" ||
    report.code === "DISPOSABLE_NONCE_MISMATCH" ||
    report.code === "DISPOSABLE_IDENTITY_MISMATCH"
  ) {
    return "sql-identity-mismatch";
  }
  if (report.failedQuery === "identity") return "sql-identity-missing";
  if (report.failedQuery === "session") return "session-continuity-failure";
  return null;
}

function dockerFailure(
  error: unknown,
  classification: Classification | null = null,
  verdict: RunnerVerdict | "NOT_RUN" = "NOT_RUN",
): OwnedSqlBindingResult {
  if (error instanceof ContainerOriginRefusal && DRIFT_CODES.has(error.code)) {
    return failure("docker-identity-drift", error.code, classification, verdict);
  }
  const code = error instanceof ContainerOriginRefusal ? error.code : "OWNERSHIP_UNPROVEN";
  return failure("ownership-not-confirmed", code, classification, verdict);
}

function failure(
  kind: BindingFailureKind,
  code: string,
  classification: Classification | null,
  verdict: RunnerVerdict | "NOT_RUN" = "NOT_RUN",
): OwnedSqlBindingResult {
  return {
    ok: false,
    kind,
    code,
    message: FAILURE_TEXT[kind],
    classification,
    publicAuthorization: authorization(verdict, code),
  };
}

function authorization(verdict: RunnerVerdict | "NOT_RUN", code: string): PublicProbeAuthorization {
  return {
    containerOrigin: "NOT_ESTABLISHED",
    fullTargetAuthentication: "NOT_CLAIMED",
    applyEnabled: false,
    verdict,
    code,
  };
}
