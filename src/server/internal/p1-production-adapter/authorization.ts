import { ATTEMPT_ID, SHA256, type AdapterScope } from "@/server/internal/p1-production-adapter/contract";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";

/**
 * Explicit owner authorization.
 * A boolean, a CLI flag, or the word AUTHORIZED is not this object.
 * The adapter does not mint a production authorization.
 */

export type OwnerAuthorization = {
  kind: "OWNER_AUTHORIZATION";
  scope: AdapterScope;
  decision: "AUTHORIZE_P1_ONLY_APPLY";
  attemptId: string;
  dossierSha256: string;
  recoverySha256: string;
  daemonId: string;
};

const SHORTCUT_KEYS = new Set([
  "authorized",
  "allowProduction",
  "force",
  "yes",
  "approve",
  "bypass",
]);

export function verifyExplicitAuthorization(
  value: unknown,
  expected: {
    scope: AdapterScope;
    attemptId: string;
    dossierSha256: string;
    recoverySha256: string;
    daemonId: string;
  },
): OwnerAuthorization {
  if (typeof value === "boolean" || typeof value === "string" || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal("STOP", "AUTHORIZATION_REQUIRED", "Production apply has no independent owner authorization");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => SHORTCUT_KEYS.has(key))) {
    throw refusal("STOP", "SHORTCUT_AUTHORIZATION", "A flag cannot authorize production apply");
  }
  if (record.kind !== "OWNER_AUTHORIZATION" || record.decision !== "AUTHORIZE_P1_ONLY_APPLY") {
    throw refusal("STOP", "AUTHORIZATION_REQUIRED", "Owner authorization is not an explicit P1-only decision");
  }
  if (record.scope !== expected.scope || record.attemptId !== expected.attemptId) {
    throw refusal("STOP", "AUTHORIZATION_MISMATCH", "Owner authorization is for a different target");
  }
  if (
    typeof record.dossierSha256 !== "string" ||
    typeof record.recoverySha256 !== "string" ||
    typeof record.daemonId !== "string" ||
    !ATTEMPT_ID.test(record.attemptId as string) ||
    !SHA256.test(record.dossierSha256) ||
    !SHA256.test(record.recoverySha256)
  ) {
    throw refusal("STOP", "AUTHORIZATION_MISMATCH", "Owner authorization is not bound to the dossier");
  }
  if (
    record.dossierSha256 !== expected.dossierSha256 ||
    record.recoverySha256 !== expected.recoverySha256 ||
    record.daemonId !== expected.daemonId
  ) {
    throw refusal("STOP", "AUTHORIZATION_MISMATCH", "Owner authorization does not match the live target");
  }
  return record as OwnerAuthorization;
}
