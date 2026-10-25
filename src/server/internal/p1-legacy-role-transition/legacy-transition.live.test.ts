import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { confirmOwnedContainer, formatReleaseReport, releaseAppOnly, type AppOnlyRelease } from "@/server/internal/p1-app-only-startup/cleanup";
import { realWorld } from "@/server/internal/p1-write-freeze-historical/runtime";
import { defaultOriginRuntime, resolveLocalDockerEndpoint } from "@/server/internal/p1-isolated-runner/container-origin";
import { P1_GIT_BLOB, P1_MIGRATION_NAME, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { materializeHistorical } from "@/server/internal/p1-isolated-runner/disposable-migration-harness";
import { copyMigrationsAfterPinnedP1 } from "@/server/internal/p1-isolated-runner/later-migrations";
import { evaluateMigratorPrivileges, migratorPrivilegeSql, parseMigratorPrivilegeReport } from "@/server/internal/p1-production-adapter/migrator-privilege";
import { DISPOSABLE_APP_ROLE, MIGRATOR_ROLE } from "@/server/internal/p1-role-split-disposable/topology";
import {
  LEGACY_ADMIN_ROLE,
  planLegacyTransition,
  verifyAdminPreserved,
  verifyAppRestrictions,
  verifyTransferredOwnership,
  type CatalogHistoryRow,
  type CatalogRelation,
  type CatalogRoutine,
} from "@/server/internal/p1-legacy-role-transition/plan";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const LABEL = "stell22.p1.legacy-transition";

describe.skipIf(!LIVE)("legacy stell22 ownership transition", () => {
  it(
    "moves a 45-migration stell22 schema to the restricted roles and applies pinned P1",
    () => {
      const runId = randomBytes(4).toString("hex");
      const adminPassword = randomBytes(16).toString("hex");
      const appPassword = randomBytes(16).toString("hex");
      const migratorPassword = randomBytes(16).toString("hex");
      const sessionSecret = randomBytes(24).toString("hex");
      const databaseName = `p1as_${runId}`;
      expect(databaseName).toMatch(/^p1as_[0-9a-f]{8}$/);
      expect(databaseName).not.toBe("stell22");
      const names = {
        db: `p1as-ltdb-${runId}`,
        app: `p1as-ltapp-${runId}`,
        network: `p1as-net-lt${runId}`,
        volume: `p1as-vol-lt${runId}`,
        image: `p1as-app:lt${runId}`,
      };
      for (const name of Object.values(names)) {
        expect(name).not.toMatch(/stell22-db-prod|stell22-app|stell22-caddy|stell22-db$/);
      }
      const secrets = [adminPassword, appPassword, migratorPassword, sessionSecret];
      const daemonAtStart = daemonId();
      const endpointAtStart = resolveLocalDockerEndpoint(defaultOriginRuntime());
      let dbId = "";
      let appId = "";
      let dbImage = "";
      let appImage = "";
      let networkId = "";
      let volumeMount = "";
      let migrationRoot = "";
      let releaseError: Error | null = null;
      const releaseInput = (): AppOnlyRelease => ({
        binding: { endpoint: endpointAtStart, daemonId: daemonAtStart, runId },
        labelKey: LABEL,
        database: /^[0-9a-f]{64}$/.test(dbId) && dbImage.startsWith("sha256:") ? { id: dbId, name: names.db, imageId: dbImage } : null,
        application: /^[0-9a-f]{64}$/.test(appId) && appImage.startsWith("sha256:") ? { id: appId, name: names.app, imageId: appImage } : null,
        volume: volumeMount.length > 0 ? { name: names.volume, mountpoint: volumeMount } : null,
        network: /^[0-9a-f]{64}$/.test(networkId) ? { id: networkId, name: names.network } : null,
        image: appImage.startsWith("sha256:") ? { tag: names.image, id: appImage } : null,
      });
      try {
        ensurePostgresImage();
        docker(["build", "-f", "Dockerfile", "-t", names.image, "."], secrets);
        appImage = docker(["image", "inspect", "--format", "{{.Id}}", names.image], secrets);
        expect(docker(["image", "inspect", "--format", "{{json .Config.Entrypoint}}", names.image], secrets)).toBe('["./docker-entrypoint-app-only.sh"]');
        networkId = docker(["network", "create", "--label", `${LABEL}=${runId}`, names.network], secrets);
        expect(docker(["volume", "create", "--label", `${LABEL}=${runId}`, names.volume], secrets)).toBe(names.volume);
        volumeMount = docker(["volume", "inspect", "--format", "{{.Mountpoint}}", names.volume], secrets);
        dbId = docker([
          "run", "-d", "--pull", "never", "--restart", "no", "--name", names.db,
          "--network", names.network, "--network-alias", "db",
          "--label", `${LABEL}=${runId}`,
          "--mount", `type=volume,source=${names.volume},target=/var/lib/postgresql/data`,
          "-e", `POSTGRES_USER=${LEGACY_ADMIN_ROLE}`, "-e", `POSTGRES_PASSWORD=${adminPassword}`, "-e", `POSTGRES_DB=${databaseName}`,
          "postgres:17-alpine",
        ], secrets);
        dbImage = docker(["inspect", "--format", "{{.Image}}", dbId], secrets);
        const published = docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", dbId], secrets);
        expect(published.includes("HostPort")).toBe(false);
        waitReady(names.db, databaseName, secrets);
        const version = psql(names.db, databaseName, LEGACY_ADMIN_ROLE, "SELECT current_setting('server_version_num')", secrets);
        expect(version.startsWith("17")).toBe(true);
        migrationRoot = path.join(process.cwd(), `.p1lt-migrate-${runId}`);
        materializeHistorical(migrationRoot);
        migrate(names.network, names.image, `p1as-lthist-${runId}`, runId, roleUrl(LEGACY_ADMIN_ROLE, adminPassword, databaseName), migrationRoot, secrets);
        const before = readCatalog(names.db, databaseName, secrets);
        expect(before.history).toHaveLength(45);
        expect(before.history.some((row) => row.migrationName === P1_MIGRATION_NAME)).toBe(false);
        expect(before.relations.find((relation) => relation.name === "BatchCreationCommand")?.owner).toBe(LEGACY_ADMIN_ROLE);
        expect(before.relations.find((relation) => relation.name === "_prisma_migrations")?.owner).toBe(LEGACY_ADMIN_ROLE);
        const unexpectedKinds = psql(names.db, databaseName, LEGACY_ADMIN_ROLE, "SELECT COALESCE(string_agg(DISTINCT c.relkind::text, ','), '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind::text NOT IN ('r','p','S','v','m','i','I','t')", secrets);
        if (unexpectedKinds.length > 0) throw new Error(`UNEXPECTED_RELATION_KIND ${unexpectedKinds}`);
        const unexpectedRoutines = psql(names.db, databaseName, LEGACY_ADMIN_ROLE, "SELECT COALESCE(string_agg(DISTINCT p.prokind::text, ','), '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind::text <> 'f'", secrets);
        if (unexpectedRoutines.length > 0) throw new Error(`UNEXPECTED_ROUTINE_KIND ${unexpectedRoutines}`);
        const plan = planLegacyTransition({ catalog: before, appPassword, migratorPassword, p1Checksum: P1_SHA256 });
        if (!plan.ok) throw new Error(plan.code);
        expect(plan.sql.toUpperCase()).not.toContain("REASSIGN OWNED");
        psql(names.db, databaseName, LEGACY_ADMIN_ROLE, plan.sql, secrets);
        const ownership = verifyTransferredOwnership({ inventory: plan.inventory, owners: ownerMap(names.db, databaseName, secrets) });
        if (!ownership.ok) throw new Error(ownership.code);
        const restrictions = verifyAppRestrictions(readAppRestrictions(names.db, databaseName, secrets));
        if (!restrictions.ok) throw new Error(restrictions.code);
        const admin = verifyAdminPreserved({
          superuser: psql(names.db, databaseName, LEGACY_ADMIN_ROLE, "SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user", secrets) === "true",
          login: psql(names.db, databaseName, LEGACY_ADMIN_ROLE, "SELECT rolcanlogin::text FROM pg_roles WHERE rolname = 'stell22'", secrets) === "true",
        });
        if (!admin.ok) throw new Error(admin.code);
        psql(names.db, databaseName, LEGACY_ADMIN_ROLE, "CREATE TABLE public.p1lt_admin_probe (id integer); DROP TABLE public.p1lt_admin_probe", secrets);
        const privilege = evaluateMigratorPrivileges(parseMigratorPrivilegeReport(JSON.parse(psql(names.db, databaseName, MIGRATOR_ROLE, migratorPrivilegeSql(), secrets))), {
          migratorRole: MIGRATOR_ROLE,
          bootstrapRole: LEGACY_ADMIN_ROLE,
        });
        if (!privilege.ok) throw new Error(privilege.code);
        const p1Source = pinnedP1Bytes();
        const p1Directory = path.join(migrationRoot, "prisma", "migrations", P1_MIGRATION_NAME);
        fs.mkdirSync(p1Directory);
        fs.writeFileSync(path.join(p1Directory, "migration.sql"), p1Source);
        const historyBeforeP1 = historyMarker(names.db, databaseName, secrets);
        migrate(names.network, names.image, `p1as-ltp1-${runId}`, runId, roleUrl(MIGRATOR_ROLE, migratorPassword, databaseName), migrationRoot, secrets);
        const p1Row = p1Marker(names.db, databaseName, secrets);
        expect(p1Row.startsWith(`${P1_MIGRATION_NAME}|${P1_SHA256}|`)).toBe(true);
        expect(p1Row.endsWith("|1")).toBe(true);
        expect(historyMarker(names.db, databaseName, secrets)).not.toBe(historyBeforeP1);
        if (copyMigrationsAfterPinnedP1(migrationRoot) > 0) {
          migrate(names.network, names.image, `p1as-ltlater-${runId}`, runId, roleUrl(MIGRATOR_ROLE, migratorPassword, databaseName), migrationRoot, secrets);
        }
        expect(psql(names.db, databaseName, LEGACY_ADMIN_ROLE, `SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'batch_creation_command_provenance_guard'`, secrets)).toBe(MIGRATOR_ROLE);
        const appliedHistory = historyMarker(names.db, databaseName, secrets);
        const refusedId = startApp(names.network, names.image, `p1as-ltsuper-${runId}`, runId, roleUrl(LEGACY_ADMIN_ROLE, adminPassword, databaseName), randomBytes(24).toString("hex"), secrets);
        const refused = waitExit(refusedId, secrets);
        expect(refused.code).not.toBe("0");
        expect(containerLogs(refusedId, secrets)).toContain("APP_ONLY_STARTUP BOOTSTRAP_SUPERUSER");
        expect(historyMarker(names.db, databaseName, secrets)).toBe(appliedHistory);
        removeIfOwned(releaseInput, { id: refusedId, name: `p1as-ltsuper-${runId}` }, appImage);
        appId = startApp(names.network, names.image, names.app, runId, roleUrl(DISPOSABLE_APP_ROLE, appPassword, databaseName), sessionSecret, secrets);
        const appLogin = docker(["exec", appId, "node", "-e", "const u=new URL(process.env.DATABASE_URL||''); if(!u.username) process.exit(2); process.stdout.write(u.username)"], secrets);
        expect(appLogin).toBe(DISPOSABLE_APP_ROLE);
        waitHealth(names.app, secrets);
        expect(containerLogs(names.app, secrets)).not.toMatch(/prisma\s+migrate\s+deploy|Applying migration/);
        expect(historyMarker(names.db, databaseName, secrets)).toBe(appliedHistory);
        runBusinessDml(names.network, names.image, `p1as-ltdml-${runId}`, runId, roleUrl(DISPOSABLE_APP_ROLE, appPassword, databaseName), runId, secrets);
        expect(psql(names.db, databaseName, LEGACY_ADMIN_ROLE, `SELECT count(*)::text FROM public."Setting" WHERE key = 'p1lt_${runId}'`, secrets)).toBe("0");
        docker(["restart", appId], secrets);
        waitHealth(names.app, secrets);
        expect(historyMarker(names.db, databaseName, secrets)).toBe(appliedHistory);
        expect(p1Marker(names.db, databaseName, secrets)).toBe(p1Row);
        expect(containerLogs(names.app, secrets)).not.toMatch(/prisma\s+migrate\s+deploy|Applying migration/);
        psql(names.db, databaseName, MIGRATOR_ROLE, "CREATE SEQUENCE public.p1lt_probe_seq", secrets);
        expect(psql(names.db, databaseName, DISPOSABLE_APP_ROLE, "SELECT nextval('public.p1lt_probe_seq')::text", secrets)).toBe("1");
        psql(names.db, databaseName, MIGRATOR_ROLE, "DROP SEQUENCE public.p1lt_probe_seq", secrets);
        expect(psql(names.db, databaseName, LEGACY_ADMIN_ROLE, "SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user", secrets)).toBe("true");
        process.stderr.write(`EVIDENCE pg=${version} dbId=${dbId} dbImage=${dbImage} appImage=${appImage} inventory=${plan.inventory.length} historyBefore=45 p1=${p1Row} adminStillSuperuser=yes\n`);
        if (daemonId() !== daemonAtStart) throw new Error("daemon changed before cleanup");
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error("legacy transition failed");
        throw error;
      } finally {
        for (const name of [`p1as-lthist-${runId}`, `p1as-ltp1-${runId}`, `p1as-ltdml-${runId}`, `p1as-ltsuper-${runId}`]) {
          const inspected = spawnSync("docker", ["inspect", "--format", "{{.Id}}", name], { encoding: "utf8", timeout: 15_000, windowsHide: true });
          if (inspected.status !== 0) continue;
          removeIfOwned(releaseInput, { id: inspected.stdout.trim(), name }, appImage);
        }
        if (migrationRoot.length > 0) fs.rmSync(migrationRoot, { recursive: true, force: true });
        const report = releaseAppOnly(releaseInput(), realWorld());
        if (releaseError === null && (report.preserved.length > 0 || report.failures.length > 0)) throw new Error(formatReleaseReport(report));
        if (report.preserved.length > 0 || report.failures.length > 0) process.stderr.write(`${formatReleaseReport(report)}\n`);
      }
    },
    1_800_000,
  );
});

function readCatalog(container: string, databaseName: string, secrets: readonly string[]) {
  const schemaOwner = psql(container, databaseName, LEGACY_ADMIN_ROLE, "SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'", secrets);
  const admin = psql(container, databaseName, LEGACY_ADMIN_ROLE, "SELECT rolsuper::text || '|' || rolcanlogin::text FROM pg_roles WHERE rolname = 'stell22'", secrets);
  const [adminSuperuser, adminLogin] = admin.split("|");
  const roles = psql(container, databaseName, LEGACY_ADMIN_ROLE, "SELECT (EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'stell22_app'))::text || '|' || (EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'stell22_migrator'))::text", secrets);
  const [appRoleExists, migratorRoleExists] = roles.split("|");
  const relations = splitLines(psql(container, databaseName, LEGACY_ADMIN_ROLE, "SELECT c.relname || '|' || c.relkind::text || '|' || pg_catalog.pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind::text IN ('r','p','S','v','m') ORDER BY c.relkind::text, c.relname", secrets)).map(parseRelation);
  const routines = splitLines(psql(container, databaseName, LEGACY_ADMIN_ROLE, "SELECT p.proname || '|' || pg_catalog.pg_get_function_identity_arguments(p.oid) || '|' || pg_catalog.pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind::text = 'f' ORDER BY p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)", secrets)).map(parseRoutine);
  const history = splitLines(psql(container, databaseName, LEGACY_ADMIN_ROLE, `SELECT migration_name || '|' || checksum || '|' || COALESCE(finished_at::text, '') || '|' || COALESCE(rolled_back_at::text, '') || '|' || applied_steps_count::text FROM public."_prisma_migrations" ORDER BY migration_name`, secrets)).map(parseHistory);
  return {
    databaseName,
    schemaOwner,
    adminSuperuser: adminSuperuser === "true",
    adminLogin: adminLogin === "true",
    appRoleExists: appRoleExists === "true",
    migratorRoleExists: migratorRoleExists === "true",
    relations,
    routines,
    history,
  };
}

function ownerMap(container: string, databaseName: string, secrets: readonly string[]): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const relation of splitLines(psql(container, databaseName, LEGACY_ADMIN_ROLE, "SELECT c.relname || '|' || c.relkind::text || '|' || pg_catalog.pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind::text IN ('r','p','S','v','m')", secrets)).map(parseRelation)) {
    const kind = relation.kind === "S" ? "sequence" : relation.kind === "v" || relation.kind === "m" ? "view" : "table";
    owners[`${kind}:${relation.name}`] = relation.owner;
  }
  for (const routine of splitLines(psql(container, databaseName, LEGACY_ADMIN_ROLE, "SELECT p.proname || '|' || pg_catalog.pg_get_function_identity_arguments(p.oid) || '|' || pg_catalog.pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind::text = 'f'", secrets)).map(parseRoutine)) {
    owners[`routine:${routine.name}:${routine.identityArguments}`] = routine.owner;
  }
  return owners;
}

