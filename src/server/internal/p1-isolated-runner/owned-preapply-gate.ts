import type { Classification } from "@/server/internal/p1-isolated-runner/classify";
import {
  bindOwnedDisposableSql,
  type OwnedSqlBindingDependencies,
  type OwnedSqlBindingKind,
  type OwnedSqlBindingResult,
  type PublicProbeAuthorization,
} from "@/server/internal/p1-isolated-runner/owned-sql-binding";
import type { OwnedContainerHandle } from "@/server/internal/p1-isolated-runner/container-origin";

/**
 * Stage C read-only pre-apply diagnostic.
 * It calls the Stage B binding and classifies that result.
 * It does not accept an outside SQL report, and it does not authorize
 * Prisma, apply, or a production migration.
 */

export type OwnedPreapplyDiagnostic =
  | {
      readonly status: "refused";
      readonly reason: "binding" | "not-live-proof" | "uncertain";
      readonly bindingKind: OwnedSqlBindingKind | "absent";
      readonly code: string;
      readonly message: string;
      readonly classification: Classification | null;
      readonly executionAuthorized: false;
      readonly publicAuthorization: PublicProbeAuthorization;
    }
  | {
      readonly status: "not-ready";
      readonly structuralVerdict: "STOP" | "BLOCKED";
      readonly code: string;
      readonly message: string;
      readonly classification: Classification;
      readonly executionAuthorized: false;
      readonly publicAuthorization: PublicProbeAuthorization;
    }
  | {
      readonly status: "already-applied";
      readonly code: "P1_APPLIED";
      readonly message: string;
      readonly classification: Classification;
      readonly executionAuthorized: false;
      readonly repeatMigrationAuthorized: false;
      readonly publicAuthorization: PublicProbeAuthorization;
    }
  | {
      readonly status: "diagnostic-ready";
      readonly code: "P1_ABSENT";
      readonly message: string;
      readonly classification: Classification;
      readonly executionAuthorized: false;
      readonly prismaExecutionAuthorized: false;
      readonly publicAuthorization: PublicProbeAuthorization;
    };

const TEXT = {
  binding: "Owned SQL binding was refused.",
  "not-live-proof": "Injected SQL rows are not live PostgreSQL evidence.",
  uncertain: "Owned SQL evidence is not sufficient for a diagnostic result.",
  STOP: "Structural classification stops a future disposable run.",
  BLOCKED: "Structural classification blocks a future disposable run.",
  "already-applied":
    "P1 objects are already present. This diagnostic does not authorize another run.",
  "diagnostic-ready":
    "Disposable P1 objects are absent after a verified read-only binding. This diagnostic does not authorize execution.",
} as const;

export async function assessOwnedDisposablePreapply(
  handle: OwnedContainerHandle,
  dependencies: OwnedSqlBindingDependencies = {},
): Promise<OwnedPreapplyDiagnostic> {
  return diagnose(await bindOwnedDisposableSql(handle, dependencies));
}

function diagnose(binding: OwnedSqlBindingResult): OwnedPreapplyDiagnostic {
  const publicAuthorization = seal(binding);
  if (!binding.ok) {
    return {
      status: "refused",
      reason: binding.kind === "injected-not-live-proof" ? "not-live-proof" : "binding",
      bindingKind: binding.kind,
      code: binding.code,
      message: binding.kind === "injected-not-live-proof" ? TEXT["not-live-proof"] : TEXT.binding,
      classification: binding.classification,
      executionAuthorized: false,
      publicAuthorization,
    };
  }
  if (binding.evidenceSource !== "postgresql-query" || binding.classification === null) {
    return {
      status: "refused",
      reason: "uncertain",
      bindingKind: binding.kind,
      code: "SQL_EVIDENCE_UNCERTAIN",
      message: TEXT.uncertain,
      classification: binding.classification,
      executionAuthorized: false,
      publicAuthorization,
    };
  }
  const classification = binding.classification;
  if (classification.verdict === "STOP" || classification.verdict === "BLOCKED") {
    return {
      status: "not-ready",
      structuralVerdict: classification.verdict,
      code: classification.code,
      message: TEXT[classification.verdict],
      classification,
      executionAuthorized: false,
      publicAuthorization,
    };
  }
  if (classification.verdict === "ALREADY_APPLIED" && classification.code === "P1_APPLIED") {
    return {
      status: "already-applied",
      code: "P1_APPLIED",
      message: TEXT["already-applied"],
      classification,
      executionAuthorized: false,
      repeatMigrationAuthorized: false,
      publicAuthorization,
    };
  }
  if (
    classification.verdict === "READY_FOR_DISPOSABLE_APPLY" &&
    classification.code === "P1_ABSENT"
  ) {
    return {
      status: "diagnostic-ready",
      code: "P1_ABSENT",
      message: TEXT["diagnostic-ready"],
      classification,
      executionAuthorized: false,
      prismaExecutionAuthorized: false,
      publicAuthorization,
    };
  }
  return {
    status: "refused",
    reason: "uncertain",
    bindingKind: binding.kind,
    code: "SQL_EVIDENCE_UNCERTAIN",
    message: TEXT.uncertain,
    classification,
    executionAuthorized: false,
    publicAuthorization,
  };
}

function seal(binding: OwnedSqlBindingResult): PublicProbeAuthorization {
  return {
    containerOrigin: "NOT_ESTABLISHED",
    fullTargetAuthentication: "NOT_CLAIMED",
    applyEnabled: false,
    verdict: binding.publicAuthorization.verdict,
    code: binding.publicAuthorization.code,
  };
}
