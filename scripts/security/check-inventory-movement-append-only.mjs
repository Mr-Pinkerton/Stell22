import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

const RESET_SCRIPT_REL = "scripts/reset-inventory-movement-shadow.ts";

const REQUIRED_SHADOW_DELETE_SQL =
  `DELETE FROM "InventoryMovement" WHERE "authority" = 'SHADOW'::"InventoryMovementAuthority"`;

const PRISMA_MUTATION =
  /\binventoryMovement\s*\.\s*(updateMany|update|deleteMany|delete|upsert)\s*\(/;

const RAW_UPDATE =
  /\bUPDATE\s+(ONLY\s+)?(?:"InventoryMovement"|\bInventoryMovement\b)/i;

const RAW_DELETE =
  /\bDELETE\s+FROM\s+(ONLY\s+)?(?:"InventoryMovement"|\bInventoryMovement\b)/i;

const RAW_TRUNCATE =
  /\bTRUNCATE\s+(TABLE\s+)?(ONLY\s+)?(?:(?:public\.)?(?:"InventoryMovement"|\bInventoryMovement\b))/i;

/**
 * @param {string} sourceText
 * @param {string} rel
 */
function findInventoryMovementAppendOnlyViolations(sourceText, rel) {
  const failures = [];
  if (PRISMA_MUTATION.test(sourceText)) {
    failures.push(`${rel}: forbidden Prisma InventoryMovement mutation (update/updateMany/delete/deleteMany/upsert)`);
  }
  if (RAW_UPDATE.test(sourceText)) {
    failures.push(`${rel}: forbidden raw SQL UPDATE against InventoryMovement`);
  }
  if (RAW_DELETE.test(sourceText)) {
    failures.push(`${rel}: forbidden raw SQL DELETE against InventoryMovement`);
  }
  if (RAW_TRUNCATE.test(sourceText)) {
    failures.push(`${rel}: forbidden raw SQL TRUNCATE against InventoryMovement`);
  }
  return failures;
}

function walkFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(absolute, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) continue;
    acc.push(absolute);
  }
  return acc;
}

function toRel(absolute) {
  return path.relative(root, absolute).replaceAll("\\", "/");
}

function isExcluded(rel) {
  if (rel.startsWith("prisma/migrations/")) return true;
  if (rel.includes(".test.")) return true;
  if (rel.startsWith("src/server/integrity/")) return true;
  if (rel === RESET_SCRIPT_REL) return true;
  if (rel === "scripts/security/check-inventory-movement-append-only.mjs") return true;
  return false;
}

function collectScanRoots() {
  const files = [];
  walkFiles(path.join(root, "src"), files);
  walkFiles(path.join(root, "scripts"), files);
  const seed = path.join(root, "prisma", "seed.ts");
  if (fs.existsSync(seed)) files.push(seed);
  return files;
}

