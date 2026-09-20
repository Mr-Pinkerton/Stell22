import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";

if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = "stell22-integrity-test-session-secret";
}

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

/** ChangeLog.userId FK: correction path now records requireAdmin().id. */
export const INTEGRITY_ADMIN_USER_ID = "integrity-admin";

/** Explicit SHADOW OFF for helper-level integrity tests. Undefined is not OFF. */
export function integritySupplyShadowOff() {
  return {
    active: false as const,
    actor: userMovementActorFromAdmin({
      id: INTEGRITY_ADMIN_USER_ID,
      name: "Admin",
    }),
  };
}

export async function ensureIntegrityAdminUser(db: PrismaClient): Promise<void> {
  await db.user.upsert({
    where: { id: INTEGRITY_ADMIN_USER_ID },
    create: {
      id: INTEGRITY_ADMIN_USER_ID,
      email: "admin@test.local",
      passwordHash: "integrity",
      name: "Admin",
      role: "ADMIN",
    },
    update: {},
  });
}

export async function resetIntegrityFinance(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "InventoryMovement",
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
      "ProductCost",
      "CostEvent",
      "CostPeriod",
      "Product",
      "Material",
      "BatchCreationCommand",
      "BatchRemainderWriteOff",
      "SimplePurchaseCreationCommand",
      "Batch",
      "Article",
      "ArticleCategory",
      "AutoRule",
      "Setting"
    RESTART IDENTITY CASCADE
  `);
}

/** Cost-freeze fixtures: Employee, payments, operations, stock, BatchCost, lots. */
export async function resetIntegrityCostFreeze(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "InventoryMovement",
      "PaymentBatchItem",
      "Payment",
      "OperationNomenclatureLine",
      "OperationDetailLine",
      "TorcovkaApproval",
      "ProductionOperationCorrection",
      "ProductionOperationQuantityEdit",
      "BatchCreationCommand",
      "BatchRemainderWriteOff",
      "SimplePurchaseCreationCommand",
      "ProductionOperation",
      "BlankStock",
      "BatchCost",
      "RailLot",
      "CostEvent",
      "CostPeriod",
      "DealItem",
      "Deal",
      "CashFlow",
      "Account",
      "Notification",
      "ChangeLog",
      "Employee",
      "Batch",
      "Material",
      "Setting"
    RESTART IDENTITY CASCADE
  `);
  await ensureIntegrityAdminUser(db);
}

/** Inventory integrity fixtures: documents, stock, production, catalog. */
export async function resetIntegrityInventory(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "InventoryMovement",
      "InventoryLine",
      "Inventory",
      "PaymentBatchItem",
      "Payment",
      "OperationNomenclatureLine",
      "OperationDetailLine",
      "TorcovkaApproval",
      "ProductionOperationCorrection",
      "ProductionOperationQuantityEdit",
      "BatchCreationCommand",
      "BatchRemainderWriteOff",
      "SimplePurchaseCreationCommand",
      "ProductionOperation",
      "ProductStock",
      "DetailStock",
      "BlankStock",
      "NomenclatureStock",
      "CostEvent",
      "CostPeriod",
      "ProductCost",
      "ProductFastener",
      "ProductExtra",
      "ProductDetail",
      "SimplePurchase",
      "Product",
      "Detail",
      "NomenclatureItem",
      "BatchCost",
      "RailLot",
      "DealItem",
      "Deal",
      "CashFlow",
      "Account",
      "Notification",
      "ChangeLog",
      "Employee",
      "Batch",
      "Material",
      "Setting"
    RESTART IDENTITY CASCADE
  `);
  await ensureIntegrityAdminUser(db);
}
