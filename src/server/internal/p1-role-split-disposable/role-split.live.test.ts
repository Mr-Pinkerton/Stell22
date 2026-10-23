import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { confirmOwnedContainer, formatReleaseReport, releaseAppOnly, type AppOnlyRelease } from "@/server/internal/p1-app-only-startup/cleanup";
import { realWorld } from "@/server/internal/p1-write-freeze-historical/runtime";
import { defaultOriginRuntime, resolveLocalDockerEndpoint } from "@/server/internal/p1-isolated-runner/container-origin";
import { P1_MIGRATION_NAME, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { evaluateMigratorPrivileges, migratorPrivilegeSql, parseMigratorPrivilegeReport } from "@/server/internal/p1-production-adapter/migrator-privilege";
import {
  DISPOSABLE_ADMIN_ROLE,
  DISPOSABLE_APP_ROLE,
  MIGRATOR_ROLE,
  migrationHistoryPrivilegesSql,
  roleTopologySql,
} from "@/server/internal/p1-role-split-disposable/topology";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const LABEL = "stell22.p1.role-split";

describe.skipIf(!LIVE)("disposable application and migrator role split", () => {
  it(
    "starts the app-only image as stell22_app after the migrator applies pinned P1",
    () => {
      const runId = randomBytes(4).toString("hex");
      const adminPassword = randomBytes(16).toString("hex");
      const appPassword = randomBytes(16).toString("hex");
      const migratorPassword = randomBytes(16).toString("hex");
      const sessionSecret = randomBytes(24).toString("hex");
      for (const secret of [adminPassword, appPassword, migratorPassword, sessionSecret]) expect(secret).toMatch(/^[0-9a-f]+$/);
      expect(appPassword).not.toBe(migratorPassword);
      const databaseName = `p1as_${runId}`;
      expect(databaseName).toMatch(/^p1as_[0-9a-f]{8}$/);
      expect(databaseName).not.toBe("stell22");
      const names = {
        db: `p1as-db-${runId}`,
        app: `p1as-app-${runId}`,
        network: `p1as-net-${runId}`,
        volume: `p1as-vol-${runId}`,
        image: `p1as-app:${runId}`,
      };
      for (const name of Object.values(names)) {
        expect(name).not.toMatch(/stell22-db-prod|stell22-app|stell22-caddy|stell22-db$/);
      }
      const secrets = [adminPassword, appPassword, migratorPassword, sessionSecret];
      const daemonAtStart = daemonId();
      const endpointAtStart = resolveLocalDockerEndpoint(defaultOriginRuntime());
      const releaseInput = (): AppOnlyRelease => ({
        binding: { endpoint: endpointAtStart, daemonId: daemonAtStart, runId },
        labelKey: LABEL,
        database: /^[0-9a-f]{64}$/.test(dbId) && dbImage.startsWith("sha256:") ? { id: dbId, name: names.db, imageId: dbImage } : null,
        application: /^[0-9a-f]{64}$/.test(appId) && appImage.startsWith("sha256:") ? { id: appId, name: names.app, imageId: appImage } : null,
        volume: volumeMount.length > 0 ? { name: names.volume, mountpoint: volumeMount } : null,
        network: /^[0-9a-f]{64}$/.test(networkId) ? { id: networkId, name: names.network } : null,
        image: appImage.startsWith("sha256:") ? { tag: names.image, id: appImage } : null,
      });
      let dbId = "";
      let appId = "";
      let dbImage = "";
      let appImage = "";
      let networkId = "";
      let volumeMount = "";
      let migrationRoot = "";
      let releaseError: Error | null = null;
      try {
        ensurePostgresImage();
        docker(["build", "-f", "Dockerfile", "-t", names.image, "."], secrets);
        appImage = docker(["image", "inspect", "--format", "{{.Id}}", names.image], secrets);
        expect(appImage).toMatch(/^sha256:[0-9a-f]{64}$/);
        const imageEntrypoint = docker(["image", "inspect", "--format", "{{json .Config.Entrypoint}}", names.image], secrets);
        expect(imageEntrypoint).toBe('["./docker-entrypoint-app-only.sh"]');
        networkId = docker(["network", "create", "--label", `${LABEL}=${runId}`, names.network], secrets);
        expect(networkId).toMatch(/^[0-9a-f]{64}$/);
        const volumeName = docker(["volume", "create", "--label", `${LABEL}=${runId}`, names.volume], secrets);
        expect(volumeName).toBe(names.volume);
        volumeMount = docker(["volume", "inspect", "--format", "{{.Mountpoint}}", volumeName], secrets);
        expect(volumeMount.length).toBeGreaterThan(0);
        dbId = docker([
          "run", "-d", "--pull", "never", "--restart", "no", "--name", names.db,
          "--network", names.network, "--network-alias", "db",
          "--label", `${LABEL}=${runId}`,
          "--mount", `type=volume,source=${names.volume},target=/var/lib/postgresql/data`,
          "-e", `POSTGRES_USER=${DISPOSABLE_ADMIN_ROLE}`, "-e", `POSTGRES_PASSWORD=${adminPassword}`, "-e", `POSTGRES_DB=${databaseName}`,
          "postgres:17-alpine",
        ], secrets);
        dbImage = docker(["inspect", "--format", "{{.Image}}", dbId], secrets);
        const bindings = docker(["inspect", "--format", "{{json .HostConfig.PortBindings}}", dbId], secrets);
        expect(bindings === "null" || bindings === "{}").toBe(true);
        const published = docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", dbId], secrets);
        expect(published.includes("HostIp")).toBe(false);
        expect(published.includes("HostPort")).toBe(false);
        waitReady(names.db, databaseName, secrets);
        const version = psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, "SELECT current_setting('server_version_num')", secrets);
        expect(version.startsWith("17")).toBe(true);
        expect(psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT current_user || '|' || rolsuper::text FROM pg_roles WHERE rolname = current_user`, secrets)).toBe(`${DISPOSABLE_ADMIN_ROLE}|true`);
        psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, roleTopologySql({ databaseName, appPassword, migratorPassword }), secrets);
        psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, "CREATE ROLE p1rs_other NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT NOLOGIN; GRANT USAGE ON SCHEMA public TO p1rs_other", secrets);
        psql(names.db, databaseName, MIGRATOR_ROLE, "CREATE FUNCTION public.p1rs_probe_fn() RETURNS integer LANGUAGE sql AS 'SELECT 1'", secrets);
        const probeGrants = expectFunctionGrants(names.db, databaseName, "p1rs_probe_fn", secrets);
        expect(psql(names.db, databaseName, DISPOSABLE_APP_ROLE, "SELECT public.p1rs_probe_fn()::text", secrets)).toBe("1");
        expect(psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, "SELECT public.p1rs_probe_fn()::text", secrets)).toBe("1");
        expectDenied(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, "SET ROLE p1rs_other; SELECT public.p1rs_probe_fn()", secrets);
        migrationRoot = fs.mkdtempSync(path.join(process.cwd(), ".p1rs-migrate-"));
        materialize(migrationRoot);
        const p1Directory = path.join(migrationRoot, "prisma", "migrations", P1_MIGRATION_NAME);
        const heldP1 = path.join(migrationRoot, "p1-held");
        fs.renameSync(p1Directory, heldP1);
        migrate(names.network, names.image, `p1as-hist-${runId}`, runId, migratorUrl(migratorPassword, databaseName), migrationRoot, secrets, true);
        fs.renameSync(heldP1, p1Directory);
        psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, migrationHistoryPrivilegesSql(), secrets);
        const historicalHistory = historyMarker(names.db, databaseName, secrets);
        expect(historicalHistory).not.toBe("ABSENT");
        expect(p1Marker(names.db, databaseName, secrets)).toBe("ABSENT");
        expect(psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, "SELECT current_user", secrets)).toBe(DISPOSABLE_ADMIN_ROLE);
        expect(psql(names.db, databaseName, DISPOSABLE_APP_ROLE, "SELECT current_user || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text FROM pg_roles WHERE rolname = current_user", secrets)).toBe(`${DISPOSABLE_APP_ROLE}|false|false|false`);
        expect(psql(names.db, databaseName, DISPOSABLE_APP_ROLE, "SELECT has_schema_privilege(current_user, 'public', 'CREATE')::text", secrets)).toBe("false");
        expect(psql(names.db, databaseName, DISPOSABLE_APP_ROLE, "SELECT has_schema_privilege(current_user, 'public', 'USAGE')::text", secrets)).toBe("true");
        expect(psql(names.db, databaseName, DISPOSABLE_APP_ROLE, `SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = '${DISPOSABLE_APP_ROLE}')`, secrets)).toBe("0");
        expect(psql(names.db, databaseName, DISPOSABLE_APP_ROLE, `SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = '${DISPOSABLE_APP_ROLE}')`, secrets)).toBe("0");
        expect(psql(names.db, databaseName, DISPOSABLE_APP_ROLE, `SELECT count(*)::text FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = '${DISPOSABLE_APP_ROLE}'`, secrets)).toBe("0");
        expectDenied(names.db, databaseName, DISPOSABLE_APP_ROLE, "CREATE TABLE public.p1rs_denied (id integer)", secrets);
        expectDenied(names.db, databaseName, DISPOSABLE_APP_ROLE, 'ALTER TABLE public."Setting" ADD COLUMN p1rs_denied integer', secrets);
        expectDenied(names.db, databaseName, DISPOSABLE_APP_ROLE, 'DROP TABLE public."Setting"', secrets);
        expectDenied(names.db, databaseName, DISPOSABLE_APP_ROLE, `SET ROLE ${MIGRATOR_ROLE}`, secrets);
        expectDenied(names.db, databaseName, DISPOSABLE_APP_ROLE, `ALTER SCHEMA public OWNER TO ${DISPOSABLE_APP_ROLE}`, secrets);
        expectDenied(names.db, databaseName, DISPOSABLE_APP_ROLE, `GRANT ${MIGRATOR_ROLE} TO ${DISPOSABLE_APP_ROLE}`, secrets);
        expect(psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, "SELECT (to_regclass('public.p1rs_denied') IS NULL)::text", secrets)).toBe("true");
        const appMigrate = migrate(names.network, names.image, `p1as-appmig-${runId}`, runId, appUrl(appPassword, databaseName), "", secrets, false);
        expect(appMigrate.status).not.toBe(0);
        expect(historyMarker(names.db, databaseName, secrets)).toBe(historicalHistory);
        expect(p1Marker(names.db, databaseName, secrets)).toBe("ABSENT");
        expectRefusal(names, releaseInput, appImage, runId, `p1as-pending-${runId}`, appUrl(appPassword, databaseName), "PENDING_MIGRATION", historicalHistory, names.db, databaseName, secrets);
        expectRefusal(names, releaseInput, appImage, runId, `p1as-super-${runId}`, adminUrl(adminPassword, databaseName), "BOOTSTRAP_SUPERUSER", historicalHistory, names.db, databaseName, secrets);
        const finishedAt = psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT finished_at::text FROM public."_prisma_migrations" WHERE migration_name = '20260629154204_init'`, secrets);
        expect(finishedAt).toMatch(/^[0-9][0-9:.+ -]*$/);
        psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, `UPDATE public."_prisma_migrations" SET finished_at = NULL, applied_steps_count = 0 WHERE migration_name = '20260629154204_init'`, secrets);
        const failedHistory = historyMarker(names.db, databaseName, secrets);
        expectRefusal(names, releaseInput, appImage, runId, `p1as-failed-${runId}`, appUrl(appPassword, databaseName), "FAILED_MIGRATION", failedHistory, names.db, databaseName, secrets);
        expect(psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT (finished_at IS NULL)::text FROM public."_prisma_migrations" WHERE migration_name = '20260629154204_init'`, secrets)).toBe("true");
        psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, `UPDATE public."_prisma_migrations" SET finished_at = '${finishedAt}', applied_steps_count = 1 WHERE migration_name = '20260629154204_init'`, secrets);
        expect(historyMarker(names.db, databaseName, secrets)).toBe(historicalHistory);
        const privilegeRaw = psql(names.db, databaseName, MIGRATOR_ROLE, migratorPrivilegeSql(), secrets);
        const privilege = evaluateMigratorPrivileges(parseMigratorPrivilegeReport(JSON.parse(privilegeRaw)), {
          migratorRole: MIGRATOR_ROLE,
          bootstrapRole: DISPOSABLE_ADMIN_ROLE,
        });
        expect(privilege).toEqual({ ok: true });
        migrate(names.network, names.image, `p1as-p1-${runId}`, runId, migratorUrl(migratorPassword, databaseName), migrationRoot, secrets, true);
        const appliedHistory = historyMarker(names.db, databaseName, secrets);
        expect(appliedHistory).not.toBe(historicalHistory);
        const p1After = p1Marker(names.db, databaseName, secrets);
        expect(p1After.startsWith(`${P1_MIGRATION_NAME}|${P1_SHA256}|`)).toBe(true);
        expect(p1After.endsWith("|1")).toBe(true);
        const p1FunctionGrants = expectFunctionGrants(names.db, databaseName, "batch_creation_command_provenance_guard", secrets);
        expect(expectFunctionGrants(names.db, databaseName, "p1rs_probe_fn", secrets)).toBe(probeGrants);
        psql(names.db, databaseName, MIGRATOR_ROLE, [
          "CREATE FUNCTION public.p1rs_extra() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
          'CREATE TRIGGER p1rs_extra BEFORE UPDATE ON public."BatchCreationCommand" FOR EACH ROW EXECUTE FUNCTION public.p1rs_extra()',
        ].join(";\n"), secrets);
        const mismatchHistory = historyMarker(names.db, databaseName, secrets);
        expectRefusal(names, releaseInput, appImage, runId, `p1as-shape-${runId}`, appUrl(appPassword, databaseName), "SCHEMA_NOT_READY", mismatchHistory, names.db, databaseName, secrets);
        psql(names.db, databaseName, MIGRATOR_ROLE, 'DROP TRIGGER p1rs_extra ON public."BatchCreationCommand"; DROP FUNCTION public.p1rs_extra()', secrets);
        expect(historyMarker(names.db, databaseName, secrets)).toBe(appliedHistory);
        const businessSequences = psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, "SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S'", secrets);
        process.stderr.write(`EVIDENCE pg=${version} dbId=${dbId} image=${appImage} entrypoint=${imageEntrypoint} publishedPorts=none admin=${DISPOSABLE_ADMIN_ROLE} app=${DISPOSABLE_APP_ROLE} migrator=${MIGRATOR_ROLE} businessSequences=${businessSequences} p1Before=ABSENT p1After=${p1After} probe=${probeGrants} p1Function=${p1FunctionGrants}\n`);
        appId = startApp(names.network, names.image, names.app, runId, appUrl(appPassword, databaseName), sessionSecret, secrets);
        expect(docker(["inspect", "--format", "{{json .Config.Entrypoint}}", appId], secrets)).toBe('["./docker-entrypoint-app-only.sh"]');
        const appLogin = docker(["exec", appId, "node", "-e", "const u=new URL(process.env.DATABASE_URL||''); if(!u.username) process.exit(2); process.stdout.write(u.username)"], secrets);
        expect(appLogin).toBe(DISPOSABLE_APP_ROLE);
        expect(appLogin).not.toBe(DISPOSABLE_ADMIN_ROLE);
        expect(appLogin).not.toBe(MIGRATOR_ROLE);
        waitHealth(names.app, secrets);
        expect(historyMarker(names.db, databaseName, secrets)).toBe(appliedHistory);
        expect(containerLogs(names.app, secrets)).not.toMatch(/prisma\s+migrate\s+deploy|Applying migration|prisma\s+db\s+push|prisma\s+migrate\s+reset/);
        runBusinessDml(names.network, names.image, `p1as-dml-${runId}`, runId, appUrl(appPassword, databaseName), runId, secrets);
        expect(psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT count(*)::text FROM public."Setting" WHERE key = 'p1rs_${runId}'`, secrets)).toBe("0");
        const restartReady = confirmOwnedContainer(releaseInput(), { id: appId, name: names.app, imageId: appImage }, realWorld());
        if (!restartReady.ok) throw new Error(restartReady.reason);
        docker(["restart", appId], secrets);
        waitHealth(names.app, secrets);
        expect(historyMarker(names.db, databaseName, secrets)).toBe(appliedHistory);
        expect(p1Marker(names.db, databaseName, secrets)).toBe(p1After);
        expect(containerLogs(names.app, secrets)).not.toMatch(/prisma\s+migrate\s+deploy|Applying migration/);
        psql(names.db, databaseName, MIGRATOR_ROLE, `CREATE SEQUENCE public.p1rs_probe_seq; GRANT USAGE, SELECT ON SEQUENCE public.p1rs_probe_seq TO ${DISPOSABLE_APP_ROLE}`, secrets);
        expect(psql(names.db, databaseName, DISPOSABLE_APP_ROLE, "SELECT nextval('public.p1rs_probe_seq')::text", secrets)).toBe("1");
        psql(names.db, databaseName, MIGRATOR_ROLE, "DROP SEQUENCE public.p1rs_probe_seq", secrets);
        expect(psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, "SELECT rolsuper::text FROM pg_roles WHERE rolname = current_user", secrets)).toBe("true");
        psql(names.db, databaseName, DISPOSABLE_ADMIN_ROLE, "CREATE TABLE public.p1rs_admin_probe (id integer); DROP TABLE public.p1rs_admin_probe", secrets);
        expectDenied(names.db, databaseName, DISPOSABLE_APP_ROLE, "CREATE TABLE public.p1rs_denied (id integer)", secrets);
        process.stderr.write(`EVIDENCE restartHistorySame=yes health=200 dml=setting p1Unchanged=yes adminStillSuperuser=yes\n`);
        if (daemonId() !== daemonAtStart) throw new Error("daemon changed before cleanup");
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error("disposable role split failed");
        throw error;
      } finally {
        for (const name of [`p1as-hist-${runId}`, `p1as-p1-${runId}`, `p1as-appmig-${runId}`, `p1as-dml-${runId}`, `p1as-pending-${runId}`, `p1as-super-${runId}`, `p1as-failed-${runId}`, `p1as-shape-${runId}`]) {
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

function expectRefusal(
  names: { network: string; image: string },
  releaseInput: () => AppOnlyRelease,
  appImage: string,
  runId: string,
  name: string,
  databaseUrl: string,
  code: string,
  historyBefore: string,
  db: string,
  databaseName: string,
  secrets: readonly string[],
): void {
  const id = startApp(names.network, names.image, name, runId, databaseUrl, randomBytes(24).toString("hex"), secrets);
  const state = waitExit(id, secrets);
  expect(state.code).not.toBe("0");
  expect(docker(["inspect", "--format", "{{json .Config.Entrypoint}}", id], secrets)).toBe('["./docker-entrypoint-app-only.sh"]');
  const text = containerLogs(id, secrets);
  expect(text).toContain(`APP_ONLY_STARTUP ${code}`);
  expect(text).not.toMatch(/prisma\s+migrate\s+deploy/);
  expect(text).not.toContain("Applying migration");
  expect(text).not.toContain(databaseUrl);
  expect(historyMarker(db, databaseName, secrets)).toBe(historyBefore);
  removeIfOwned(releaseInput, { id, name }, appImage);
}

function startApp(network: string, image: string, name: string, runId: string, databaseUrl: string, sessionSecret: string, secrets: readonly string[]): string {
  return docker([
    "run", "-d", "--pull", "never", "--restart", "no", "--name", name,
    "--network", network, "--label", `${LABEL}=${runId}`,
    "-e", `DATABASE_URL=${databaseUrl}`,
    "-e", `SESSION_SECRET=${sessionSecret}`,
    "-e", "PORT=3000",
    image,
  ], secrets);
}

function migrate(
  network: string,
  image: string,
  name: string,
  runId: string,
  databaseUrl: string,
  migrationRoot: string,
  secrets: readonly string[],
  required: boolean,
): { status: number } {
  const args = [
    "run", "--rm", "--pull", "never", "--network", network, "--label", `${LABEL}=${runId}`, "--name", name,
    "--entrypoint", "npx", "-e", `DATABASE_URL=${databaseUrl}`,
  ];
  if (migrationRoot.length > 0) {
    args.push("--mount", `type=bind,source=${migrationRoot.replace(/\\/g, "/")},target=/fixture,readonly`);
  }
  args.push(image, "prisma", "migrate", "deploy", "--schema", migrationRoot.length > 0 ? "/fixture/prisma/schema.prisma" : "/app/prisma/schema.prisma");
  const child = spawnSync("docker", args, { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (required && child.status !== 0) throw new Error(redact(`migrate ${name} failed: ${(child.stderr || child.stdout).slice(-1500)}`, secrets));
  return { status: child.status ?? 1 };
}

function runBusinessDml(network: string, image: string, name: string, runId: string, databaseUrl: string, key: string, secrets: readonly string[]): void {
  const script = [
    'const {PrismaClient}=require("@prisma/client");',
    "const prisma=new PrismaClient();",
    "const key='p1rs_'+process.env.P1RS_KEY;",
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
    "--entrypoint", "node", "-e", `DATABASE_URL=${databaseUrl}`, "-e", `P1RS_KEY=${key}`,
    image, "-e", script,
  ], { encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (child.status !== 0 || !child.stdout.includes("DML ok")) {
    throw new Error(redact(`business DML failed: ${(child.stderr || child.stdout).slice(-1500)}`, secrets));
  }
}

function materialize(destination: string): void {
  const listed = spawnSync("git", ["ls-files", "prisma/schema.prisma", "prisma/migrations"], { encoding: "utf8", windowsHide: true });
  if (listed.status !== 0) throw new Error("git ls-files failed");
  for (const relative of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    const shown = spawnSync("git", ["show", `HEAD:${relative}`], { encoding: "buffer", windowsHide: true });
    if (shown.status !== 0) throw new Error(`git show failed for ${relative}`);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, shown.stdout);
  }
}

function historyMarker(container: string, databaseName: string, secrets: readonly string[]): string {
  const exists = psql(container, databaseName, DISPOSABLE_ADMIN_ROLE, "SELECT (to_regclass('public._prisma_migrations') IS NOT NULL)::text", secrets);
  if (exists !== "true") return "ABSENT";
  return psql(container, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT migration_name || '|' || checksum || '|' || COALESCE(finished_at::text,'') || '|' || COALESCE(rolled_back_at::text,'') || '|' || applied_steps_count::text FROM public."_prisma_migrations" ORDER BY migration_name`, secrets);
}

function p1Marker(container: string, databaseName: string, secrets: readonly string[]): string {
  const row = psql(container, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT migration_name || '|' || checksum || '|' || COALESCE(finished_at::text,'') || '|' || applied_steps_count::text FROM public."_prisma_migrations" WHERE migration_name = '${P1_MIGRATION_NAME}'`, secrets);
  return row.length === 0 ? "ABSENT" : row;
}

function expectFunctionGrants(container: string, databaseName: string, functionName: string, secrets: readonly string[]): string {
  const where = `n.nspname = 'public' AND p.proname = '${functionName}' AND pg_get_function_identity_arguments(p.oid) = ''`;
  const aclNull = psql(container, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT (p.proacl IS NULL)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${where}`, secrets);
  const publicGrant = psql(container, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) AS a WHERE ${where} AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`, secrets);
  const appGrant = psql(container, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) AS a WHERE ${where} AND a.grantee = (SELECT oid FROM pg_roles WHERE rolname = '${DISPOSABLE_APP_ROLE}') AND a.privilege_type = 'EXECUTE'`, secrets);
  const publicExecute = psql(container, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT has_function_privilege('public', 'public.${functionName}()', 'EXECUTE')::text`, secrets);
  const appExecute = psql(container, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT has_function_privilege('${DISPOSABLE_APP_ROLE}', 'public.${functionName}()', 'EXECUTE')::text`, secrets);
  const otherExecute = psql(container, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT has_function_privilege('p1rs_other', 'public.${functionName}()', 'EXECUTE')::text`, secrets);
  const owner = psql(container, databaseName, DISPOSABLE_ADMIN_ROLE, `SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${where}`, secrets);
  expect(aclNull).toBe("false");
  expect(publicGrant).toBe("0");
  expect(appGrant).toBe("1");
  expect(publicExecute).toBe("false");
  expect(appExecute).toBe("true");
  expect(otherExecute).toBe("false");
  expect(owner).toBe(MIGRATOR_ROLE);
  return `aclNull=${aclNull} publicGrant=${publicGrant} appGrant=${appGrant} publicExecute=${publicExecute} appExecute=${appExecute} otherExecute=${otherExecute} owner=${owner}`;
}

function expectDenied(container: string, databaseName: string, user: string, sql: string, secrets: readonly string[]): void {
  const result = psqlRaw(container, databaseName, user, sql);
  if (result.status === 0) throw new Error(redact(`expected refusal for ${sql}`, secrets));
  const text = `${result.stderr}\n${result.stdout}`;
  if (!/42501|permission denied|must be owner/i.test(text)) throw new Error(redact(`unexpected refusal for ${sql}: ${text.slice(0, 400)}`, secrets));
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
    const state = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", container], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    if (state.status !== 0 || state.stdout.trim() !== "running") throw new Error(redact(`database container ${state.stdout.trim() || "missing"}`, secrets));
    const child = spawnSync("docker", ["exec", container, "psql", "-U", DISPOSABLE_ADMIN_ROLE, "-d", databaseName, "-At", "-c", "SELECT 1"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
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
  throw new Error(redact(`container did not exit: ${last} ${containerLogs(container, secrets).slice(-800)}`, secrets));
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
  const result = psqlRaw(container, databaseName, user, sql);
  if (result.status !== 0) throw new Error(redact((result.stderr || result.stdout).slice(0, 500), secrets));
  return result.stdout.trim();
}

function psqlRaw(container: string, databaseName: string, user: string, sql: string): { status: number; stdout: string; stderr: string } {
  const child = spawnSync("docker", ["exec", "-i", container, "psql", "-U", user, "-d", databaseName, "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  return { status: child.status ?? 1, stdout: child.stdout, stderr: child.stderr || child.error?.message || "" };
}

function containerLogs(container: string, secrets: readonly string[]): string {
  const child = spawnSync("docker", ["logs", container], { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (child.status !== 0) throw new Error(redact((child.stderr || child.stdout || "").slice(-500), secrets));
  return `${child.stdout}\n${child.stderr}`;
}

function removeIfOwned(releaseInput: () => AppOnlyRelease, container: { id: string; name: string }, appImage: string): void {
  if (!/^[0-9a-f]{64}$/.test(container.id)) return;
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

function redact(text: string, secrets: readonly string[]): string {
  let value = text.replace(/postgresql:\/\/[^@\s]+@/g, "postgresql://redacted@").replace(/PASSWORD '[^']*'/g, "PASSWORD 'redacted'");
  for (const secret of secrets) {
    if (secret.length > 0) value = value.split(secret).join("redacted");
  }
  return value;
}

function adminUrl(password: string, databaseName: string): string {
  return `postgresql://${DISPOSABLE_ADMIN_ROLE}:${password}@db:5432/${databaseName}?schema=public`;
}

function appUrl(password: string, databaseName: string): string {
  return `postgresql://${DISPOSABLE_APP_ROLE}:${password}@db:5432/${databaseName}?schema=public`;
}

function migratorUrl(password: string, databaseName: string): string {
  return `postgresql://${MIGRATOR_ROLE}:${password}@db:5432/${databaseName}?schema=public`;
}

function sleep(): void {
  spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);"], { windowsHide: true });
}
