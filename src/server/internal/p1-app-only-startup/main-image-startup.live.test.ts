import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { confirmOwnedContainer, formatReleaseReport, releaseAppOnly } from "@/server/internal/p1-app-only-startup/cleanup";
import { realWorld } from "@/server/internal/p1-write-freeze-historical/runtime";
import { defaultOriginRuntime, resolveLocalDockerEndpoint } from "@/server/internal/p1-isolated-runner/container-origin";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const LABEL = "stell22.p1.safe-startup";

describe.skipIf(!LIVE)("main image safe startup candidate", () => {
  it(
    "starts only a restricted role on a matching schema and does not migrate",
    () => {
      const runId = randomBytes(4).toString("hex");
      const bootPassword = randomBytes(16).toString("hex");
      const appPassword = randomBytes(16).toString("hex");
      const ownerPassword = randomBytes(16).toString("hex");
      const sessionSecret = randomBytes(24).toString("hex");
      for (const secret of [bootPassword, appPassword, ownerPassword, sessionSecret]) {
        expect(secret).toMatch(/^[0-9a-f]+$/);
      }
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
        expect(name.includes("stell22")).toBe(false);
      }
      const daemonAtStart = daemonId();
      const endpointAtStart = resolveLocalDockerEndpoint(defaultOriginRuntime());
      const releaseInput = () => ({
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
      let appliedHistory = "";
      const extras: Array<{ id: string; name: string }> = [];
      let migrationRoot = "";
      let releaseError: Error | null = null;
      try {
        ensurePostgresImage();
        docker(["build", "-f", "Dockerfile", "-t", names.image, "."]);
        appImage = docker(["image", "inspect", "--format", "{{.Id}}", names.image]);
        expect(appImage).toMatch(/^sha256:[0-9a-f]{64}$/);
        const imageEntrypoint = docker(["image", "inspect", "--format", "{{json .Config.Entrypoint}}", names.image]);
        expect(imageEntrypoint).toBe('["./docker-entrypoint-app-only.sh"]');
        const script = docker([
          "run", "--rm", "--pull", "never", "--entrypoint", "cat", names.image, "/app/docker-entrypoint-app-only.sh",
        ]);
        expect(script).toContain("src/server/internal/p1-app-only-startup/run.ts");
        expect(script).not.toMatch(/prisma\s+(?:migrate|db\s+push)/);
        const legacyAbsent = spawnSync(
          "docker",
          ["run", "--rm", "--pull", "never", "--entrypoint", "ls", names.image, "/app/docker-entrypoint.sh"],
          { encoding: "utf8", timeout: 60_000 },
        );
        expect(legacyAbsent.status).not.toBe(0);
        docker([
          "run", "--rm", "--pull", "never", "--entrypoint", "ls", names.image,
          "/app/tsconfig.json",
          "/app/package.json",
          "/app/next.config.ts",
          "/app/prisma/schema.prisma",
          "/app/prisma/migrations",
          "/app/src/server/internal/p1-app-only-startup/run.ts",
          "/app/node_modules/.bin/tsx",
          "/app/node_modules/@prisma/client",
          "/app/.next",
        ]);
        networkId = docker(["network", "create", "--label", `${LABEL}=${runId}`, names.network]);
        expect(networkId).toMatch(/^[0-9a-f]{64}$/);
        const volumeName = docker(["volume", "create", "--label", `${LABEL}=${runId}`, names.volume]);
        expect(volumeName).toBe(names.volume);
        volumeMount = docker(["volume", "inspect", "--format", "{{.Mountpoint}}", volumeName]);
        expect(volumeMount.length).toBeGreaterThan(0);
        dbId = docker([
          "run", "-d", "--pull", "never", "--restart", "no", "--name", names.db,
          "--network", names.network, "--network-alias", "db",
          "--label", `${LABEL}=${runId}`,
          "--mount", `type=volume,source=${names.volume},target=/var/lib/postgresql/data`,
          "-e", "POSTGRES_USER=p1as_boot", "-e", `POSTGRES_PASSWORD=${bootPassword}`, "-e", `POSTGRES_DB=${databaseName}`,
          "postgres:17-alpine",
        ]);
        dbImage = docker(["inspect", "--format", "{{.Image}}", dbId]);
        const bindings = docker(["inspect", "--format", "{{json .HostConfig.PortBindings}}", dbId]);
        expect(bindings === "null" || bindings === "{}").toBe(true);
        const published = docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", dbId]);
        expect(published.includes("HostIp")).toBe(false);
        expect(published.includes("HostPort")).toBe(false);
        waitReady(names.db, databaseName);
        const version = psql(names.db, databaseName, "SELECT current_setting('server_version_num')");
        expect(version.startsWith("17")).toBe(true);
        process.stderr.write(`EVIDENCE pg=${version} dbId=${dbId} image=${appImage} entrypoint=${imageEntrypoint} publishedPorts=none\n`);
        psql(names.db, databaseName, [
          "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
          "REVOKE USAGE ON SCHEMA public FROM PUBLIC",
          `CREATE ROLE p1as_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
          `CREATE ROLE p1as_owner LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
          "GRANT USAGE ON SCHEMA public TO p1as_app",
          "GRANT USAGE ON SCHEMA public TO p1as_owner",
          "CREATE ROLE p1as_migrator NOLOGIN",
        ].join(";\n"));
        expect(historyMarker(names.db, databaseName)).toBe("ABSENT");
        expectRefusal(names, extras, releaseInput, appImage, runId, `p1as-miss-${runId}`, appUrl(appPassword, databaseName), "MIGRATION_HISTORY_MISSING", "ABSENT", names.db, databaseName);
        expect(historyMarker(names.db, databaseName)).toBe("ABSENT");
        migrationRoot = fs.mkdtempSync(path.join(process.cwd(), ".p1ss-migrate-"));
        materialize(migrationRoot);
        harnessMigrate(names.network, names.image, runId, bootUrl(bootPassword, databaseName), migrationRoot);
        appliedHistory = historyMarker(names.db, databaseName);
        expect(appliedHistory).not.toBe("ABSENT");
        const historyRows = appliedHistory.split("\n").filter(Boolean).length;
        process.stderr.write(`EVIDENCE historyRowsAfterHarness=${historyRows} harnessMigrate=explicit-entrypoint-override\n`);
        psql(names.db, databaseName, [
          "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO p1as_app",
          "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO p1as_app",
          'GRANT SELECT ON TABLE public."_prisma_migrations" TO p1as_app',
        ].join(";\n"));
        expect(psql(names.db, databaseName, "SELECT rolsuper::text FROM pg_roles WHERE rolname = 'p1as_boot'")).toBe("true");
        expectRefusal(names, extras, releaseInput, appImage, runId, `p1as-super-${runId}`, bootUrl(bootPassword, databaseName), "BOOTSTRAP_SUPERUSER", appliedHistory, names.db, databaseName);
        psql(names.db, databaseName, "ALTER SCHEMA public OWNER TO p1as_owner");
        expect(psql(names.db, databaseName, "SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public'")).toBe("p1as_owner");
        expectRefusal(names, extras, releaseInput, appImage, runId, `p1as-owner-${runId}`, ownerUrl(ownerPassword, databaseName), "APP_ROLE_REFUSED", appliedHistory, names.db, databaseName);
        psql(names.db, databaseName, "ALTER SCHEMA public OWNER TO p1as_boot");
        psql(names.db, databaseName, "GRANT p1as_migrator TO p1as_app");
        expect(psql(names.db, databaseName, "SELECT count(*)::text FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'p1as_app'")).toBe("1");
        expectRefusal(names, extras, releaseInput, appImage, runId, `p1as-member-${runId}`, appUrl(appPassword, databaseName), "APP_ROLE_REFUSED", appliedHistory, names.db, databaseName);
        psql(names.db, databaseName, "REVOKE p1as_migrator FROM p1as_app");
        expect(psql(names.db, databaseName, "SELECT count(*)::text FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'p1as_app'")).toBe("0");
        psql(names.db, databaseName, `UPDATE public."_prisma_migrations" SET migration_name = migration_name || '__p1ss_pending' WHERE migration_name = '20260629154204_init'`);
        const pendingHistory = historyMarker(names.db, databaseName);
        expect(pendingHistory).not.toBe(appliedHistory);
        expectRefusal(names, extras, releaseInput, appImage, runId, `p1as-pending-${runId}`, appUrl(appPassword, databaseName), "PENDING_MIGRATION", pendingHistory, names.db, databaseName);
        psql(names.db, databaseName, `UPDATE public."_prisma_migrations" SET migration_name = '20260629154204_init' WHERE migration_name = '20260629154204_init__p1ss_pending'`);
        expect(historyMarker(names.db, databaseName)).toBe(appliedHistory);
        const finishedAt = psql(names.db, databaseName, `SELECT finished_at::text FROM public."_prisma_migrations" WHERE migration_name = '20260629154204_init'`);
        expect(finishedAt).toMatch(/^[0-9][0-9:.+ -]*$/);
        psql(names.db, databaseName, `UPDATE public."_prisma_migrations" SET finished_at = NULL, applied_steps_count = 0 WHERE migration_name = '20260629154204_init'`);
        const failedHistory = historyMarker(names.db, databaseName);
        expectRefusal(names, extras, releaseInput, appImage, runId, `p1as-failed-${runId}`, appUrl(appPassword, databaseName), "FAILED_MIGRATION", failedHistory, names.db, databaseName);
        expect(psql(names.db, databaseName, `SELECT (finished_at IS NULL)::text FROM public."_prisma_migrations" WHERE migration_name = '20260629154204_init'`)).toBe("true");
        psql(names.db, databaseName, `UPDATE public."_prisma_migrations" SET finished_at = '${finishedAt}', applied_steps_count = 1 WHERE migration_name = '20260629154204_init'`);
        expect(historyMarker(names.db, databaseName)).toBe(appliedHistory);
        appId = startApp(names.network, names.image, names.app, runId, appUrl(appPassword, databaseName), sessionSecret);
        const started = docker(["inspect", "--format", "{{json .Config.Entrypoint}}", appId]);
        expect(started).toBe('["./docker-entrypoint-app-only.sh"]');
        waitHealth(names.app);
        expect(historyMarker(names.db, databaseName)).toBe(appliedHistory);
        const successLogs = containerLogs(names.app);
        expect(successLogs).not.toMatch(/prisma\s+migrate\s+deploy/);
        expect(successLogs).not.toContain("Applying migration");
        expect(successLogs).not.toContain(appPassword);
        expect(successLogs).not.toContain(bootPassword);
        const restartReady = confirmOwnedContainer(releaseInput(), { id: appId, name: names.app, imageId: appImage }, realWorld());
        if (!restartReady.ok) throw new Error(restartReady.reason);
        docker(["restart", appId]);
        waitHealth(names.app);
        const restarted = containerLogs(names.app);
        expect(restarted).not.toMatch(/prisma\s+migrate\s+deploy/);
        expect(restarted).not.toContain("Applying migration");
        expect(restarted).not.toMatch(/prisma\s+db\s+push/);
        expect(restarted).not.toMatch(/prisma\s+migrate\s+reset/);
        expect(historyMarker(names.db, databaseName)).toBe(appliedHistory);
        process.stderr.write(`EVIDENCE restartHistoryRows=${appliedHistory.split("\n").filter(Boolean).length} health=200\n`);
        if (daemonId() !== daemonAtStart) throw new Error("daemon changed before cleanup");
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error("safe startup live test failed");
        throw error;
      } finally {
        for (const extra of extras) {
          const still = spawnSync("docker", ["inspect", "--format", "{{.Id}}", extra.id], { encoding: "utf8", timeout: 15_000 });
          if (still.status !== 0) continue;
          const ready = confirmOwnedContainer(releaseInput(), { id: extra.id, name: extra.name, imageId: appImage }, realWorld());
          if (!ready.ok) {
            process.stderr.write(`PRESERVE ${extra.name} ${ready.reason}\n`);
            continue;
          }
          spawnSync("docker", ["rm", extra.id], { encoding: "utf8", timeout: 30_000 });
        }
        if (migrationRoot.length > 0) fs.rmSync(migrationRoot, { recursive: true, force: true });
        const report = releaseAppOnly(releaseInput(), realWorld());
        if (releaseError === null && (report.preserved.length > 0 || report.failures.length > 0)) {
          throw new Error(formatReleaseReport(report));
        }
        if (report.preserved.length > 0 || report.failures.length > 0) {
          process.stderr.write(`${formatReleaseReport(report)}\n`);
        }
      }
    },
    1_800_000,
  );
});

function bootUrl(password: string, databaseName: string): string {
  return `postgresql://p1as_boot:${password}@db:5432/${databaseName}?schema=public`;
}

function appUrl(password: string, databaseName: string): string {
  return `postgresql://p1as_app:${password}@db:5432/${databaseName}?schema=public`;
}

function ownerUrl(password: string, databaseName: string): string {
  return `postgresql://p1as_owner:${password}@db:5432/${databaseName}?schema=public`;
}

function expectRefusal(
  names: { network: string; image: string },
  extras: Array<{ id: string; name: string }>,
  releaseInput: () => Parameters<typeof confirmOwnedContainer>[0],
  appImage: string,
  runId: string,
  name: string,
  databaseUrl: string,
  code: string,
  historyBefore: string,
  db: string,
  databaseName: string,
): void {
  const id = startApp(names.network, names.image, name, runId, databaseUrl, randomBytes(24).toString("hex"));
  extras.push({ id, name });
  const state = waitExit(id);
  expect(state.code).not.toBe("0");
  const entrypoint = docker(["inspect", "--format", "{{json .Config.Entrypoint}}", id]);
  expect(entrypoint).toBe('["./docker-entrypoint-app-only.sh"]');
  const text = containerLogs(id);
  expect(text).toContain(`APP_ONLY_STARTUP ${code}`);
  expect(text).not.toMatch(/prisma\s+migrate\s+deploy/);
  expect(text).not.toContain("Applying migration");
  expect(text).not.toContain(databaseUrl);
  expect(historyMarker(db, databaseName)).toBe(historyBefore);
  const ready = confirmOwnedContainer(releaseInput(), { id, name, imageId: appImage }, realWorld());
  if (!ready.ok) throw new Error(`preserve ${name}: ${ready.reason}`);
  docker(["rm", id]);
}

function startApp(network: string, image: string, name: string, runId: string, databaseUrl: string, sessionSecret: string): string {
  return docker([
    "run", "-d", "--pull", "never", "--restart", "no", "--name", name,
    "--network", network, "--label", `${LABEL}=${runId}`,
    "-e", `DATABASE_URL=${databaseUrl}`,
    "-e", `SESSION_SECRET=${sessionSecret}`,
    "-e", "PORT=3000",
    image,
  ]);
}

function harnessMigrate(network: string, image: string, runId: string, databaseUrl: string, migrationRoot: string): void {
  const child = spawnSync("docker", [
    "run", "--rm", "--pull", "never",
    "--network", network,
    "--label", `${LABEL}=${runId}`,
    "--name", `p1as-migrate-${runId}`,
    "--mount", `type=bind,source=${migrationRoot.replace(/\\/g, "/")},target=/fixture,readonly`,
    "--entrypoint", "npx",
    "-e", `DATABASE_URL=${databaseUrl}`,
    image,
    "prisma", "migrate", "deploy", "--schema", "/fixture/prisma/schema.prisma",
  ], { encoding: "utf8", timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  if (child.status !== 0) {
    throw new Error(redact(`harness migrate failed: ${(child.stderr || child.stdout).slice(-1500)}`));
  }
}

function materialize(destination: string): void {
  const listed = spawnSync("git", ["ls-files", "prisma/schema.prisma", "prisma/migrations"], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error("git ls-files failed");
  for (const relative of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    const shown = spawnSync("git", ["show", `HEAD:${relative}`], { encoding: "buffer" });
    if (shown.status !== 0) throw new Error(`git show failed for ${relative}`);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, shown.stdout);
  }
}

function historyMarker(container: string, databaseName: string): string {
  const exists = psql(container, databaseName, `SELECT (to_regclass('public._prisma_migrations') IS NOT NULL)::text`);
  if (exists !== "true") return "ABSENT";
  return psql(
    container,
    databaseName,
    `SELECT migration_name || '|' || checksum || '|' || COALESCE(finished_at::text,'') || '|' || COALESCE(rolled_back_at::text,'') || '|' || applied_steps_count::text FROM public."_prisma_migrations" ORDER BY migration_name`,
  );
}

function ensurePostgresImage(): void {
  const present = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", "postgres:17-alpine"], { encoding: "utf8", timeout: 30_000 });
  if (present.status === 0 && present.stdout.trim().startsWith("sha256:")) return;
  const pulled = spawnSync("docker", ["pull", "postgres:17-alpine"], { encoding: "utf8", timeout: 300_000 });
  if (pulled.status !== 0) throw new Error("postgres:17-alpine is not available for the disposable test");
}

function waitReady(container: string, databaseName: string): void {
  let last = "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const state = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", container], { encoding: "utf8", timeout: 15_000 });
    if (state.status !== 0 || state.stdout.trim() !== "running") {
      const output = spawnSync("docker", ["logs", "--tail", "40", container], { encoding: "utf8", timeout: 15_000 });
      throw new Error(`database container ${state.stdout.trim() || "missing"}: ${redact((output.stderr || output.stdout).slice(-800))}`);
    }
    const child = spawnSync("docker", ["exec", container, "psql", "-U", "p1as_boot", "-d", databaseName, "-At", "-c", "SELECT 1"], { encoding: "utf8", timeout: 15_000 });
    if (child.status === 0 && child.stdout.trim() === "1") return;
    last = `${child.status ?? "null"} ${redact((child.stderr || child.stdout || child.error?.message || "").slice(-300))}`;
    sleep();
  }
  throw new Error(`disposable database did not become ready: ${last}`);
}

