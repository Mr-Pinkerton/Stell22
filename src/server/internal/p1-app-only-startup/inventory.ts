import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ImageMigration = {
  name: string;
  sha256: string;
};

export function migrationSha256(bytes: Buffer): string {
  const stripped = Buffer.alloc(bytes.length);
  let length = 0;
  for (const byte of bytes) {
    if (byte !== 13) stripped[length++] = byte;
  }
  return createHash("sha256").update(stripped.subarray(0, length)).digest("hex");
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
