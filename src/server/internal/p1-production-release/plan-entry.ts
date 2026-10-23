/**
 * Read a catalog file and print the production-candidate role SQL.
 * Passwords come from the environment and are not written to argv.
 * This file does not open a database connection.
 */

import { readFileSync } from "node:fs";
import { planLegacyTransition, type CatalogHistoryRow, type CatalogRelation, type CatalogRoutine, type LegacyCatalog } from "@/server/internal/p1-legacy-role-transition/plan";
import { P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";

const catalogPath = process.argv[2];
if (!catalogPath) {
  process.stdout.write("RESULT=STOP_LOCKED\n");
  process.exit(1);
}

const plan = planLegacyTransition({
  catalog: readCatalog(readFileSync(catalogPath, "utf8")),
  appPassword: process.env.APP_DB_PASSWORD ?? "",
  migratorPassword: process.env.MIGRATOR_DB_PASSWORD ?? "",
  p1Checksum: P1_SHA256,
  databasePolicy: "production-candidate",
});

if (!plan.ok) {
  process.stdout.write(`RESULT=${plan.code}\n`);
  process.exit(1);
}

process.stdout.write(plan.sql);

function readCatalog(text: string): LegacyCatalog {
  let databaseName = "";
  let schemaOwner = "";
  let adminSuperuser = false;
  let adminLogin = false;
  let appRoleExists = false;
  let migratorRoleExists = false;
  const relations: CatalogRelation[] = [];
  const routines: CatalogRoutine[] = [];
  const history: CatalogHistoryRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const [kind, payload = ""] = splitOnce(line);
    if (kind === "database") databaseName = payload;
    if (kind === "schemaOwner") schemaOwner = payload;
    if (kind === "admin") {
      const [superuser, login] = payload.split("|");
      adminSuperuser = superuser === "true";
      adminLogin = login === "true";
    }
    if (kind === "roles") {
      const [app, migrator] = payload.split("|");
      appRoleExists = app === "true";
      migratorRoleExists = migrator === "true";
    }
    if (kind === "relation") {
      const [name, relationKind, owner] = payload.split("|");
      if (!name || !relationKind || !owner) throw new Error("relation catalog row is incomplete");
      relations.push({ name, kind: relationKind, owner });
    }
    if (kind === "routine") {
      const [name, identityArguments, owner] = payload.split("|");
      if (!name || identityArguments === undefined || !owner) throw new Error("routine catalog row is incomplete");
      routines.push({ name, identityArguments, owner });
    }
    if (kind === "history") {
      const [migrationName, checksum, finishedAt, rolledBackAt, appliedSteps] = payload.split("|");
      if (!migrationName || !checksum || appliedSteps === undefined) throw new Error("history catalog row is incomplete");
      history.push({
        migrationName,
        checksum,
        finishedAt: finishedAt && finishedAt.length > 0 ? finishedAt : null,
        rolledBackAt: rolledBackAt && rolledBackAt.length > 0 ? rolledBackAt : null,
        appliedStepsCount: Number(appliedSteps),
      });
    }
  }
  return { databaseName, schemaOwner, adminSuperuser, adminLogin, appRoleExists, migratorRoleExists, relations, routines, history };
}

function splitOnce(line: string): [string, string] {
  const index = line.indexOf(" ");
  if (index === -1) return [line, ""];
  return [line.slice(0, index), line.slice(index + 1)];
}
