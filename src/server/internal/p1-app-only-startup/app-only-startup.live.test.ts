import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appOnlyCleanupAllowed } from "@/server/internal/p1-app-only-startup/cleanup";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const LABEL = "stell22.p1.app-only-startup";

describe.skipIf(!LIVE)("app-only startup candidate", () => {
  it(
    "starts a restricted application without migrating and refuses an unready schema",
    () => {
      const runId = randomBytes(4).toString("hex");
      const bootPassword = randomBytes(16).toString("hex");
      const appPassword = randomBytes(16).toString("hex");
      const otherPassword = randomBytes(16).toString("hex");
      const sessionSecret = randomBytes(24).toString("hex");
      const databaseName = `p1as_${runId}`;
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
      const root = fs.mkdtempSync(path.join(process.cwd(), ".p1as-startup-"));
      const historicalRoot = path.join(root, "historical");
      const fullRoot = path.join(root, "full");
      const daemonAtStart = daemonId();
      let dbId = "";
      let appId = "";
      let dbImage = "";
      let appImage = "";
      let networkId = "";
      let volumeCreated = false;
      let historyAfterP1 = "";
      try {
        materialize(historicalRoot, false);
        materialize(fullRoot, true);
        docker(["network", "create", "--label", `${LABEL}=${runId}`, names.network]);
        networkId = docker(["network", "inspect", "--format", "{{.Id}}", names.network]);
        docker(["volume", "create", "--label", `${LABEL}=${runId}`, names.volume]);
        volumeCreated = true;
        dbId = docker([
          "run", "-d", "--pull", "never", "--restart", "no", "--name", names.db,
          "--network", names.network, "--network-alias", "db",
          "--label", `${LABEL}=${runId}`,
          "--mount", `type=volume,source=${names.volume},target=/var/lib/postgresql/data`,
          "-p", "127.0.0.1::5432",
          "-e", "POSTGRES_USER=p1as_boot", "-e", `POSTGRES_PASSWORD=${bootPassword}`, "-e", `POSTGRES_DB=${databaseName}`,
          "postgres:17-alpine",
        ]);
        dbImage = docker(["inspect", "--format", "{{.Image}}", dbId]);
        const port = hostPort(names.db);
        waitReady(names.db, databaseName);
        const version = psql(names.db, databaseName, "p1as_boot", "SELECT current_setting('server_version_num')");
        expect(version.startsWith("17")).toBe(true);
        process.stderr.write(`EVIDENCE pg=${version} dbId=${dbId} dbImage=${dbImage}\n`);
        const bootUrl = url("p1as_boot", bootPassword, port, databaseName);
        deploy(historicalRoot, bootUrl);
        psql(names.db, databaseName, "p1as_boot", [
          `CREATE ROLE p1as_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD '${appPassword}'`,
          `CREATE ROLE p1as_other LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD '${otherPassword}'`,
          "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
          "REVOKE USAGE ON SCHEMA public FROM PUBLIC",
          "GRANT USAGE ON SCHEMA public TO p1as_app",
          "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO p1as_app",
          "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO p1as_app",
          'GRANT SELECT ON TABLE public."_prisma_migrations" TO p1as_app',
          "CREATE TABLE public.p1as_probe (id integer PRIMARY KEY)",
          "GRANT SELECT, INSERT ON TABLE public.p1as_probe TO p1as_app",
          `CREATE DATABASE p1as_empty_${runId}`,
          `GRANT CONNECT ON DATABASE p1as_empty_${runId} TO p1as_app`,
          "GRANT CONNECT ON DATABASE postgres TO p1as_app",
        ].join(";\n"));
        expect(psql(names.db, databaseName, "p1as_boot", "SELECT has_schema_privilege('p1as_other', 'public', 'USAGE')::text")).toBe("false");
        expect(psql(names.db, databaseName, "p1as_boot", "SELECT has_schema_privilege('p1as_other', 'public', 'CREATE')::text")).toBe("false");
        const historicalHistory = inventory(names.db, databaseName);
        expect(historicalHistory.split("\n").filter(Boolean)).toHaveLength(45);
        const appUrl = url("p1as_app", appPassword, port, databaseName);
        expect(gate(historicalRoot, appUrl)).toBe(0);
        expect(gate(process.cwd(), appUrl)).not.toBe(0);
        const pendingRoot = path.join(root, "pending");
        fs.cpSync(historicalRoot, pendingRoot, { recursive: true });
        fs.rmSync(path.join(pendingRoot, "prisma", "migrations", "20260629154204_init"), { recursive: true, force: true });
        expect(gate(pendingRoot, appUrl)).not.toBe(0);
        const originalFinished = psql(names.db, databaseName, "p1as_boot", `SELECT finished_at::text FROM public."_prisma_migrations" WHERE migration_name = '20260629154204_init'`);
        psql(names.db, databaseName, "p1as_boot", `UPDATE public."_prisma_migrations" SET finished_at = NULL, applied_steps_count = 0 WHERE migration_name = '20260629154204_init'`);
        expect(gate(historicalRoot, appUrl)).not.toBe(0);
        psql(names.db, databaseName, "p1as_boot", `UPDATE public."_prisma_migrations" SET finished_at = '${originalFinished}', applied_steps_count = 1 WHERE migration_name = '20260629154204_init'`);
        expect(inventory(names.db, databaseName)).toBe(historicalHistory);
        expect(gate(historicalRoot, url("p1as_app", appPassword, port, `p1as_empty_${runId}`))).not.toBe(0);
        deploy(fullRoot, bootUrl);
        historyAfterP1 = inventory(names.db, databaseName);
        expect(historyAfterP1.split("\n").filter(Boolean)).toHaveLength(46);
        expect(gate(historicalRoot, appUrl)).toBe(0);
        expect(gate(fullRoot, appUrl)).toBe(0);
        expect(gate(fullRoot, url("p1as_app", appPassword, port, "postgres"))).not.toBe(0);
        expect(gate(fullRoot, url("p1as_boot", bootPassword, port, databaseName))).not.toBe(0);
        expect(gate(fullRoot, url("p1as_other", otherPassword, port, databaseName))).not.toBe(0);
        psql(names.db, databaseName, "p1as_app", "INSERT INTO public.p1as_probe (id) VALUES (1)");
        expect(psql(names.db, databaseName, "p1as_app", "SELECT id::text FROM public.p1as_probe")).toBe("1");
        docker(["build", "-f", "docker/app-only-startup/Dockerfile", "-t", names.image, "."]);
        appImage = docker(["image", "inspect", "--format", "{{.Id}}", names.image]);
        expect(appImage).toMatch(/^sha256:[0-9a-f]{64}$/);
        process.stderr.write(`EVIDENCE appImage=${appImage}\n`);
        appId = docker([
          "run", "-d", "--pull", "never", "--restart", "no", "--name", names.app,
          "--network", names.network, "--label", `${LABEL}=${runId}`,
          "-e", `DATABASE_URL=postgresql://p1as_app:${appPassword}@db:5432/${databaseName}?schema=public`,
          "-e", `SESSION_SECRET=${sessionSecret}`, "-e", "PORT=3000",
          names.image,
        ]);
        waitHealth(names.app);
        const privileges = psql(names.db, databaseName, "p1as_boot", "SELECT rolsuper::text || ',' || rolcreatedb::text || ',' || rolcreaterole::text || ',' || rolreplication::text || ',' || rolbypassrls::text || ',' || has_schema_privilege('p1as_app','public','CREATE')::text FROM pg_roles WHERE rolname = 'p1as_app'");
        process.stderr.write(`EVIDENCE appId=${appId} privileges=${privileges} historyRows=${historyAfterP1.split("\n").filter(Boolean).length} health=200\n`);
        expect(inventory(names.db, databaseName)).toBe(historyAfterP1);
        docker(["restart", names.app]);
        waitHealth(names.app);
        const logs = docker(["logs", names.app]);
        expect(logs).not.toContain("migrate deploy");
        expect(logs).not.toContain("Applying migration");
        expect(inventory(names.db, databaseName)).toBe(historyAfterP1);
        psql(names.db, databaseName, "p1as_boot", "REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM p1as_app");
        expect(psql(names.db, databaseName, "p1as_app", "SELECT id::text FROM public.p1as_probe")).toBe("1");
        const denied = spawnSync("docker", ["exec", names.db, "psql", "-U", "p1as_app", "-d", databaseName, "-v", "ON_ERROR_STOP=1", "-c", "INSERT INTO public.p1as_probe (id) VALUES (2)"], { encoding: "utf8" });
        expect(denied.status).not.toBe(0);
        waitHealth(names.app);
        const pid = psql(names.db, databaseName, "p1as_boot", "SELECT pid::text FROM pg_stat_activity WHERE usename = 'p1as_app' AND backend_type = 'client backend' LIMIT 1");
        if (pid.length > 0) psql(names.db, databaseName, "p1as_boot", `SELECT pg_terminate_backend(${pid})`);
        waitHealth(names.app);
        expect(psql(names.db, databaseName, "p1as_boot", "SELECT rolsuper::text FROM pg_roles WHERE rolname = 'p1as_app'")).toBe("false");
        expect(inventory(names.db, databaseName)).toBe(historyAfterP1);
        if (daemonId() !== daemonAtStart) throw new Error("daemon changed before cleanup");
        const wrong = appOnlyCleanupAllowed({
          expectedId: appId, expectedName: names.app, expectedImageId: "sha256:" + "0".repeat(64),
          runId, labelKey: LABEL, name: `/${names.app}`, id: appId, imageId: appImage,
          labels: { [LABEL]: runId },
        });
        expect(wrong).toMatchObject({ code: "IMAGE_MISMATCH" });
        expect(docker(["inspect", "--format", "{{.Id}}", names.app]).length).toBe(64);
      } finally {
        const cleanupErrors: string[] = [];
        const quiet = (args: readonly string[]) => {
          const child = spawnSync("docker", [...args], { encoding: "utf8" });
          if (child.status !== 0) cleanupErrors.push(`${args[0]} ${child.stderr || child.stdout}`.slice(0, 200));
        };
        removeOwned(names.app, appId, appImage, runId);
        removeOwned(names.db, dbId, dbImage, runId);
        if (volumeCreated && daemonId() === daemonAtStart) quiet(["volume", "rm", names.volume]);
        if (networkId && daemonId() === daemonAtStart) quiet(["network", "rm", names.network]);
        quiet(["image", "rm", names.image]);
        fs.rmSync(root, { recursive: true, force: true });
        if (cleanupErrors.length > 0 && !cleanupErrors.every((line) => line.includes("No such"))) {
          process.stderr.write(`${cleanupErrors.join("\n")}\n`);
        }
      }
    },
    1_500_000,
  );
});

