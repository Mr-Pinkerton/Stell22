/**
 * Locked decision for one production statement-period release.
 * This module does not open a database, migrate, deploy, or restore.
 * A sequence admission is not production authorization and not a freeze pass.
 */
import fs from "node:fs";
import {
  MIGRATION_SHA256,
  evaluateOfflineHistory,
  verifyAppliedHistory,
} from "./decide.mjs";

export const AUTHORIZATION_PHRASE = "OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48";
export const INSPECTION_APP = "stell22-statement-inspect";
export const ENTRYPOINT = "./docker-entrypoint-app-only.sh";
export const MIGRATOR_ROLE = "stell22_migrator";
export const APP_ROLE = "stell22_app";

const SHA = /^[0-9a-f]{40}$/;
const FORBIDDEN_WRITER_PROOFS = new Set(["empty-activity", "environment-flag", "maintenance-declaration"]);

function decision(code) {
  return {
    ok: code === "RELEASE_SEQUENCE_ADMITTED" || code === "POST_RELEASE_VERIFIED",
    code,
    productionAuthorized: false,
    freezePass: false,
    futurePrivilegedWritesProvenImpossible: false,
    emptyActivityProvesFutureExclusion: false,
    databaseRestore: "NO",
    schemaRestore: "NO",
    retryMigration: "NO",
    migrateOnStart: "NO",
    mutationPerformed: "NO",
  };
}

function ownerAdmitted(input) {
  return input?.execute === "1" && input?.authorization === AUTHORIZATION_PHRASE;
}

function shaAdmitted(input) {
  const approved = input?.approvedSha ?? "";
  return SHA.test(approved) && approved === input?.headSha && approved === input?.originMainSha;
}

function migratorAdmitted(migrator) {
  return migrator?.login === MIGRATOR_ROLE && migrator?.superuser === false && migrator?.credentialReady === true;
}

function appRoleExcluded(appRole) {
  return (
    appRole?.login === APP_ROLE &&
    appRole?.canMigrate === false &&
    appRole?.migrationInsert === false &&
    appRole?.insertSqlstate === "42501"
  );
}

function imageAdmitted(image) {
  const entrypoint = image?.entrypoint ?? "";
  return (
    entrypoint.includes(ENTRYPOINT) &&
    !entrypoint.includes("prisma migrate") &&
    !entrypoint.includes("migrate deploy") &&
    image?.migrateOnStart === false &&
    image?.migrationSha256 === MIGRATION_SHA256 &&
    image?.appUser === APP_ROLE
  );
}

function backupAdmitted(backup) {
  return backup?.verified === true && backup?.checksumOk === true && backup?.restorePerformed !== true;
}

function currentWritersExcluded(writers) {
  if (!writers || FORBIDDEN_WRITER_PROOFS.has(writers.proof) || writers.proof !== "app-role-and-inspection") return false;
  if (writers.claimFutureExclusion === true) return false;
  if (writers.appContainerStopped !== true) return false;
  if (writers.backupRunning === true || writers.statementImportRunning === true || writers.migrateProcess === true || writers.conflictingDeploy === true) {
    return false;
  }
  if (writers.inspectionApp !== INSPECTION_APP || !Array.isArray(writers.sessions) || writers.sessions.length === 0) return false;
  let inspection = 0;
  let otherClients = 0;
  for (const session of writers.sessions) {
    if (session?.backendType !== "client backend") continue;
    const inspectionSession = session.user === "stell22" && session.applicationName === INSPECTION_APP;
    if (inspectionSession) inspection += 1;
    else otherClients += 1;
  }
  return inspection === 1 && otherClients === 0;
}

function preMutationGates(input) {
  if (!ownerAdmitted(input)) return "STOP_OWNER_GATE";
  if (!shaAdmitted(input)) return "STOP_SHA";
  const history = evaluateOfflineHistory(input.inventory, input.history);
  if (!history.ok) return history.code;
  if (!migratorAdmitted(input.migrator)) return "STOP_MIGRATOR";
  if (!appRoleExcluded(input.appRole)) return "STOP_APP_ROLE";
  if (!imageAdmitted(input.image)) return "STOP_IMAGE";
  if (!backupAdmitted(input.backup)) return "STOP_BACKUP";
  if (!currentWritersExcluded(input.writers)) return "STOP_WRITER";
  return "RELEASE_SEQUENCE_ADMITTED";
}

export function decideProductionRelease(input) {
  if (input?.phase === "after-attempt") {
    if (!ownerAdmitted(input) || !shaAdmitted(input)) return decision(ownerAdmitted(input) ? "STOP_SHA" : "STOP_OWNER_GATE");
    if (input.attempted !== true || !input.attempt || input.attempt.status !== 0) return decision("FORWARD_RECOVERY");
    const verified = verifyAppliedHistory(input.inventory, input.history);
    if (!verified.ok || !imageAdmitted(input.image) || input.health?.ok !== true || input.health?.appOnly !== true) {
      return decision("FORWARD_RECOVERY");
    }
    return decision("POST_RELEASE_VERIFIED");
  }
  if (input?.attempted === true) return decision("STOP_RETRY");
  return decision(preMutationGates(input));
}

function printDecision(result) {
  process.stdout.write(
    [
      `RESULT=${result.code}`,
      "MUTATION=NO",
      "DATABASE_RESTORE=NO",
      "SCHEMA_RESTORE=NO",
      "RETRY_MIGRATION=NO",
      "FREEZE_PASS=NO",
      "PRODUCTION_AUTHORIZED=NO",
      "FUTURE_PRIVILEGED_WRITES_PROVEN_IMPOSSIBLE=NO",
    ].join("\n") + "\n",
  );
}

function main() {
  if (!ownerAdmitted({
    execute: process.env.STELL22_STATEMENT_RELEASE_EXECUTE,
    authorization: process.env.STELL22_STATEMENT_RELEASE_AUTHORIZATION,
  })) {
    printDecision(decision("STOP_OWNER_GATE"));
    process.exitCode = 1;
    return;
  }
  const file = process.argv[2];
  if (!file) {
    printDecision(decision("STOP_FACTS"));
    process.exitCode = 1;
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    printDecision(decision("STOP_FACTS"));
    process.exitCode = 1;
    return;
  }
  const result = decideProductionRelease({
    ...parsed,
    execute: process.env.STELL22_STATEMENT_RELEASE_EXECUTE,
    authorization: process.env.STELL22_STATEMENT_RELEASE_AUTHORIZATION,
  });
  printDecision(result);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("production.mjs")) {
  main();
}
