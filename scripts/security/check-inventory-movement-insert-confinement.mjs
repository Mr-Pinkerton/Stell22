import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

const GATEWAY_IMPL_REL = "src/server/internal/inventory-movement-shadow-gateway.ts";
const GATEWAY_TEST_REL = "src/server/internal/inventory-movement-shadow-gateway.test.ts";
const CHECKER_REL = "scripts/security/check-inventory-movement-insert-confinement.mjs";

const PRISMA_CREATE =
  /\binventoryMovement\s*\.\s*(createMany|create)\s*\(/;

const PRISMA_CREATE_ALIAS =
  /\binventoryMovement\s*\[\s*['"`]create(Many)?['"`]\s*\]/;

const RAW_INSERT =
  /\bINSERT\s+INTO\s+(?:(?:public\.)?(?:"InventoryMovement"|\bInventoryMovement\b))/i;

/**
 * @param {string} sourceText
 * @param {string} rel
 */
function findInventoryMovementInsertViolations(sourceText, rel) {
  const failures = [];
  if (PRISMA_CREATE.test(sourceText) || PRISMA_CREATE_ALIAS.test(sourceText)) {
    failures.push(`${rel}: InventoryMovement create/createMany is forbidden outside the approved gateway`);
  }
  if (RAW_INSERT.test(sourceText)) {
    failures.push(`${rel}: raw INSERT INTO InventoryMovement is forbidden outside the approved gateway`);
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

function isInsertAllowed(rel) {
  if (rel === GATEWAY_IMPL_REL) return true;
  if (rel === GATEWAY_TEST_REL) return true;
  if (rel === CHECKER_REL) return true;
  if (rel.startsWith("scripts/security/")) return true;
  if (rel.startsWith("src/server/integrity/")) return true;
  if (rel.startsWith("prisma/migrations/")) return true;
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

const createHit = findInventoryMovementInsertViolations(
  "await tx.inventoryMovement.create({ data: row })",
  "src/server/warehouse.ts",
);
if (!createHit.some((item) => item.includes("create/createMany"))) {
  fixtureFailures.push("fail-closed detector missed inventoryMovement.create");
}

const createManyHit = findInventoryMovementInsertViolations(
  "prisma.inventoryMovement.createMany({ data: [] })",
  "src/server/production.ts",
);
if (!createManyHit.some((item) => item.includes("create/createMany"))) {
  fixtureFailures.push("fail-closed detector missed inventoryMovement.createMany");
}

const aliasHit = findInventoryMovementInsertViolations(
  'await db.inventoryMovement["create"]({ data: row })',
  "src/server/terminal.ts",
);
if (!aliasHit.some((item) => item.includes("create/createMany"))) {
  fixtureFailures.push("fail-closed detector missed inventoryMovement[\"create\"]");
}

const rawHit = findInventoryMovementInsertViolations(
  'INSERT INTO "InventoryMovement" ("id") VALUES (\'x\')',
  "src/server/purchases.ts",
);
if (!rawHit.some((item) => item.includes("raw INSERT"))) {
  fixtureFailures.push("fail-closed detector missed quoted INSERT INTO InventoryMovement");
}

const rawUnquotedHit = findInventoryMovementInsertViolations(
  "INSERT INTO InventoryMovement (id) VALUES ('x')",
  "src/server/marketplace.ts",
);
if (!rawUnquotedHit.some((item) => item.includes("raw INSERT"))) {
  fixtureFailures.push("fail-closed detector missed unquoted INSERT INTO InventoryMovement");
}

const failures = [...fixtureFailures];

const implAbs = path.join(root, GATEWAY_IMPL_REL);
if (!fs.existsSync(implAbs)) {
  failures.push(`${GATEWAY_IMPL_REL}: missing approved SHADOW gateway implementation`);
} else {
  const implText = fs.readFileSync(implAbs, "utf8");
  if (!implText.includes("appendShadowInventoryMovements")) {
    failures.push(`${GATEWAY_IMPL_REL}: must define appendShadowInventoryMovements`);
  }
  if (!RAW_INSERT.test(implText) && !PRISMA_CREATE.test(implText)) {
    failures.push(`${GATEWAY_IMPL_REL}: approved gateway must be the InventoryMovement insert path`);
  }
}

for (const absolute of collectScanRoots()) {
  const rel = toRel(absolute);
  if (isInsertAllowed(rel)) continue;
  const sourceText = fs.readFileSync(absolute, "utf8");
  failures.push(...findInventoryMovementInsertViolations(sourceText, rel));
}

if (failures.length > 0) {
  console.error(`InventoryMovement INSERT confinement failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "InventoryMovement INSERT confinement passed: only the approved SHADOW gateway, " +
    "its tests, integrity fixtures, and migrations may insert InventoryMovement rows.",
);
