import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

const KEY = "inventory_movement_shadow_write";
const KEY_IDENT = "INVENTORY_MOVEMENT_SHADOW_WRITE_KEY";

const GATE_IMPL_REL = "src/server/internal/inventory-movement-shadow-write.ts";
const GATE_TEST_REL = "src/server/internal/inventory-movement-shadow-write.test.ts";
const CONTROL_CLI_REL = "scripts/set-inventory-movement-shadow-write.ts";
const CHECKER_REL = "scripts/security/check-inventory-movement-shadow-write-control.mjs";
const RESET_SCRIPT_REL = "scripts/reset-inventory-movement-shadow.ts";

const SETTING_MUTATION =
  /\bsetting\s*\.\s*(upsert|updateMany|update|createMany|create|deleteMany|delete)\s*\(/;

const SETTING_READ =
  /\bsetting\s*\.\s*(findUnique|findFirst|findMany|findUniqueOrThrow|findFirstOrThrow)\s*\(/;

const RAW_SETTING_MUTATION =
  /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(ONLY\s+)?(?:"Setting"|\bSetting\b)/i;

const RAW_SETTING_READ =
  /\bSELECT\b[\s\S]{0,400}\bFROM\s+(ONLY\s+)?(?:"Setting"|\bSetting\b)/i;

const UNLOCKED_READ_CALL = /\breadInventoryMovementShadowWriteGate\s*\(/;
const SETTER_CALL = /\bsetInventoryMovementShadowWriteGate\s*\(/;

/**
 * @param {string} sourceText
 */
function referencesProtectedKey(sourceText) {
  return sourceText.includes(KEY) || sourceText.includes(KEY_IDENT);
}

/**
 * Direct Setting mutation of the protected gate. Tests may contain fixtures.
 * Only the dedicated setter implementation may mutate in application source.
 * @param {string} sourceText
 * @param {string} rel
 */
function findDirectSettingMutations(sourceText, rel) {
  const failures = [];
  if (!referencesProtectedKey(sourceText)) return failures;
  if (SETTING_MUTATION.test(sourceText)) {
    failures.push(
      `${rel}: Setting mutation of ${KEY} is forbidden outside ${GATE_IMPL_REL}`,
    );
  }
  if (RAW_SETTING_MUTATION.test(sourceText)) {
    failures.push(
      `${rel}: raw SQL Setting mutation involving ${KEY} is forbidden outside ${GATE_IMPL_REL}`,
    );
  }
  return failures;
}

/**
 * @param {string} sourceText
 * @param {string} rel
 */
function findUnlockedReadCallViolations(sourceText, rel) {
  if (!UNLOCKED_READ_CALL.test(sourceText)) return [];
  if (rel === GATE_IMPL_REL || rel === GATE_TEST_REL || rel === RESET_SCRIPT_REL) return [];
  return [
    `${rel}: readInventoryMovementShadowWriteGate is reset-only unlocked read; ordinary runtime must use isInventoryMovementShadowWriteActiveForWriter`,
  ];
}

/**
 * @param {string} sourceText
 * @param {string} rel
 */
function findSetterCallViolations(sourceText, rel) {
  if (!SETTER_CALL.test(sourceText)) return [];
  if (rel === GATE_IMPL_REL || rel === GATE_TEST_REL || rel === CONTROL_CLI_REL) return [];
  if (rel.startsWith("src/server/integrity/")) return [];
  return [
    `${rel}: setInventoryMovementShadowWriteGate is allowed only in the dedicated setter, its tests, the ON/OFF maintenance CLI, and integrity fixtures`,
  ];
}

/**
 * Ordinary application code must not read the SHADOW gate Setting directly.
 * Writer-facing code uses isInventoryMovementShadowWriteActiveForWriter(tx).
 * @param {string} sourceText
 * @param {string} rel
 */
function findDirectSettingReads(sourceText, rel) {
  const failures = [];
  if (!referencesProtectedKey(sourceText)) return failures;
  if (SETTING_READ.test(sourceText)) {
    failures.push(
      `${rel}: direct Setting read of ${KEY} is forbidden outside ${GATE_IMPL_REL}`,
    );
  }
  if (RAW_SETTING_READ.test(sourceText)) {
    failures.push(
      `${rel}: raw SQL Setting read involving ${KEY} is forbidden outside ${GATE_IMPL_REL}`,
    );
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

function isMutationAllowed(rel) {
  if (rel === GATE_IMPL_REL) return true;
  if (rel === GATE_TEST_REL) return true;
  if (rel.startsWith("prisma/migrations/")) return true;
  if (rel.startsWith("src/server/integrity/")) return true;
  return false;
}

function isDirectReadAllowed(rel) {
  if (rel === GATE_IMPL_REL) return true;
  if (rel === GATE_TEST_REL) return true;
  if (rel.startsWith("prisma/migrations/")) return true;
  if (rel.startsWith("src/server/integrity/")) return true;
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

const upsertHit = findDirectSettingMutations(
  `await tx.setting.upsert({ where: { key: "${KEY}" }, create: { key: "${KEY}", value: {} }, update: {} })`,
  "fixture-upsert.ts",
);
if (!upsertHit.some((item) => item.includes("Setting mutation"))) {
  fixtureFailures.push("fail-closed detector missed setting.upsert of inventory_movement_shadow_write");
}

const updateHit = findDirectSettingMutations(
  `prisma.setting.update({ where: { key: "${KEY}" }, data: { value: {} } })`,
  "fixture-update.ts",
);
if (!updateHit.some((item) => item.includes("Setting mutation"))) {
  fixtureFailures.push("fail-closed detector missed setting.update of inventory_movement_shadow_write");
}

const rawHit = findDirectSettingMutations(
  `UPDATE "Setting" SET value = '{}' WHERE key = '${KEY}'`,
  "fixture-raw-update.ts",
);
if (!rawHit.some((item) => item.includes("raw SQL Setting mutation"))) {
  fixtureFailures.push("fail-closed detector missed raw UPDATE Setting for inventory_movement_shadow_write");
}

const constantUpsert = `import { ${KEY_IDENT} } from "@/server/internal/inventory-movement-shadow-write";
await prisma.setting.upsert({ where: { key: ${KEY_IDENT} }, create: { key: ${KEY_IDENT}, value: {} }, update: {} });`;
const constantHit = findDirectSettingMutations(constantUpsert, "fixture-constant-upsert.ts");
if (!constantHit.some((item) => item.includes("Setting mutation"))) {
  fixtureFailures.push("fail-closed detector missed setting.upsert via INVENTORY_MOVEMENT_SHADOW_WRITE_KEY");
}

const aliasedUpsert = `import { ${KEY_IDENT} as ShadowWriteKey } from "@/server/internal/inventory-movement-shadow-write";
await prisma.setting.upsert({ where: { key: ShadowWriteKey }, create: {}, update: {} });`;
const aliasedHit = findDirectSettingMutations(aliasedUpsert, "fixture-aliased-upsert.ts");
if (!aliasedHit.some((item) => item.includes("Setting mutation"))) {
  fixtureFailures.push("fail-closed detector missed aliased import of INVENTORY_MOVEMENT_SHADOW_WRITE_KEY");
}

const createHit = findDirectSettingMutations(
  `await tx.setting.create({ data: { key: ${KEY_IDENT}, value: {} } })`,
  "fixture-create.ts",
);
if (!createHit.some((item) => item.includes("Setting mutation"))) {
  fixtureFailures.push("fail-closed detector missed setting.create via INVENTORY_MOVEMENT_SHADOW_WRITE_KEY");
}

const deleteHit = findDirectSettingMutations(
  `await tx.setting.delete({ where: { key: ${KEY_IDENT} } })`,
  "fixture-delete.ts",
);
if (!deleteHit.some((item) => item.includes("Setting mutation"))) {
  fixtureFailures.push("fail-closed detector missed setting.delete via INVENTORY_MOVEMENT_SHADOW_WRITE_KEY");
}

const mutationIgnoresRead = findDirectSettingMutations(
  `await tx.setting.findUnique({ where: { key: "${KEY}" } })`,
  "fixture-read.ts",
);
if (mutationIgnoresRead.length > 0) {
  fixtureFailures.push("Q4 mutation detector must not treat a Setting read as a mutation");
}

const directReadHit = findDirectSettingReads(
  `await tx.setting.findUnique({ where: { key: "${KEY}" } })`,
  "src/server/warehouse.ts",
);
if (!directReadHit.some((item) => item.includes("direct Setting read"))) {
  fixtureFailures.push("fail-closed detector missed setting.findUnique of inventory_movement_shadow_write");
}

const findFirstHit = findDirectSettingReads(
  `await tx.setting.findFirst({ where: { key: ${KEY_IDENT} } })`,
  "src/server/production.ts",
);
if (!findFirstHit.some((item) => item.includes("direct Setting read"))) {
  fixtureFailures.push("fail-closed detector missed setting.findFirst of inventory_movement_shadow_write");
}

const rawReadHit = findDirectSettingReads(
  `SELECT value FROM "Setting" WHERE key = '${KEY}'`,
  "src/server/terminal.ts",
);
if (!rawReadHit.some((item) => item.includes("raw SQL Setting read"))) {
  fixtureFailures.push("fail-closed detector missed raw SELECT Setting for inventory_movement_shadow_write");
}

const writerPath = `import { isInventoryMovementShadowWriteActiveForWriter, ${KEY_IDENT} } from "@/server/internal/inventory-movement-shadow-write";
await isInventoryMovementShadowWriteActiveForWriter(tx);`;
const writerMutation = findDirectSettingMutations(writerPath, "src/server/warehouse.ts");
const writerUnlocked = findUnlockedReadCallViolations(writerPath, "src/server/warehouse.ts");
const writerSetter = findSetterCallViolations(writerPath, "src/server/warehouse.ts");
const writerDirectRead = findDirectSettingReads(writerPath, "src/server/warehouse.ts");
if (
  writerMutation.length > 0 ||
  writerUnlocked.length > 0 ||
  writerSetter.length > 0 ||
  writerDirectRead.length > 0
) {
  fixtureFailures.push("isInventoryMovementShadowWriteActiveForWriter must remain the permitted future writer-facing path");
}

const runtimeReadHit = findUnlockedReadCallViolations(
  "await readInventoryMovementShadowWriteGate(tx);",
  "src/server/production.ts",
);
if (runtimeReadHit.length === 0) {
  fixtureFailures.push("fail-closed detector missed ordinary runtime readInventoryMovementShadowWriteGate call");
}

const runtimeSetterHit = findSetterCallViolations(
  "await setInventoryMovementShadowWriteGate(tx, true);",
  "src/server/settings.ts",
);
if (runtimeSetterHit.length === 0) {
  fixtureFailures.push("fail-closed detector missed ordinary runtime setInventoryMovementShadowWriteGate call");
}

const failures = [...fixtureFailures];

const implAbs = path.join(root, GATE_IMPL_REL);
if (!fs.existsSync(implAbs)) {
  failures.push(`${GATE_IMPL_REL}: missing dedicated SHADOW write-gate implementation`);
} else {
  const implText = fs.readFileSync(implAbs, "utf8");
  if (!implText.includes("setInventoryMovementShadowWriteGate")) {
    failures.push(`${GATE_IMPL_REL}: must define setInventoryMovementShadowWriteGate`);
  }
  if (!SETTING_MUTATION.test(implText)) {
    failures.push(`${GATE_IMPL_REL}: dedicated setter must perform the Setting upsert`);
  }
}

const resetAbs = path.join(root, RESET_SCRIPT_REL);
if (!fs.existsSync(resetAbs)) {
  failures.push(`${RESET_SCRIPT_REL}: missing dedicated R-10 SHADOW reset script`);
} else {
  const resetText = fs.readFileSync(resetAbs, "utf8");
  if (SETTING_MUTATION.test(resetText) || RAW_SETTING_MUTATION.test(resetText)) {
    failures.push(`${RESET_SCRIPT_REL}: may read the SHADOW gate but must not mutate it`);
  }
  if (!UNLOCKED_READ_CALL.test(resetText)) {
    failures.push(`${RESET_SCRIPT_REL}: must read the gate via readInventoryMovementShadowWriteGate after exclusive lock`);
  }
}

const cliAbs = path.join(root, CONTROL_CLI_REL);
if (!fs.existsSync(cliAbs)) {
  failures.push(`${CONTROL_CLI_REL}: missing dedicated SHADOW write-gate control CLI`);
} else {
  const cliText = fs.readFileSync(cliAbs, "utf8");
  if (!cliText.includes("setInventoryMovementShadowWriteGate")) {
    failures.push(`${CONTROL_CLI_REL}: must call the transaction-only gate setter`);
  }
  if (!cliText.includes("--state=on") || !cliText.includes("--state=off")) {
    failures.push(`${CONTROL_CLI_REL}: must support explicit --state=on and --state=off`);
  }
  if (!cliText.includes("--confirm=INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL")) {
    failures.push(`${CONTROL_CLI_REL}: must require --confirm=INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL`);
  }
  if (SETTING_MUTATION.test(cliText) || RAW_SETTING_MUTATION.test(cliText)) {
    failures.push(
      `${CONTROL_CLI_REL}: must not directly mutate Setting; it is an entry point to setInventoryMovementShadowWriteGate only`,
    );
  }
}

for (const absolute of collectScanRoots()) {
  const rel = toRel(absolute);
  if (rel === CHECKER_REL) continue;
  if (rel.startsWith("prisma/migrations/")) continue;
  const sourceText = fs.readFileSync(absolute, "utf8");
  if (!isMutationAllowed(rel)) {
    failures.push(...findDirectSettingMutations(sourceText, rel));
  }
  if (!isDirectReadAllowed(rel)) {
    failures.push(...findDirectSettingReads(sourceText, rel));
  }
  failures.push(...findUnlockedReadCallViolations(sourceText, rel));
  failures.push(...findSetterCallViolations(sourceText, rel));
}

if (failures.length > 0) {
  console.error(`InventoryMovement SHADOW write-gate control policy failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "InventoryMovement SHADOW write-gate control policy passed: only the coordinated setter " +
    `may mutate ${KEY}; ordinary code may not read ${KEY} directly; ` +
    "CLI calls the setter; unlocked read is reset-only.",
);
