import { describe, expect, it } from "vitest";
import { COORDINATOR_ROLES, type WriterRow } from "@/server/internal/p1-write-freeze-coordinator/contract";
import { classifyInventory } from "@/server/internal/p1-write-freeze-coordinator/writers";

function row(name: string, patch: Partial<WriterRow> = {}): WriterRow {
  return {
    name,
    superuser: false,
    createdb: false,
    createrole: false,
    replication: false,
    bypassrls: false,
    canlogin: true,
    inherit: true,
    memberships: [],
    setRoles: [],
    databaseCreate: false,
    schemaCreate: false,
    databaseOwner: false,
    tableWrite: false,
    columnWrite: false,
    sequenceMutation: false,
    securityDefinerExecute: false,
    sessions: 0,
    transactions: 0,
    ...patch,
  };
}

function catalog(patch: Partial<WriterRow> = {}): WriterRow[] {
  return [
    row(COORDINATOR_ROLES.application, patch),
    row(COORDINATOR_ROLES.migrator, { databaseOwner: true }),
    row(COORDINATOR_ROLES.breakglass, { superuser: true }),
    row(COORDINATOR_ROLES.bootstrap, { superuser: true }),
    row("PUBLIC", { canlogin: false }),
  ];
}

describe("writer inventory", () => {
  it("allows ordinary application DML before the freeze and records the superuser limit", () => {
    const inventory = classifyInventory(catalog({ tableWrite: true, sequenceMutation: true }), COORDINATOR_ROLES, "before");
    expect(inventory.ok).toBe(true);
    expect(inventory.freezeCoverage).toBe("APPLICATION_ROLE_ONLY");
    expect(inventory.superuserWriteStillPossible).toBe(true);
    expect(inventory.migratorRetainsOwnershipWrite).toBe(true);
  });

  it("blocks a verified freeze while the application, PUBLIC, or an unknown role can write", () => {
    expect(classifyInventory(catalog({ tableWrite: true }), COORDINATOR_ROLES, "after").problems).toContain("APP_WRITE");
    expect(classifyInventory(catalog(), COORDINATOR_ROLES, "after").ok).toBe(true);
    const pub = catalog();
    pub[4] = row("PUBLIC", { canlogin: false, columnWrite: true });
    expect(classifyInventory(pub, COORDINATOR_ROLES, "after").problems).toContain("PUBLIC_WRITE");
    const foreign = [...catalog(), row("intruder", { canlogin: true, tableWrite: true })];
    expect(classifyInventory(foreign, COORDINATOR_ROLES, "before").problems).toContain("UNKNOWN_WRITER");
  });

  it("treats application elevation, membership, DDL, and a privileged session as blockers", () => {
    expect(classifyInventory(catalog({ superuser: true }), COORDINATOR_ROLES, "before").problems).toContain("APP_ELEVATED");
    expect(classifyInventory(catalog({ memberships: ["p1wc_migrator"] }), COORDINATOR_ROLES, "after").problems).toContain(
      "FOREIGN_MEMBERSHIP",
    );
    expect(classifyInventory(catalog({ schemaCreate: true, databaseCreate: true }), COORDINATOR_ROLES, "after").problems).toContain(
      "DDL_LEAK",
    );
    expect(classifyInventory(catalog({ securityDefinerExecute: true }), COORDINATOR_ROLES, "after").problems).toContain(
      "SECURITY_DEFINER",
    );
    const session = catalog();
    session[3] = row(COORDINATOR_ROLES.bootstrap, { superuser: true, sessions: 1, transactions: 1 });
    expect(classifyInventory(session, COORDINATOR_ROLES, "after").ok).toBe(false);
    expect(classifyInventory(session, COORDINATOR_ROLES, "after").superuserWriteStillPossible).toBe(true);
  });
});
