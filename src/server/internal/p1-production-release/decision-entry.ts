/**
 * Print one release boundary decision.
 * Facts are a key=value file. This file does not open a database connection.
 */

import { readFileSync } from "node:fs";
import {
  decideAfterCommittedRoleChange,
  decideAppUnhealthy,
  decideImageBuildFailure,
  decideLegacyRestart,
  decideP1Uncertain,
  decideWriterAdmission,
  type ReleaseBoundary,
  type WriterSession,
} from "@/server/internal/p1-production-release/sequence";

const event = process.argv[2];
const factsPath = process.argv[3];
if (!event || !factsPath) {
  process.stdout.write("CODE=STOP_ROLE_TRANSITION\nRESTART_LEGACY=NO\nDATABASE_RESTORE=NO\n");
  process.exit(1);
}

const facts = readFacts(readFileSync(factsPath, "utf8"));
const decision = decide(event, facts);
if (!decision) {
  process.stdout.write("CODE=STOP_ROLE_TRANSITION\nRESTART_LEGACY=NO\nDATABASE_RESTORE=NO\n");
  process.exit(1);
}
process.stdout.write(formatDecision(decision));

function decide(name: string, facts: Facts): ReleaseBoundary | null {
  if (name === "image-build-failed") return decideImageBuildFailure();
  if (name === "legacy-restart") return decideLegacyRestart(facts);
  if (name === "writer-admission") return decideWriterAdmission(facts);
  if (name === "p1-uncertain") return decideP1Uncertain();
  if (name === "app-unhealthy") return decideAppUnhealthy();
  if (name === "after-commit") {
    if (facts.probeCode !== "STOP_WRITER" && facts.probeCode !== "STOP_APP_ROLE" && facts.probeCode !== "STOP_MIGRATOR") return null;
    return decideAfterCommittedRoleChange(facts.probeCode);
  }
  return null;
}

type Facts = {
  roleTransitionCommitted: boolean;
  p1Present: boolean;
  p1MigrationInLegacyImage: boolean;
  rolesAbsent: boolean;
  historyUnchanged: boolean;
  databaseStateKnown: boolean;
  maintenanceDeclared: boolean;
  appRunning: boolean;
  expectAppStopped: boolean;
  backupRunning: boolean;
  statementImportRunning: boolean;
  externalWriterCount: number;
  checkSessions: boolean;
  inspectionApp: string;
  sessions: WriterSession[];
  probeCode: "STOP_WRITER" | "STOP_APP_ROLE" | "STOP_MIGRATOR" | "";
};

function readFacts(text: string): Facts {
  const facts: Facts = {
    roleTransitionCommitted: false,
    p1Present: false,
    p1MigrationInLegacyImage: false,
    rolesAbsent: false,
    historyUnchanged: false,
    databaseStateKnown: false,
    maintenanceDeclared: false,
    appRunning: false,
    expectAppStopped: false,
    backupRunning: false,
    statementImportRunning: false,
    externalWriterCount: 0,
    checkSessions: false,
    inspectionApp: "",
    sessions: [],
    probeCode: "",
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (line.startsWith("session=")) {
      const [user, applicationName, backendType] = line.slice("session=".length).split("|");
      facts.sessions.push({ user: user ?? "", applicationName: applicationName ?? "", backendType: backendType ?? "" });
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (key === "externalWriterCount") facts.externalWriterCount = Number(value);
    if (key === "inspectionApp") facts.inspectionApp = value;
    if (key === "probeCode" && (value === "STOP_WRITER" || value === "STOP_APP_ROLE" || value === "STOP_MIGRATOR")) facts.probeCode = value;
    if (value !== "1" && value !== "0") continue;
    const flag = value === "1";
    if (key === "roleTransitionCommitted") facts.roleTransitionCommitted = flag;
    if (key === "p1Present") facts.p1Present = flag;
    if (key === "p1MigrationInLegacyImage") facts.p1MigrationInLegacyImage = flag;
    if (key === "rolesAbsent") facts.rolesAbsent = flag;
    if (key === "historyUnchanged") facts.historyUnchanged = flag;
    if (key === "databaseStateKnown") facts.databaseStateKnown = flag;
    if (key === "maintenanceDeclared") facts.maintenanceDeclared = flag;
    if (key === "appRunning") facts.appRunning = flag;
    if (key === "expectAppStopped") facts.expectAppStopped = flag;
    if (key === "backupRunning") facts.backupRunning = flag;
    if (key === "statementImportRunning") facts.statementImportRunning = flag;
    if (key === "checkSessions") facts.checkSessions = flag;
  }
  return facts;
}

function formatDecision(decision: ReleaseBoundary): string {
  return [
    `CODE=${decision.code}`,
    `RESTART_LEGACY=${decision.restartLegacy ? "YES" : "NO"}`,
    "DATABASE_RESTORE=NO",
    "SCHEMA_ROLLBACK=NO",
    "RETRY_P1=NO",
    "TERMINATE_SESSIONS=NO",
    "DEMOTE_SUPERUSER=NO",
    "FUTURE_PRIVILEGED_WRITES_PROVEN_IMPOSSIBLE=NO",
    "EMPTY_ACTIVITY_PROVES_FUTURE_EXCLUSION=NO",
    `PRIVILEGED_ROLES_REMAIN=${decision.privilegedRolesRemain.join(",")}`,
    "",
  ].join("\n");
}