const fixtureFailures = [];
const prismaHit = findInventoryMovementAppendOnlyViolations(
  "await db.inventoryMovement.update({ where: { id: 'x' }, data: {} })",
  "fixture-prisma.ts",
);
if (!prismaHit.some((item) => item.includes("forbidden Prisma"))) {
  fixtureFailures.push("fail-closed detector missed Prisma inventoryMovement.update");
}
const updateManyHit = findInventoryMovementAppendOnlyViolations(
  "prisma.inventoryMovement.updateMany({ data: {} })",
  "fixture-updateMany.ts",
);
if (!updateManyHit.some((item) => item.includes("forbidden Prisma"))) {
  fixtureFailures.push("fail-closed detector missed Prisma inventoryMovement.updateMany");
}
const deleteHit = findInventoryMovementAppendOnlyViolations(
  "tx.inventoryMovement.delete({ where: { id: 'x' } })",
  "fixture-delete.ts",
);
if (!deleteHit.some((item) => item.includes("forbidden Prisma"))) {
  fixtureFailures.push("fail-closed detector missed Prisma inventoryMovement.delete");
}
const deleteManyHit = findInventoryMovementAppendOnlyViolations(
  "db.inventoryMovement.deleteMany({})",
  "fixture-deleteMany.ts",
);
if (!deleteManyHit.some((item) => item.includes("forbidden Prisma"))) {
  fixtureFailures.push("fail-closed detector missed Prisma inventoryMovement.deleteMany");
}
const upsertHit = findInventoryMovementAppendOnlyViolations(
  "prisma.inventoryMovement.upsert({ where: { id: 'x' }, create: {}, update: {} })",
  "fixture-upsert.ts",
);
if (!upsertHit.some((item) => item.includes("forbidden Prisma"))) {
  fixtureFailures.push("fail-closed detector missed Prisma inventoryMovement.upsert");
}
const rawUpdateHit = findInventoryMovementAppendOnlyViolations(
  'UPDATE "InventoryMovement" SET "effectKey" = \'x\'',
  "fixture-raw-update.ts",
);
if (!rawUpdateHit.some((item) => item.includes("forbidden raw SQL UPDATE"))) {
  fixtureFailures.push("fail-closed detector missed raw UPDATE InventoryMovement");
}
const rawDeleteHit = findInventoryMovementAppendOnlyViolations(
  'DELETE FROM "InventoryMovement"',
  "fixture-raw-delete.ts",
);
if (!rawDeleteHit.some((item) => item.includes("forbidden raw SQL DELETE"))) {
  fixtureFailures.push("fail-closed detector missed raw DELETE InventoryMovement");
}
const createOk = findInventoryMovementAppendOnlyViolations(
  "await tx.inventoryMovement.create({ data: row })",
  "fixture-create.ts",
);
if (createOk.length > 0) {
  fixtureFailures.push("create/createMany must not be forbidden by R-11");
}
const truncateHit = findInventoryMovementAppendOnlyViolations(
  'TRUNCATE TABLE "InventoryMovement"',
  "fixture-truncate.ts",
);
if (!truncateHit.some((item) => item.includes("forbidden raw SQL TRUNCATE"))) {
  fixtureFailures.push("fail-closed detector missed raw TRUNCATE InventoryMovement");
}
const truncateUnquotedHit = findInventoryMovementAppendOnlyViolations(
  "TRUNCATE ONLY InventoryMovement RESTART IDENTITY",
  "fixture-truncate-unquoted.ts",
);
if (!truncateUnquotedHit.some((item) => item.includes("forbidden raw SQL TRUNCATE"))) {
  fixtureFailures.push("fail-closed detector missed unquoted TRUNCATE InventoryMovement");
}

const failures = [...fixtureFailures];

const resetAbs = path.join(root, RESET_SCRIPT_REL);
if (!fs.existsSync(resetAbs)) {
  failures.push(`${RESET_SCRIPT_REL}: missing dedicated R-10 SHADOW reset script`);
} else {
  const resetText = fs.readFileSync(resetAbs, "utf8");
  if (!resetText.includes(REQUIRED_SHADOW_DELETE_SQL)) {
    failures.push(
      `${RESET_SCRIPT_REL}: must issue exactly the SHADOW-only DELETE SQL (authority = SHADOW)`,
    );
  }
  const resetDeletes = resetText.match(/DELETE\s+FROM\s+"InventoryMovement"[\s\S]*?;/gi) ?? [];
  for (const stmt of resetDeletes) {
    if (!stmt.includes(`WHERE "authority" = 'SHADOW'`)) {
      failures.push(`${RESET_SCRIPT_REL}: unrestricted InventoryMovement DELETE is forbidden`);
    }
  }
  if (!resetText.includes("--confirm=")) {
    failures.push(`${RESET_SCRIPT_REL}: must require explicit --confirm operator token`);
  }
}

for (const absolute of collectScanRoots()) {
  const rel = toRel(absolute);
  if (isExcluded(rel)) continue;
  const sourceText = fs.readFileSync(absolute, "utf8");
  failures.push(...findInventoryMovementAppendOnlyViolations(sourceText, rel));
}

if (failures.length > 0) {
  console.error(`InventoryMovement append-only policy failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "InventoryMovement append-only policy passed: no runtime update/delete/upsert; " +
    `R-10 reset script ${RESET_SCRIPT_REL} retains SHADOW-only DELETE.`,
);