function readAppRestrictions(container: string, databaseName: string, secrets: readonly string[]) {
  const values = psql(container, databaseName, LEGACY_ADMIN_ROLE, [
    "SELECT has_schema_privilege('stell22_app', 'public', 'CREATE')::text",
    "|| '|' || pg_has_role('stell22_app', 'stell22_migrator', 'member')::text",
    "|| '|' || has_table_privilege('stell22_app', 'public.\"_prisma_migrations\"', 'SELECT')::text",
    "|| '|' || has_table_privilege('stell22_app', 'public.\"_prisma_migrations\"', 'INSERT')::text",
    "|| '|' || has_table_privilege('stell22_app', 'public.\"_prisma_migrations\"', 'UPDATE')::text",
    "|| '|' || has_table_privilege('stell22_app', 'public.\"_prisma_migrations\"', 'DELETE')::text",
  ].join(" "), secrets).split("|");
  return {
    schemaCreate: values[0] === "true",
    memberOfMigrator: values[1] === "true",
    migrationSelect: values[2] === "true",
    migrationInsert: values[3] === "true",
    migrationUpdate: values[4] === "true",
    migrationDelete: values[5] === "true",
  };
}

function parseRelation(line: string): CatalogRelation {
  const [name, kind, owner] = line.split("|");
  if (!name || !kind || !owner) throw new Error("relation catalog row is incomplete");
  return { name, kind, owner };
}

