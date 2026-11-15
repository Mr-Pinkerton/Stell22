import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MIGRATION_NAME,
  MIGRATION_SHA256,
  readMigrationInventory,
} from "./internal/statement-period-release/decide.mjs";

const live = process.env.P1_DISPOSABLE_LIVE === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts", "beget-statement-migration-only.sh");
const productionImage = "postgres@sha256:005c5c37db96c1e6652a79ea31f9886402fba81ac95dc2db897739121dd7f8f2";

function run(command: string, args: readonly string[], input?: string, timeout = 60_000): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: "utf8", input, timeout, windowsHide: true });
}

function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret) output = output.split(secret).join("[redacted]");
  }
  return output.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]").slice(0, 1200);
}

function docker(args: readonly string[], secrets: readonly string[], input?: string, timeout = 60_000): string {
  const result = run("docker", args, input, timeout);
  if (result.status !== 0) {
    throw new Error(redact(`${result.stderr}\n${result.stdout}`, secrets));
  }
  return result.stdout;
}

function ids(args: readonly string[]): string[] {
  const result = run("docker", args);
  if (result.status !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).sort();
}

describe.skipIf(!live)("disposable PostgreSQL 17 statement migration", () => {
  it("applies migration 48 once through the operator", { timeout: 1_200_000 }, () => {
    const suffix = randomBytes(4).toString("hex");
    const database = `p1disp_migonly_${suffix}`;
    const project = `p1disp_migonly_${suffix}`;
    const volume = `p1disp_migonly_${suffix}_data`;
    const network = `p1disp_migonly_${suffix}_net`;
    const container = `p1disp_migonly_${suffix}_db`;
    const adminPassword = randomBytes(24).toString("hex");
    const migratorPassword = randomBytes(24).toString("hex");
    const secrets = [adminPassword, migratorPassword];
    const inventory = readMigrationInventory(path.join(repoRoot, "prisma", "migrations")) as Array<{ name: string; sha256: string }>;
    const target = inventory.find((row) => row.name === MIGRATION_NAME);
    expect(target?.sha256).toBe(MIGRATION_SHA256);
    expect(inventory).toHaveLength(48);
    const beforeNames = ids(["ps", "-a", "--format", "{{.Names}}"]);
    const beforeVolumes = ids(["volume", "ls", "-q"]);
    const beforeNetworks = ids(["network", "ls", "-q"]);
    const beforeImages = ids(["image", "ls", "-q", "--no-trunc"]);
    let createdContainer = false;
    let createdVolume = false;
    let createdNetwork = false;
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-migration-only-"));
    fs.chmodSync(state, 0o700);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-migration-git-"));
    try {
      fs.writeFileSync(path.join(projectDir, "README"), "synthetic migration project\n");
      const git = run("git", ["-C", projectDir, "init", "-q"]);
      if (git.status !== 0) throw new Error(git.stderr);
      const commit = run("git", ["-C", projectDir, "-c", "user.email=stell22-test@example.com", "-c", "user.name=stell22-test", "add", "README"]);
      if (commit.status !== 0) throw new Error(commit.stderr);
      const committed = run("git", ["-C", projectDir, "-c", "user.email=stell22-test@example.com", "-c", "user.name=stell22-test", "commit", "-q", "-m", "init"]);
      if (committed.status !== 0) throw new Error(committed.stderr);
      const sha = run("git", ["-C", projectDir, "rev-parse", "HEAD"]).stdout.trim();
      const tree = run("git", ["-C", projectDir, "rev-parse", "HEAD^{tree}"]).stdout.trim();
      docker(["volume", "create", volume], secrets);
      createdVolume = true;
      docker(["network", "create", network], secrets);
      createdNetwork = true;
      docker([
        "run", "-d", "--name", container, "--network", network,
        "-v", `${volume}:/var/lib/postgresql/data`,
        "-e", "POSTGRES_USER=stell22",
        "-e", `POSTGRES_PASSWORD=${adminPassword}`,
        "-e", `POSTGRES_DB=${database}`,
        "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
        "--health-cmd", `PGAPPNAME=stell22-statement-inspect pg_isready -U stell22 -d ${database}`,
        "--health-interval", "30s",
        "--health-timeout", "5s",
        "--health-retries", "10",
        "--health-start-period", "5s",
        "--label", `com.docker.compose.project=${project}`,
        "--label", "com.docker.compose.service=db",
        "--label", "com.docker.compose.oneoff=False",
        "postgres:17-alpine",
      ], secrets);
      createdContainer = true;
      let healthy = "";
      for (let attempt = 0; attempt < 40 && healthy !== "healthy"; attempt += 1) {
        healthy = run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}", container]).stdout.trim();
        if (healthy !== "healthy") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
      expect(healthy).toBe("healthy");
      const version = docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SHOW server_version_num"], secrets).trim();
      expect(version.startsWith("17")).toBe(true);
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT current_database()"], secrets).trim()).toBe(database);
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT current_user"], secrets).trim()).toBe("stell22");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT count(*) FROM pg_roles WHERE rolname = 'postgres'"], secrets).trim()).toBe("0");
      const image = docker(["inspect", "--format", "{{.Config.Image}}", container], secrets).trim();
      expect(image).not.toBe(productionImage);
      expect(docker(["inspect", "--format", "{{json .HostConfig.PortBindings}}", container], secrets).trim()).toMatch(/^(\{\}|null)$/);
      const values = inventory
        .filter((row) => row.name !== MIGRATION_NAME)
        .map((row) => `('${randomBytes(16).toString("hex")}', '${row.sha256}', NOW(), '${row.name}', NOW(), 1)`)
        .join(",\n");
      const seed = `
CREATE ROLE stell22_migrator LOGIN NOSUPERUSER PASSWORD '${migratorPassword}';
CREATE ROLE stell22_app LOGIN NOSUPERUSER PASSWORD '${randomBytes(24).toString("hex")}';
GRANT CONNECT ON DATABASE "${database}" TO stell22_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO stell22_migrator;
CREATE TABLE "Statement" (
  "id" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "accountId" TEXT,
  "fileUrl" TEXT,
  "uploadedAt" TIMESTAMP(3),
  CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);
INSERT INTO "Statement" ("id", "date") VALUES
  ('synthetic-1', TIMESTAMP '2026-10-01 00:00:00'),
  ('synthetic-2', TIMESTAMP '2026-10-02 00:00:00');
CREATE TABLE "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "_prisma_migrations"
  ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
VALUES
${values};
ALTER TABLE "Statement" OWNER TO stell22_migrator;
ALTER TABLE "_prisma_migrations" OWNER TO stell22_migrator;
`;
      docker(["exec", "-i", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], secrets, seed);
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count = 1"], secrets).trim()).toBe("47");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL"], secrets).trim()).toBe("0");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", `SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}'`], secrets).trim()).toBe("0");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT count(*) FROM \"Statement\""], secrets).trim()).toBe("2");
      const recovery = path.join(state, "beget-recovery.state");
      const credentials = path.join(state, "credentials.env");
      const attempt = path.join(state, "beget-migration-only.state");
      fs.writeFileSync(recovery, `phase=READY\nvolume=${volume}\ncontainer=${container}\n`, { mode: 0o600 });
      fs.writeFileSync(credentials, `STELL22_BEGET_RECOVERY_MIGRATOR_PASSWORD=${migratorPassword}\n`, { mode: 0o600 });
      fs.chmodSync(recovery, 0o600);
      fs.chmodSync(credentials, 0o600);
      const invoke = () => spawnSync("sh", [scriptPath], {
        encoding: "utf8",
        timeout: 900_000,
        windowsHide: true,
        env: {
          ...process.env,
          STELL22_BEGET_MIGRATION_EXECUTE: "1",
          STELL22_BEGET_MIGRATION_AUTHORIZATION: "OWNER_AUTHORIZES_BEGET_MIGRATION_HARNESS",
          STELL22_BEGET_MIGRATION_HARNESS: "1",
          STELL22_BEGET_MIGRATION_SCOPE: MIGRATION_NAME,
          STELL22_BEGET_MIGRATION_SHA: sha,
          STELL22_BEGET_MIGRATION_TREE: tree,
          STELL22_BEGET_MIGRATION_PROJECT: projectDir,
          STELL22_BEGET_MIGRATION_STATE: state,
          STELL22_BEGET_MIGRATION_RECOVERY_STATE: recovery,
          STELL22_BEGET_MIGRATION_ATTEMPT: attempt,
          STELL22_BEGET_MIGRATION_CREDENTIALS: credentials,
          STELL22_BEGET_MIGRATION_COMPOSE_PROJECT: project,
          STELL22_BEGET_MIGRATION_VOLUME: volume,
          STELL22_BEGET_MIGRATION_CONTAINER: container,
          STELL22_BEGET_MIGRATION_NETWORK: network,
          STELL22_BEGET_MIGRATION_DATABASE: database,
          STELL22_BEGET_MIGRATION_EXPECT_IMAGE: image,
        },
      });
      const first = invoke();
      const failureLog = fs.existsSync(path.join(state, "beget-migration-only.log"))
        ? fs.readFileSync(path.join(state, "beget-migration-only.log"), "utf8")
        : "";
      expect(first.status, redact(`${first.stdout}\n${first.stderr}\n${failureLog}`, secrets)).toBe(0);
      expect(first.stdout).toContain("RESULT=MIGRATION_READY");
      expect(first.stdout).toContain("MIGRATIONS_AFTER=48");
      expect(first.stdout).toContain("APPLICATION_STARTED=NO");
      expect(first.stdout).toContain("CADDY_STARTED=NO");
      expect(first.stdout).not.toContain(migratorPassword);
      const migrationLog = fs.readFileSync(path.join(state, "beget-migration-only.log"), "utf8");
      expect(migrationLog).toContain(MIGRATION_NAME);
      expect(migrationLog).not.toContain(migratorPassword);
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count = 1"], secrets).trim()).toBe("48");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL"], secrets).trim()).toBe("0");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", `SELECT checksum FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}'`], secrets).trim()).toBe(MIGRATION_SHA256);
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT count(*) FROM \"Statement\""], secrets).trim()).toBe("2");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT column_name || '|' || is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Statement' AND column_name IN ('periodStart', 'periodEnd', 'source', 'contentKey') ORDER BY column_name"], secrets).trim()).toBe("contentKey|YES\nperiodEnd|YES\nperiodStart|YES\nsource|YES");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Statement_accountId_contentKey_key'"], secrets).trim()).toBe("1");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'Statement_verified_period_check'"], secrets)).toContain("BANK_1C");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT pg_get_userbyid(typowner) FROM pg_type WHERE typname = 'StatementSource'"], secrets).trim()).toBe("stell22_migrator");
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT rolsuper FROM pg_roles WHERE rolname = 'stell22_migrator'"], secrets).trim()).toBe("f");
      const names = docker(["ps", "-a", "--format", "{{.Names}}"], secrets);
      expect(names).not.toContain("stell22-app");
      expect(names).not.toContain("stell22-caddy");
      const duringNames = ids(["ps", "-a", "--format", "{{.Names}}"]);
      expect(beforeNames.filter((name) => !duringNames.includes(name))).toEqual([]);
      expect(duringNames.filter((name) => !beforeNames.includes(name))).toEqual([container]);
      expect(beforeVolumes.every((id) => ids(["volume", "ls", "-q"]).includes(id))).toBe(true);
      expect(beforeNetworks.every((id) => ids(["network", "ls", "-q"]).includes(id))).toBe(true);
      expect(beforeImages.every((id) => ids(["image", "ls", "-q", "--no-trunc"]).includes(id))).toBe(true);
      const logBefore = createHash("sha256").update(migrationLog).digest("hex");
      const second = invoke();
      expect(second.status).not.toBe(0);
      expect(second.stdout).toContain("RESULT=REFUSED_EXISTING_ATTEMPT");
      expect(second.stdout).toContain("APPLICATION_STARTED=NO");
      expect(second.stdout).toContain("CADDY_STARTED=NO");
      expect(createHash("sha256").update(fs.readFileSync(path.join(state, "beget-migration-only.log"))).digest("hex")).toBe(logBefore);
      expect(docker(["exec", container, "psql", "-X", "-U", "stell22", "-d", database, "-q", "-At", "-c", "SELECT count(*) FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"], secrets).trim()).toBe("48");
    } finally {
      if (createdContainer) run("docker", ["rm", "-f", container]);
      if (createdVolume) run("docker", ["volume", "rm", "-f", volume]);
      if (createdNetwork) run("docker", ["network", "rm", network]);
      run("docker", ["image", "rm", "-f", "stell22-beget-migration-only-harness:candidate"]);
      fs.rmSync(state, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
