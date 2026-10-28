import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChildEnv } from "@/server/internal/p1-isolated-runner/env";
import {
  assertOutsideRepository,
  DisposableMigrateRefusal,
  parseDisposableDatabaseUrl,
} from "../../../../scripts/disposable-migrate-guard.mjs";

export { DisposableMigrateRefusal, parseDisposableDatabaseUrl, assertOutsideRepository };

export type DisposableTarget = {
  database: string;
  port: number;
  host: string;
  href: string;
};

export type DisposableMigrateRequest = {
  databaseUrl: string | undefined;
  cwd: string;
  schemaPath: string;
  repositoryRoot: string;
  parentEnv?: Readonly<Record<string, string | undefined>>;
  probe?: (target: DisposableTarget) => { currentDatabase: string };
  spawn?: (request: {
    args: readonly string[];
    cwd: string;
    env: Record<string, string>;
  }) => { status: number | null };
};

const PROBE_SOURCE = `
const { PrismaClient } = require(process.argv[2]);
const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
prisma.$transaction(async (tx) => {
  await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
  const rows = await tx.$queryRawUnsafe("SELECT current_database() AS name");
  const name = rows && rows[0] && rows[0].name;
  if (typeof name !== "string" || name.length === 0) process.exit(2);
  process.stdout.write(name);
}).then(() => prisma.$disconnect()).catch(() => {
  prisma.$disconnect().finally(() => process.exit(1));
});
`;

export function probeCurrentDatabase(databaseUrl: string, repositoryRoot: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-migrate-probe-"));
  const script = path.join(directory, "probe.cjs");
  fs.writeFileSync(script, PROBE_SOURCE);
  try {
    const child = spawnSync(
      process.execPath,
      [script, path.join(repositoryRoot, "node_modules", "@prisma", "client")],
      {
        cwd: directory,
        env: buildChildEnv(process.env, databaseUrl) as NodeJS.ProcessEnv,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const name = (child.stdout ?? "").trim();
    if (child.status !== 0 || name.length === 0) {
      throw new DisposableMigrateRefusal(
        "IDENTITY_UNCONFIRMED",
        "Read-only database identity query failed",
      );
    }
    return name;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Structural refusal happens before the identity query.
 * The identity query happens before Prisma is spawned.
 */
export function runDisposableMigrate(options: DisposableMigrateRequest): { status: number | null } {
  const target = parseDisposableDatabaseUrl(options.databaseUrl);
  assertOutsideRepository(options.cwd, options.repositoryRoot);
  assertOutsideRepository(options.schemaPath, options.repositoryRoot);
  const probe = options.probe ?? ((ready) => ({
    currentDatabase: probeCurrentDatabase(ready.href, options.repositoryRoot),
  }));
  const identity = probe(target);
  if (identity.currentDatabase.trim().toLowerCase() !== target.database) {
    throw new DisposableMigrateRefusal(
      "IDENTITY_MISMATCH",
      "Connected database does not match the disposable DATABASE_URL",
    );
  }
  const prismaCli = path.join(options.repositoryRoot, "node_modules", "prisma", "build", "index.js");
  const env = buildChildEnv(options.parentEnv ?? process.env, target.href);
  const spawn = options.spawn ?? ((request) => {
    const child = spawnSync(process.execPath, [...request.args], {
      cwd: request.cwd,
      env: request.env as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (child.status !== 0) {
      const detail = `${child.stdout ?? ""}\n${child.stderr ?? ""}`
        .replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]")
        .slice(0, 500);
      throw new DisposableMigrateRefusal("MIGRATE_FAILED", `Disposable prisma migrate deploy failed: ${detail}`);
    }
    return { status: child.status };
  });
  return spawn({
    args: [prismaCli, "migrate", "deploy", "--schema", options.schemaPath],
    cwd: options.cwd,
    env,
  });
}