function parseRoutine(line: string): CatalogRoutine {
  const parts = line.split("|");
  if (parts.length !== 3) throw new Error("routine catalog row is incomplete");
  const [name, identityArguments, owner] = parts;
  if (!name || owner === undefined || identityArguments === undefined) throw new Error("routine catalog row is incomplete");
  return { name, identityArguments, owner };
}

function parseHistory(line: string): CatalogHistoryRow {
  const [migrationName, checksum, finishedAt, rolledBackAt, appliedSteps] = line.split("|");
  if (!migrationName || !checksum || appliedSteps === undefined) throw new Error("history catalog row is incomplete");
  return {
    migrationName,
    checksum,
    finishedAt: finishedAt && finishedAt.length > 0 ? finishedAt : null,
    rolledBackAt: rolledBackAt && rolledBackAt.length > 0 ? rolledBackAt : null,
    appliedStepsCount: Number(appliedSteps),
  };
}

function pinnedP1Bytes(): Buffer {
  const head = spawnSync("git", ["rev-parse", `HEAD:prisma/migrations/${P1_MIGRATION_NAME}/migration.sql`], { encoding: "utf8", windowsHide: true });
  if (head.status !== 0 || head.stdout.trim() !== P1_GIT_BLOB) throw new Error("P1_CHECKSUM_DIFFERS");
  const blob = spawnSync("git", ["cat-file", "blob", P1_GIT_BLOB], { encoding: "buffer", windowsHide: true });
  if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) throw new Error("P1_CHECKSUM_DIFFERS");
  if (createHash("sha256").update(blob.stdout).digest("hex") !== P1_SHA256) throw new Error("P1_CHECKSUM_DIFFERS");
  return blob.stdout;
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function historyMarker(container: string, databaseName: string, secrets: readonly string[]): string {
  return psql(container, databaseName, LEGACY_ADMIN_ROLE, `SELECT migration_name || '|' || checksum || '|' || applied_steps_count::text FROM public."_prisma_migrations" ORDER BY migration_name`, secrets);
}

