import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const INTEGRITY_DATABASE_NAME = "stell22_integrity";

export function integrityDatabaseUrl(): string {
  const url = process.env.INTEGRITY_TEST_DATABASE_URL;
  if (!url) {
    throw new Error("INTEGRITY_TEST_DATABASE_URL is not set");
  }
  return url;
}

export function assertSafeIntegrityUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("INTEGRITY_TEST_DATABASE_URL is not a valid URL");
  }
  const db = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] ?? "");
  if (db !== INTEGRITY_DATABASE_NAME) {
    throw new Error(
      `Refusing integrity URL database "${db}"; must be ${INTEGRITY_DATABASE_NAME}`,
    );
  }
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error(`Refusing non-local integrity host ${parsed.hostname}`);
  }
}

let schemaReady = false;

export function ensureIntegritySchema(): void {
  if (schemaReady) return;
  const url = integrityDatabaseUrl();
  assertSafeIntegrityUrl(url);
  const prismaCli = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");
  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy failed for integrity DB:\n${result.stdout}\n${result.stderr}`,
    );
  }
  schemaReady = true;
}

export function createIntegrityClients(): { prismaA: PrismaClient; prismaB: PrismaClient } {
  const url = integrityDatabaseUrl();
  assertSafeIntegrityUrl(url);
  return {
    prismaA: new PrismaClient({ datasourceUrl: url }),
    prismaB: new PrismaClient({ datasourceUrl: url }),
  };
}

export async function resetIntegrityFinance(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "CashFlow",
      "Statement",
      "Account",
      "Counterparty",
      "ChangeLog",
      "DealItem",
      "Deal",
      "Supply",
      "Sale",
      "MpStock",
      "ProductStock",
      "Product",
      "Material",
      "Batch",
      "Article",
      "ArticleCategory",
      "AutoRule"
    RESTART IDENTITY CASCADE
  `);
}
