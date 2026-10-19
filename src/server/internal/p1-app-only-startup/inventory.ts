import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ImageMigration = {
  name: string;
  sha256: string;
};

const IMAGE_ROOT = "/app";

/**
 * CRLF becomes LF. A carriage return that is not part of CRLF is rejected.
 * Other bytes are hashed unchanged.
 */
export function migrationSha256(bytes: Buffer): string {
  const normalized = Buffer.alloc(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 13) {
      if (bytes[index + 1] !== 10) throw new Error("STANDALONE_CR");
      continue;
    }
    normalized[length] = byte;
    length += 1;
  }
  return createHash("sha256").update(normalized.subarray(0, length)).digest("hex");
}

export function resolveInventoryRoot(env: Readonly<Record<string, string | undefined>>): { ok: true; root: string } | { ok: false; code: string } {
  const override = present(env.APP_ONLY_REPOSITORY_ROOT) ?? present(env.APP_ONLY_STARTUP_FIXTURE_ROOT);
  const fixture = env.APP_ONLY_STARTUP_FIXTURE;
  if (env.NODE_ENV === "production") {
    if (override !== undefined || fixture !== undefined) return { ok: false, code: "MIGRATION_HISTORY_UNVERIFIABLE" };
    return { ok: true, root: IMAGE_ROOT };
  }
  if (present(env.APP_ONLY_REPOSITORY_ROOT) !== undefined) return { ok: false, code: "MIGRATION_HISTORY_UNVERIFIABLE" };
  if (fixture !== undefined || present(env.APP_ONLY_STARTUP_FIXTURE_ROOT) !== undefined) {
    if (fixture !== "test" || present(env.APP_ONLY_STARTUP_FIXTURE_ROOT) === undefined) {
      return { ok: false, code: "MIGRATION_HISTORY_UNVERIFIABLE" };
    }
    return { ok: true, root: env.APP_ONLY_STARTUP_FIXTURE_ROOT ?? "" };
  }
  return { ok: true, root: process.cwd() };
}

function present(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return value;
}

export function readImageMigrations(repositoryRoot: string): ImageMigration[] {
  const root = path.join(repositoryRoot, "prisma", "migrations");
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("prisma migrations directory is missing");
  }
  const names = fs
    .readdirSync(root)
    .filter((name) => fs.existsSync(path.join(root, name, "migration.sql")))
    .sort();
  return names.map((name) => ({
    name,
    sha256: migrationSha256(fs.readFileSync(path.join(root, name, "migration.sql"))),
  }));
}