function materialize(destination: string, includeP1: boolean): void {
  const listed = spawnSync("git", ["ls-files", "prisma/schema.prisma", "prisma/migrations"], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error("git ls-files failed");
  for (const relative of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!includeP1 && relative.includes("20261010210000_psr_p3_s2_b_batch_receipt_provenance")) continue;
    const shown = spawnSync("git", ["show", `HEAD:${relative}`], { encoding: "buffer" });
    if (shown.status !== 0) throw new Error(`git show failed for ${relative}`);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, shown.stdout);
  }
}

function deploy(repositoryRoot: string, databaseUrl: string): void {
  const child = spawnSync("npx", ["prisma", "migrate", "deploy", "--schema", path.join(repositoryRoot, "prisma", "schema.prisma")], {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (child.status !== 0) throw new Error(`migrate deploy failed: ${(child.stderr || child.stdout).slice(0, 500)}`);
}

function gate(repositoryRoot: string, databaseUrl: string): number | null {
  const child = spawnSync("npx", ["tsx", "src/server/internal/p1-app-only-startup/run.ts"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    env: { ...process.env, DATABASE_URL: databaseUrl, APP_ONLY_REPOSITORY_ROOT: repositoryRoot },
  });
  const combined = `${child.stdout}\n${child.stderr}`;
  if (combined.includes(databaseUrl) || combined.toLowerCase().includes("password=")) throw new Error("startup gate leaked a credential");
  if (child.status !== 0) process.stderr.write(`gate ${repositoryRoot === process.cwd() ? "cwd" : path.basename(repositoryRoot)} ${(child.stderr ?? "").trim()}\n`);
  return child.status;
}

function inventory(container: string, databaseName: string): string {
  return psql(container, databaseName, "p1as_boot", `SELECT migration_name || '|' || checksum || '|' || COALESCE(finished_at::text,'') || '|' || applied_steps_count::text FROM public."_prisma_migrations" ORDER BY migration_name`);
}

function url(user: string, password: string, port: string, databaseName: string): string {
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${databaseName}?schema=public`;
}

function hostPort(container: string): string {
  const binding = docker(["port", container, "5432/tcp"]);
  const port = binding.split(":").pop()?.trim() ?? "";
  if (!/^[0-9]+$/.test(port)) throw new Error("database port was not published on localhost");
  return port;
}

function waitReady(container: string, databaseName: string): void {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const state = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", container], { encoding: "utf8", timeout: 15_000 });
    if (state.status !== 0 || state.stdout.trim() !== "running") {
      const logs = spawnSync("docker", ["logs", "--tail", "40", container], { encoding: "utf8", timeout: 15_000 });
      throw new Error(`database container ${state.stdout.trim() || "missing"}: ${(logs.stderr || logs.stdout).slice(-800)}`);
    }
    const child = spawnSync("docker", ["exec", container, "psql", "-U", "p1as_boot", "-d", databaseName, "-At", "-c", "SELECT 1"], { encoding: "utf8", timeout: 15_000 });
    if (child.status === 0) return;
    spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);"]);
  }
  const logs = spawnSync("docker", ["logs", "--tail", "40", container], { encoding: "utf8", timeout: 15_000 });
  throw new Error(`disposable database did not become ready: ${(logs.stderr || logs.stdout).slice(-800)}`);
}

function waitHealth(container: string): void {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const child = spawnSync("docker", ["exec", container, "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], { encoding: "utf8", timeout: 15_000 });
    if (child.status === 0) return;
    spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);"]);
  }
  const logs = spawnSync("docker", ["logs", "--tail", "80", container], { encoding: "utf8", timeout: 15_000 });
  const state = spawnSync("docker", ["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}} {{.State.Error}}", container], { encoding: "utf8", timeout: 15_000 });
  throw new Error(`health did not return 200: ${state.stdout.trim()} ${(logs.stderr || logs.stdout).slice(-1200)}`);
}

function psql(container: string, databaseName: string, user: string, sql: string): string {
  const child = spawnSync("docker", ["exec", "-i", container, "psql", "-U", user, "-d", databaseName, "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (child.status !== 0) throw new Error((child.stderr || child.stdout).slice(0, 500));
  return child.stdout.trim();
}

function daemonId(): string {
  return docker(["info", "--format", "{{.ID}}"]);
}

function docker(args: readonly string[]): string {
  const child = spawnSync("docker", [...args], { encoding: "utf8", windowsHide: true, timeout: 1_200_000, maxBuffer: 16 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`${args[0]} failed: ${(child.stderr || child.stdout || child.error?.message || "").slice(-2500)}`);
  return child.stdout.trim();
}

function removeOwned(name: string, id: string, imageId: string, runId: string): void {
  if (id.length === 0) return;
  const inspected = spawnSync("docker", ["inspect", id], { encoding: "utf8" });
  if (inspected.status !== 0) return;
  const document = JSON.parse(inspected.stdout)[0] as { Id: string; Name: string; Image: string; Config?: { Labels?: Record<string, string> } };
  const allowed = appOnlyCleanupAllowed({
    expectedId: id,
    expectedName: name,
    expectedImageId: imageId,
    runId,
    labelKey: LABEL,
    name: document.Name,
    id: document.Id,
    imageId: document.Image,
    labels: document.Config?.Labels ?? {},
  });
  if (!allowed.ok) return;
  spawnSync("docker", ["rm", "-f", id], { encoding: "utf8" });
}
