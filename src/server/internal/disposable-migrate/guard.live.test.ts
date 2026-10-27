import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DisposableMigrateRefusal, runDisposableMigrate } from "@/server/internal/disposable-migrate/guard";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";

describe.skipIf(!LIVE)("disposable migrate guard live", () => {
  it("applies a migration only after the disposable identity matches", () => {
    const runId = randomBytes(4).toString("hex");
    const database = `p1iso_${runId}`;
    const password = randomBytes(16).toString("hex");
    const container = `p1iso-db-${runId}`;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "p1iso-migrate-"));
    fs.mkdirSync(path.join(cwd, "prisma", "migrations", "20261027120000_init"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".env"), "DATABASE_URL=postgresql://blocked@127.0.0.1:1/stell22_dev\n");
    fs.writeFileSync(path.join(cwd, "prisma", "schema.prisma"), `datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n\ngenerator client {\n  provider = "prisma-client-js"\n}\n\nmodel P1IsoProbe {\n  id Int @id\n}\n`);
    fs.writeFileSync(path.join(cwd, "prisma", "migrations", "20261027120000_init", "migration.sql"), `CREATE TABLE "P1IsoProbe" (\n  "id" INTEGER NOT NULL,\n  CONSTRAINT "P1IsoProbe_pkey" PRIMARY KEY ("id")\n);\n`);
    let started = false;
    try {
      const created = spawnSync("docker", [
        "run", "-d", "--rm", "--name", container,
        "-e", "POSTGRES_USER=p1iso",
        "-e", `POSTGRES_PASSWORD=${password}`,
        "-e", `POSTGRES_DB=${database}`,
        "-p", "127.0.0.1::5432",
        "postgres:17-alpine",
      ], { encoding: "utf8" });
      if (created.status !== 0) throw new Error(created.stderr.slice(0, 400));
      started = true;
      const port = spawnSync("docker", ["inspect", "--format", "{{(index (index .NetworkSettings.Ports \"5432/tcp\") 0).HostPort}}", container], { encoding: "utf8" }).stdout.trim();
      expect(port).toMatch(/^[0-9]+$/);
      expect(["5432", "5433", "5434"].includes(port)).toBe(false);
      let ready = "";
      for (let attempt = 0; attempt < 30 && ready === ""; attempt += 1) {
        const probe = spawnSync("docker", ["exec", "-e", `PGPASSWORD=${password}`, container, "psql", "-X", "-U", "p1iso", "-d", database, "-q", "-At", "-c", "SELECT current_database()"], { encoding: "utf8" });
        if (probe.status === 0) ready = probe.stdout.trim();
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      }
      expect(ready).toBe(database);
      const url = `postgresql://p1iso:${password}@127.0.0.1:${port}/${database}?schema=public`;
      let spawned = false;
      expect(() => runDisposableMigrate({
        databaseUrl: url,
        cwd,
        schemaPath: path.join(cwd, "prisma", "schema.prisma"),
        repositoryRoot: process.cwd(),
        probe: () => ({ currentDatabase: "stell22_dev" }),
        spawn: () => {
          spawned = true;
          return { status: 0 };
        },
      })).toThrow(DisposableMigrateRefusal);
      expect(spawned).toBe(false);
      runDisposableMigrate({
        databaseUrl: url,
        cwd,
        schemaPath: path.join(cwd, "prisma", "schema.prisma"),
        repositoryRoot: process.cwd(),
      });
      const rows = spawnSync("docker", ["exec", "-e", `PGPASSWORD=${password}`, container, "psql", "-X", "-U", "p1iso", "-d", database, "-q", "-At", "-c", "SELECT count(*)::text FROM public.\"P1IsoProbe\""], { encoding: "utf8" });
      expect(rows.status).toBe(0);
      expect(rows.stdout.trim()).toBe("0");
    } finally {
      if (started) spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
