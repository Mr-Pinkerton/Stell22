import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATION_NAME, MIGRATION_SHA256 } from "../admin-corrections-release/decide.mjs";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const PREVIOUS_SHA = "c5771f8eca1c21d6111f3705cad94a6a73f37bfe";
const ADMIN_TUPLE = `('${MIGRATION_NAME}', '${MIGRATION_SHA256}')`;

function run(command: string, args: readonly string[], cwd = process.cwd(), input?: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input,
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function must(command: string, args: readonly string[], cwd = process.cwd(), input?: string) {
  const child = run(command, args, cwd, input);
  if (child.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}\n${child.stdout}\n${child.stderr}`.slice(0, 1200));
  }
  return child.stdout.trim();
}

function psql(container: string, database: string, password: string, sql: string) {
  const child = run(
    "docker",
    ["exec", "-i", "-e", `PGPASSWORD=${password}`, container, "psql", "-X", "-U", "p1gate", "-d", database, "-q", "-v", "ON_ERROR_STOP=1", "-At"],
    process.cwd(),
    sql,
  );
  if (child.status !== 0) throw new Error(`${child.stdout}\n${child.stderr}`.slice(0, 1200));
  return child.stdout.trim();
}

function verdict(container: string, database: string, password: string, sql: string) {
  const line = psql(container, database, password, sql)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item === "P1_APPLIED" || item === "P1_BLOCKED");
  if (line.length !== 1) throw new Error(`writer verdict missing: ${line.join(",")}`);
  return line[0];
}

function gateSql() {
  return fs.readFileSync(path.join(process.cwd(), "scripts", "p1-writer-preflight.sql"), "utf8").replace(/\r\n/g, "\n");
}

function mutated(container: string, database: string, password: string, change: string) {
  return verdict(container, database, password, `BEGIN;\n${change}\n${gateSql()};\nROLLBACK;\n`);
}

function git(repo: string, args: readonly string[], input?: string) {
  return must("git", ["-c", "core.autocrlf=false", ...args], repo, input);
}

describe.skipIf(!LIVE)("p1 writer preflight 47-migration inventory", () => {
  it(
    "accepts the exact applied inventory and blocks the previous 46-migration gate",
    () => {
      const runId = randomBytes(4).toString("hex");
      const password = randomBytes(18).toString("hex");
      const database = `p1gate_${runId}`;
      const container = `p1gate-db-${runId}`;
      const trusted = fs.mkdtempSync(path.join(os.tmpdir(), "p1gate-trusted-"));
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), "p1gate-repo-"));
      const cleanups = [trusted, repo];
      let started = false;
      try {
        const image = run("docker", ["image", "inspect", "--format", "{{.Id}}", "postgres:17-alpine"]);
        if (image.status !== 0) must("docker", ["pull", "postgres:17-alpine"]);
        must("docker", [
          "run", "-d", "--pull", "never", "--restart", "no", "--name", container,
          "-p", "127.0.0.1::5432",
          "-e", "POSTGRES_USER=p1gate",
          "-e", `POSTGRES_PASSWORD=${password}`,
          "-e", `POSTGRES_DB=${database}`,
          "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
          "postgres:17-alpine",
        ]);
        started = true;
        let version = "";
        for (let attempt = 0; attempt < 30 && version === ""; attempt += 1) {
          const probe = run("docker", ["exec", "-i", "-e", `PGPASSWORD=${password}`, container, "psql", "-X", "-U", "p1gate", "-d", database, "-q", "-At", "-c", "SELECT current_setting('server_version_num')"]);
          if (probe.status === 0 && String(probe.stdout).trim().startsWith("17")) version = String(probe.stdout).trim();
          else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        }
        if (!version.startsWith("17")) throw new Error("disposable postgres did not become ready");
        const port = must("docker", ["inspect", "--format", "{{(index (index .NetworkSettings.Ports \"5432/tcp\") 0).HostPort}}", container]);
        const containerId = must("docker", ["inspect", "--format", "{{.Id}}", container]);
        const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "p1gate-schema-"));
        cleanups.push(schemaDir);
        for (const name of must("git", ["ls-tree", "-r", "--name-only", "HEAD", "prisma"]).split(/\r?\n/)) {
          if (name !== "prisma/schema.prisma" && !name.startsWith("prisma/migrations/")) continue;
          const shown = spawnSync("git", ["show", `HEAD:${name}`], { cwd: process.cwd(), windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
          if (shown.status !== 0 || !Buffer.isBuffer(shown.stdout)) throw new Error(`git show failed for ${name}`);
          const target = path.join(schemaDir, ...name.split("/"));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, shown.stdout);
        }
        const deploy = spawnSync(process.execPath, [path.join(process.cwd(), "node_modules", "prisma", "build", "index.js"), "migrate", "deploy", "--schema", path.join(schemaDir, "prisma", "schema.prisma")], {
          cwd: schemaDir,
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: `postgresql://p1gate:${password}@127.0.0.1:${port}/${database}?schema=public`,
          },
          windowsHide: true,
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        if (deploy.status !== 0) throw new Error(`${deploy.stdout}\n${deploy.stderr}`.slice(0, 1200));

        const corrected = gateSql();
        expect(corrected).toContain(ADMIN_TUPLE);
        expect(corrected).not.toContain("\r");
        expect(verdict(container, database, password, corrected)).toBe("P1_APPLIED");
        expect(psql(container, database, password, 'SELECT count(*)::text FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).toBe("47");

        expect(mutated(container, database, password, `DELETE FROM public."_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}';`)).toBe("P1_BLOCKED");
        expect(mutated(
          container,
          database,
          password,
          `INSERT INTO public."_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES ('p1gate-extra', '${"ab".repeat(32)}', NOW(), '20261025130100_not_expected', NOW(), 1);`,
        )).toBe("P1_BLOCKED");
        expect(mutated(container, database, password, `UPDATE public."_prisma_migrations" SET checksum = '${"cd".repeat(32)}' WHERE migration_name = '${MIGRATION_NAME}';`)).toBe("P1_BLOCKED");
        expect(mutated(container, database, password, `UPDATE public."_prisma_migrations" SET finished_at = NULL WHERE migration_name = '${MIGRATION_NAME}';`)).toBe("P1_BLOCKED");
        expect(mutated(
          container,
          database,
          password,
          `CREATE OR REPLACE FUNCTION public.batch_creation_command_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RETURN NEW; END; $body$;`,
        )).toBe("P1_BLOCKED");
        expect(mutated(
          container,
          database,
          password,
          `DROP TRIGGER batch_creation_command_provenance_guard ON public."BatchCreationCommand";`,
        )).toBe("P1_BLOCKED");
        expect(verdict(container, database, password, corrected)).toBe("P1_APPLIED");

        const previousGate = must("git", ["show", `${PREVIOUS_SHA}:scripts/p1-writer-preflight.sql`]);
        expect(previousGate).toContain(") = 46");
        expect(previousGate).not.toContain(MIGRATION_NAME);
        expect(verdict(container, database, password, previousGate)).toBe("P1_BLOCKED");
        const previousDeploy = must("git", ["show", `${PREVIOUS_SHA}:scripts/deploy.sh`]);
        expect(previousDeploy).toContain("scripts/p1-writer-preflight.sh");

        fs.writeFileSync(path.join(trusted, "p1-writer-preflight.sql"), corrected);
        const backup = must("git", ["show", `${PREVIOUS_SHA}:scripts/backup-db.sh`]);
        const restore = must("git", ["show", `${PREVIOUS_SHA}:scripts/restore-db.sh`]);
        git(repo, ["init", "-b", "main"]);
        git(repo, ["config", "--local", "core.autocrlf", "false"]);
        git(repo, ["config", "--local", "user.email", "stell22-test@example.com"]);
        git(repo, ["config", "--local", "user.name", "stell22-test"]);
        fs.mkdirSync(path.join(repo, "scripts"));
        fs.writeFileSync(path.join(repo, "scripts", "backup-db.sh"), backup);
        fs.writeFileSync(path.join(repo, "scripts", "restore-db.sh"), restore);
        fs.writeFileSync(path.join(repo, "scripts", "p1-writer-preflight.sql"), previousGate);
        fs.writeFileSync(path.join(repo, "APP_ID"), `${PREVIOUS_SHA}\n`);
        git(repo, ["add", "-A"]);
        git(repo, ["commit", "-m", "previous application"]);
        const previous = git(repo, ["rev-parse", "HEAD"]);
        fs.writeFileSync(path.join(repo, "scripts", "p1-writer-preflight.sql"), corrected);
        fs.writeFileSync(path.join(repo, "APP_ID"), "e6e438078f340e1ea9422ec5efb88cea91342c42\n");
        git(repo, ["add", "-A"]);
        git(repo, ["commit", "-m", "failed release"]);
        git(repo, ["checkout", "--detach", "HEAD"]);
        const serverRestore = `${restore}\n# server-local\n`;
        fs.writeFileSync(path.join(repo, "scripts", "restore-db.sh"), serverRestore);
        const mail = Buffer.from("mail-fixture\n");
        fs.writeFileSync(path.join(repo, "mail.log"), mail);
        const checkout = spawnSync("sh", [path.join(process.cwd(), "scripts", "release-checkout.sh"), previous], {
          cwd: repo,
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "stell22-test",
            GIT_AUTHOR_EMAIL: "stell22-test@example.com",
            GIT_COMMITTER_NAME: "stell22-test",
            GIT_COMMITTER_EMAIL: "stell22-test@example.com",
          },
        });
        expect(checkout.status, `${checkout.stdout}\n${checkout.stderr}`).toBe(0);
        expect(`${checkout.stdout}\n${checkout.stderr}`).toContain("RESULT=CHECKOUT_PRESERVED");
        expect(git(repo, ["rev-parse", "HEAD"])).toBe(previous);
        expect(fs.readFileSync(path.join(repo, "APP_ID"), "utf8")).toBe(`${PREVIOUS_SHA}\n`);
        expect(fs.readFileSync(path.join(repo, "scripts", "restore-db.sh"), "utf8")).toBe(serverRestore);
        expect(fs.readFileSync(path.join(repo, "mail.log"))).toEqual(mail);
        expect(`${checkout.stdout}\n${checkout.stderr}`).not.toContain("mail-fixture");
        expect(fs.readFileSync(path.join(repo, "scripts", "p1-writer-preflight.sql"), "utf8")).toBe(previousGate);
        const trustedSql = fs.readFileSync(path.join(trusted, "p1-writer-preflight.sql"), "utf8");
        expect(verdict(container, database, password, trustedSql)).toBe("P1_APPLIED");
        expect(verdict(container, database, password, fs.readFileSync(path.join(repo, "scripts", "p1-writer-preflight.sql"), "utf8"))).toBe("P1_BLOCKED");
        expect(psql(container, database, password, 'SELECT count(*)::text FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).toBe("47");
        expect(must("docker", ["inspect", "--format", "{{.Id}}", container])).toBe(containerId);
        expect(createHash("sha256").update(trustedSql).digest("hex")).toBe(createHash("sha256").update(corrected).digest("hex"));
      } finally {
        if (started) run("docker", ["rm", "-f", container]);
        for (const directory of cleanups) fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    360_000,
  );
});