function waitExit(container: string): { code: string } {
  let last = "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const state = spawnSync("docker", ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", container], { encoding: "utf8", timeout: 15_000 });
    last = state.stdout.trim();
    const [status, code] = last.split(" ");
    if (status === "exited") return { code: code ?? "" };
    sleep();
  }
  throw new Error(`container did not exit: ${last} ${redact(containerLogs(container).slice(-800))}`);
}

function waitHealth(container: string): void {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const child = spawnSync("docker", ["exec", container, "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { encoding: "utf8", timeout: 15_000 });
    if (child.status === 0) return;
    const state = spawnSync("docker", ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", container], { encoding: "utf8", timeout: 15_000 });
    if (state.stdout.trim().startsWith("exited")) break;
    sleep();
  }
  const logs = spawnSync("docker", ["logs", "--tail", "80", container], { encoding: "utf8", timeout: 15_000 });
  const state = spawnSync("docker", ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}} {{.State.Error}}", container], { encoding: "utf8", timeout: 15_000 });
  throw new Error(`health did not return 200: ${state.stdout.trim()} ${redact((logs.stderr || logs.stdout).slice(-1200))}`);
}

function psql(container: string, databaseName: string, sql: string): string {
  const child = spawnSync("docker", ["exec", "-i", container, "psql", "-U", "p1as_boot", "-d", databaseName, "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (child.status !== 0) throw new Error(redact((child.stderr || child.stdout).slice(0, 500)));
  return child.stdout.trim();
}

function containerLogs(container: string): string {
  const child = spawnSync("docker", ["logs", container], { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(redact((child.stderr || child.stdout || "").slice(-500)));
  return `${child.stdout}\n${child.stderr}`;
}

function daemonId(): string {
  return docker(["info", "--format", "{{.ID}}"]);
}

function docker(args: readonly string[]): string {
  const child = spawnSync("docker", [...args], { encoding: "utf8", windowsHide: true, timeout: 1_200_000, maxBuffer: 16 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(redact(`${args[0]} failed: ${(child.stderr || child.stdout || child.error?.message || "").slice(-2500)}`));
  return child.stdout.trim();
}

function redact(text: string): string {
  return text.replace(/postgresql:\/\/[^@\s]+@/g, "postgresql://redacted@").replace(/PASSWORD '[^']*'/g, "PASSWORD 'redacted'");
}

function sleep(): void {
  spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);"]);
}