function p1Marker(container: string, databaseName: string, secrets: readonly string[]): string {
  return psql(container, databaseName, LEGACY_ADMIN_ROLE, `SELECT migration_name || '|' || checksum || '|' || applied_steps_count::text FROM public."_prisma_migrations" WHERE migration_name = '${P1_MIGRATION_NAME}'`, secrets);
}

function migrate(network: string, image: string, name: string, runId: string, databaseUrl: string, migrationRoot: string, secrets: readonly string[]): void {
  const child = spawnSync("docker", [
    "run", "--rm", "--pull", "never", "--network", network, "--label", `${LABEL}=${runId}`, "--name", name,
    "--entrypoint", "npx", "-e", `DATABASE_URL=${databaseUrl}`,
    "--mount", `type=bind,source=${migrationRoot.replace(/\\/g, "/")},target=/fixture,readonly`,
    image, "prisma", "migrate", "deploy", "--schema", "/fixture/prisma/schema.prisma",
  ], { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (child.status !== 0) throw new Error(redact(`migrate ${name} failed: ${(child.stderr || child.stdout).slice(-1500)}`, secrets));
}

function runBusinessDml(network: string, image: string, name: string, runId: string, databaseUrl: string, key: string, secrets: readonly string[]): void {
  const script = [
    'const {PrismaClient}=require("@prisma/client");',
    "const prisma=new PrismaClient();",
    "const key='p1lt_'+process.env.P1LT_KEY;",
    "prisma.$queryRawUnsafe(\"SELECT current_user AS name\").then((rows)=>{",
    "if(!rows[0]||rows[0].name!=='stell22_app') throw new Error('LOGIN');",
    "return prisma.setting.create({data:{key,value:{probe:true}}});",
    "}).then(()=>prisma.setting.findUnique({where:{key}})).then((row)=>{",
    "if(!row) throw new Error('READ_FAILED');",
    "return prisma.setting.update({where:{key},data:{value:{probe:false}}});",
    "}).then(()=>prisma.setting.delete({where:{key}})).then(()=>prisma.setting.findUnique({where:{key}})).then((left)=>{",
    "if(left) throw new Error('DELETE_FAILED');",
    "process.stdout.write('DML ok');",
    "return prisma.$disconnect();",
    "}).catch((error)=>{process.stderr.write(error instanceof Error?error.message:'DML_FAILED'); process.exit(1);});",
  ].join("");
  const child = spawnSync("docker", [
    "run", "--rm", "--pull", "never", "--network", network, "--label", `${LABEL}=${runId}`, "--name", name,
    "--entrypoint", "node", "-e", `DATABASE_URL=${databaseUrl}`, "-e", `P1LT_KEY=${key}`,
    image, "-e", script,
  ], { encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (child.status !== 0 || !child.stdout.includes("DML ok")) {
    throw new Error(redact(`business DML failed: ${(child.stderr || child.stdout).slice(-1500)}`, secrets));
  }
}

function startApp(network: string, image: string, name: string, runId: string, databaseUrl: string, sessionSecret: string, secrets: readonly string[]): string {
  return docker([
    "run", "-d", "--pull", "never", "--restart", "no", "--name", name,
    "--network", network, "--label", `${LABEL}=${runId}`,
    "-e", `DATABASE_URL=${databaseUrl}`, "-e", `SESSION_SECRET=${sessionSecret}`, "-e", "PORT=3000",
    image,
  ], secrets);
}

function ensurePostgresImage(): void {
  const present = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", "postgres:17-alpine"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (present.status === 0 && present.stdout.trim().startsWith("sha256:")) return;
  const pulled = spawnSync("docker", ["pull", "postgres:17-alpine"], { encoding: "utf8", timeout: 300_000, windowsHide: true });
  if (pulled.status !== 0) throw new Error("postgres:17-alpine is not available for the disposable test");
}

function waitReady(container: string, databaseName: string, secrets: readonly string[]): void {
  let last = "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const child = spawnSync("docker", ["exec", container, "psql", "-U", LEGACY_ADMIN_ROLE, "-d", databaseName, "-At", "-c", "SELECT 1"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (child.status === 0 && child.stdout.trim() === "1") return;
    last = redact(`${child.status ?? "null"} ${(child.stderr || child.stdout || "").slice(-300)}`, secrets);
    sleep();
  }
  throw new Error(`disposable database did not become ready: ${last}`);
}

function waitExit(container: string, secrets: readonly string[]): { code: string } {
  let last = "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const state = spawnSync("docker", ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", container], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    last = state.stdout.trim();
    const [status, code] = last.split(" ");
    if (status === "exited") return { code: code ?? "" };
    sleep();
  }
  throw new Error(redact(`container did not exit: ${last}`, secrets));
}

function waitHealth(container: string, secrets: readonly string[]): void {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const child = spawnSync("docker", ["exec", container, "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (child.status === 0) return;
    const state = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", container], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (state.stdout.trim() === "exited") break;
    sleep();
  }
  const logs = spawnSync("docker", ["logs", "--tail", "80", container], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  throw new Error(redact(`health did not return 200: ${(logs.stderr || logs.stdout).slice(-1200)}`, secrets));
}

function psql(container: string, databaseName: string, user: string, sql: string, secrets: readonly string[]): string {
  const child = spawnSync("docker", ["exec", "-i", container, "psql", "-U", user, "-d", databaseName, "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (child.status !== 0) throw new Error(redact((child.stderr || child.stdout || child.error?.message || "").slice(0, 800), secrets));
  return child.stdout.trim();
}

function containerLogs(container: string, secrets: readonly string[]): string {
  const child = spawnSync("docker", ["logs", container], { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (child.status !== 0) throw new Error(redact((child.stderr || child.stdout || "").slice(-500), secrets));
  return `${child.stdout}\n${child.stderr}`;
}

function removeIfOwned(releaseInput: () => AppOnlyRelease, container: { id: string; name: string }, appImage: string): void {
  if (!/^[0-9a-f]{64}$/.test(container.id) || !appImage.startsWith("sha256:")) return;
  const ready = confirmOwnedContainer(releaseInput(), { id: container.id, name: container.name, imageId: appImage }, realWorld());
  if (!ready.ok) {
    process.stderr.write(`PRESERVE ${container.name} ${ready.reason}\n`);
    return;
  }
  spawnSync("docker", ["rm", "-f", container.id], { encoding: "utf8", timeout: 30_000, windowsHide: true });
}

function daemonId(): string {
  return docker(["info", "--format", "{{.ID}}"], []);
}

function docker(args: readonly string[], secrets: readonly string[]): string {
  const child = spawnSync("docker", [...args], { encoding: "utf8", windowsHide: true, timeout: 1_200_000, maxBuffer: 16 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(redact(`${args[0]} failed: ${(child.stderr || child.stdout || child.error?.message || "").slice(-2500)}`, secrets));
  return child.stdout.trim();
}

function roleUrl(role: string, password: string, databaseName: string): string {
  return `postgresql://${role}:${password}@db:5432/${databaseName}?schema=public`;
}

function redact(text: string, secrets: readonly string[]): string {
  let value = text.replace(/postgresql:\/\/[^@\s]+@/g, "postgresql://redacted@").replace(/PASSWORD '[^']*'/g, "PASSWORD 'redacted'");
  for (const secret of secrets) {
    if (secret.length > 0) value = value.split(secret).join("redacted");
  }
  return value;
}

function sleep(): void {
  spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);"], { windowsHide: true });
}
