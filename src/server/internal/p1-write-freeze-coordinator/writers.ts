import {
  FREEZE_COVERAGE,
  type Roles,
  type WriterRow,
} from "@/server/internal/p1-write-freeze-coordinator/contract";

export type WriterKind = "APPLICATION" | "MIGRATOR" | "BREAK_GLASS" | "BOOTSTRAP" | "PUBLIC" | "UNKNOWN";

export type WriterFinding = WriterRow & { kind: WriterKind };

export type Inventory = {
  ok: boolean;
  problems: string[];
  findings: WriterFinding[];
  superuserWriteStillPossible: boolean;
  migratorRetainsOwnershipWrite: boolean;
  freezeCoverage: typeof FREEZE_COVERAGE;
};

const BEFORE_BLOCKERS = new Set([
  "UNKNOWN_WRITER",
  "APP_ELEVATED",
  "APP_OWNS_DATABASE",
  "MIGRATOR_ELEVATED",
  "INVENTORY_INCOMPLETE",
  "EXTRA_SUPERUSER",
]);

export function classifyInventory(rows: readonly WriterRow[], roles: Roles, phase: "before" | "after"): Inventory {
  const findings = rows.map((row) => ({ ...row, kind: kindOf(row.name, roles) }));
  const problems: string[] = [];
  for (const row of findings) {
    if (row.kind === "UNKNOWN" && (row.canlogin || row.superuser || row.tableWrite || row.columnWrite)) {
      problems.push("UNKNOWN_WRITER");
    }
    if (row.kind === "APPLICATION") problems.push(...applicationProblems(row));
    if (row.kind === "PUBLIC" && writes(row)) problems.push("PUBLIC_WRITE");
    if (row.kind === "BOOTSTRAP" && (row.sessions > 0 || row.transactions > 0)) problems.push("PRIVILEGED_SESSION");
    if (row.kind === "BREAK_GLASS" && (row.sessions > 0 || row.transactions > 0)) problems.push("PRIVILEGED_SESSION");
    if (row.kind === "MIGRATOR") {
      if (row.superuser || row.bypassrls || row.createdb || row.createrole) problems.push("MIGRATOR_ELEVATED");
      if (row.sessions > 0 || row.transactions > 0) problems.push("MIGRATOR_SESSION");
    }
    if (row.superuser && row.kind === "UNKNOWN") problems.push("EXTRA_SUPERUSER");
  }
  for (const name of [roles.application, roles.migrator, roles.breakglass, roles.bootstrap, "PUBLIC"]) {
    if (!findings.some((row) => row.name === name)) problems.push("INVENTORY_INCOMPLETE");
  }
  const unique = [...new Set(problems)];
  const visible = phase === "before" ? unique.filter((code) => BEFORE_BLOCKERS.has(code)) : unique;
  return {
    ok: visible.length === 0,
    problems: visible,
    findings,
    superuserWriteStillPossible: findings.some((row) => row.superuser),
    migratorRetainsOwnershipWrite: findings.some((row) => row.kind === "MIGRATOR"),
    freezeCoverage: FREEZE_COVERAGE,
  };
}

function applicationProblems(row: WriterFinding): string[] {
  const problems: string[] = [];
  if (row.superuser || row.bypassrls || row.createdb || row.createrole || row.replication) problems.push("APP_ELEVATED");
  if (row.memberships.length > 0 || row.setRoles.length > 0) problems.push("FOREIGN_MEMBERSHIP");
  if (row.databaseOwner) problems.push("APP_OWNS_DATABASE");
  if (row.tableWrite || row.columnWrite || row.sequenceMutation) problems.push("APP_WRITE");
  if (row.schemaCreate || row.databaseCreate) problems.push("DDL_LEAK");
  if (row.securityDefinerExecute) problems.push("SECURITY_DEFINER");
  if (row.sessions > 0 || row.transactions > 0) problems.push("APP_SESSION");
  return problems;
}

function writes(row: WriterRow): boolean {
  return row.tableWrite || row.columnWrite || row.sequenceMutation || row.schemaCreate || row.databaseCreate;
}

function kindOf(name: string, roles: Roles): WriterKind {
  if (name === roles.application) return "APPLICATION";
  if (name === roles.migrator) return "MIGRATOR";
  if (name === roles.breakglass) return "BREAK_GLASS";
  if (name === roles.bootstrap) return "BOOTSTRAP";
  if (name === "PUBLIC") return "PUBLIC";
  return "UNKNOWN";
}
