/**
 * Apply schema to a disposable local stell22_integrity database and run the
 * PostgreSQL-backed integrity suite. Used by GitHub CI.
 *
 * Does not use Docker Compose, production databases, or production secrets.
 * Host must be localhost/127.0.0.1 and the database name must be stell22_integrity.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cwd = realpathSync.native(root);
const url = process.env.INTEGRITY_TEST_DATABASE_URL;

function fail(message, extra) {
  console.error(message);
  if (extra) console.error(extra);
  process.exit(1);
}

if (!url) {
  fail("INTEGRITY_TEST_DATABASE_URL is required for test:integrity:ci");
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
