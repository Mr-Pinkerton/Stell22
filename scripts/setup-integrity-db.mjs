/**
 * Create stell22_integrity from scratch, apply schema via prisma migrate deploy only
 * (never db push), then run the integrity Vitest suite with DATABASE_URL
 * pointed at that database so importStatementInternal uses it.
 *
 * Always DROP/CREATE stell22_integrity so revised migration SQL actually runs.
 * Does not touch the app database `stell22`.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cwd = realpathSync.native(root);

const DEFAULT_URL =
  "postgresql://stell22:stell22@localhost:5434/stell22_integrity?schema=public";
const url = process.env.INTEGRITY_TEST_DATABASE_URL || DEFAULT_URL;

function fail(message, extra) {
  console.error(message);
  if (extra) console.error(extra);
  process.exit(1);
}

try {
  const parsed = new URL(url);
  const db = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] ?? "");
  if (db !== "stell22_integrity") {
    fail(`INTEGRITY_TEST_DATABASE_URL database must be stell22_integrity, got "${db}"`);
  }
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    fail(`INTEGRITY_TEST_DATABASE_URL host must be local, got ${parsed.hostname}`);
  }
} catch (err) {
  fail("INTEGRITY_TEST_DATABASE_URL is not a valid URL", err);
}

function dockerPsql(database, sql) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      "stell22",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      sql,
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) {
    fail(`psql failed on ${database}`, `${result.stdout}\n${result.stderr}`);
  }
  return (result.stdout ?? "").trim();
}

// Recreate so revised migration.sql (explicit BEGIN/COMMIT) is applied from scratch.
// Never touch the app DB `stell22`.
dockerPsql(
  "stell22",
  "DROP DATABASE IF EXISTS stell22_integrity WITH (FORCE)",
);
dockerPsql("stell22", "CREATE DATABASE stell22_integrity");

const prismaCli = path.join(cwd, "node_modules", "prisma", "build", "index.js");
const migrate = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
  cwd,
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: url },
});
if (migrate.status !== 0) {
  fail("prisma migrate deploy failed on integrity DB", `${migrate.stdout}\n${migrate.stderr}`);
}

const vitestBin = path.join(cwd, "node_modules", "vitest", "vitest.mjs");
const vitest = spawnSync(
  process.execPath,
  [vitestBin, "run", "--config", "vitest.integrity.config.ts"],
  {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      INTEGRITY_TEST_DATABASE_URL: url,
      DATABASE_URL: url,
    },
  },
);
process.exit(vitest.status ?? 1);
