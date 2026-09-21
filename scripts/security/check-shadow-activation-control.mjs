import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const failures = [];

function read(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    failures.push(`${rel}: missing`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function withoutComments(src) {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

const PIN = "2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf";
const policy = read("src/server/internal/inventory-movement-shadow-activation-policy.ts");
const cli = read("scripts/shadow-activation-policy.ts");
const snapshot = read("scripts/shadow-activation-readonly-snapshot.sh");
const apply = read("scripts/shadow-activation-apply-deployed-cli.sh");
const ssh = read("scripts/shadow-activation-ssh.sh");
const control = read(".github/workflows/shadow-activation-control.yml");
const verify = read(".github/workflows/shadow-post-activation-verify.yml");
const dormant = read(".github/workflows/package2-production-readonly-verify.yml");
const deployWorkflow = read(".github/workflows/deploy-production.yml");
const ci = read(".github/workflows/ci.yml");

const pinMatch = policy.match(
  /export const PINNED_PRODUCTION_APPLICATION_SHA =\s*"([0-9a-f]{40})";/,
);
if (!pinMatch || pinMatch[1] !== PIN) {
  failures.push("pinned production application SHA must stay 2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf");
}

if (policy.includes('dualWriteStarted: "YES"') || policy.includes("PSR_P2_DUAL_WRITE_STARTED=YES")) {
  failures.push("policy must not declare dual-write started");
}
if (!policy.includes('dualWriteStarted: "NO"')) {
  failures.push("policy must keep dual-write started = NO");
}
if (policy.includes("inventoryMovementCount !== 0")) {
  failures.push("activation must not require InventoryMovement total count = 0");
}
for (const token of [
  "setInventoryMovementShadowWriteGate",
  "setting.upsert",
  "PrismaClient",
  "production_cost_flow",
]) {
  if (policy.includes(token) || cli.includes(token)) {
    failures.push(`policy/CLI must not contain ${token}`);
  }
}

const migrationNames = [
  "20260917150000_psr_p1_inventory_movement_shadow",
  "20260917180000_psr_p2_inventory_movement_recorded_at_timestamptz",
  "20260917200000_psr_p2_r04_supply_stock_accounting_cycle",
  "20260918120000_psr_p2_r05_production_operation_correction",
  "20260918130000_psr_p2_r06_inventory_line_identity",
  "20260920120000_psr_p2_raw_identity_prerequisite",
  "20260920180000_psr_p2_production_quantity_edit_identity",
];
for (const name of migrationNames) {
  if (!policy.includes(name)) failures.push(`policy missing migration ${name}`);
  if (!snapshot.includes(name)) failures.push(`snapshot missing migration ${name}`);
}

const mutation = /\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP)\b/;
for (const [rel, src] of [
  ["scripts/shadow-activation-readonly-snapshot.sh", snapshot],
  ["scripts/shadow-activation-apply-deployed-cli.sh", apply],
  ["scripts/shadow-activation-ssh.sh", ssh],
  [".github/workflows/shadow-activation-control.yml", withoutComments(control)],
  [".github/workflows/shadow-post-activation-verify.yml", withoutComments(verify)],
]) {
  if (mutation.test(src)) failures.push(`${rel}: contains mutating SQL`);
  if (src.includes("setting.upsert") || src.includes("setting.update")) {
    failures.push(`${rel}: contains Setting mutation`);
  }
}

if (!snapshot.includes("BEGIN TRANSACTION READ ONLY")) {
  failures.push("snapshot must be a read-only transaction");
}
if (snapshot.includes("tsx scripts/set-inventory-movement-shadow-write.ts")) {
  failures.push("snapshot must not invoke the gate CLI");
}
if (snapshot.includes("reset-inventory-movement-shadow")) {
  failures.push("snapshot must not reset");
}

const applyNeed = [
  "scripts/set-inventory-movement-shadow-write.ts",
  "--confirm=INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL",
  "--entrypoint ./node_modules/.bin/tsx",
  "--state=${CLI_STATE}",
  "BEGIN TRANSACTION READ ONLY",
  "ABSENT_OR_INACTIVE",
  "EXPECTED_PRIOR",
];
for (const token of applyNeed) {
  if (!apply.includes(token)) failures.push(`apply script missing ${token}`);
}
for (const token of [
  "reset-inventory-movement-shadow",
  "production_cost_flow",
  "prisma migrate",
  "deploy.sh",
  "git checkout",
  "git pull",
  "git reset",
  "setting.upsert",
]) {
  if (apply.includes(token)) failures.push(`apply script contains ${token}`);
}
if (!apply.includes('case "$CLI_STATE"') || !apply.includes("on|off") && !apply.includes("on | off")) {
  failures.push("apply script must accept only on and off");
}

if (!ssh.includes("scripts/shadow-activation-readonly-snapshot.sh")) {
  failures.push("ssh wrapper must pipe the read-only snapshot");
}
if (!ssh.includes("scripts/shadow-activation-apply-deployed-cli.sh")) {
  failures.push("ssh wrapper must pipe the deployed CLI apply script");
}
if (ssh.includes("git checkout") || ssh.includes("git pull") || ssh.includes("origin/main")) {
  failures.push("ssh wrapper must not move the production checkout");
}

function assertDispatchOnly(rel, src) {
  if (!src.includes("workflow_dispatch:")) failures.push(`${rel}: must be workflow_dispatch`);
  if (/\n\s*push:/.test(src) || /\n\s*pull_request:/.test(src) || src.includes("schedule:")) {
    failures.push(`${rel}: must not run automatically`);
  }
  if (src.includes("origin/main") || src.includes("github.sha")) {
    failures.push(`${rel}: must not treat GitHub main or github.sha as the application pin`);
  }
  if (!src.includes(PIN)) failures.push(`${rel}: missing pinned production application SHA`);
  if (!src.includes("scripts/shadow-activation-policy.ts assert-pin")) {
    failures.push(`${rel}: missing assert-pin`);
  }
  if (!src.includes("environment: production")) failures.push(`${rel}: missing environment: production`);
}

assertDispatchOnly(".github/workflows/shadow-activation-control.yml", control);
assertDispatchOnly(".github/workflows/shadow-post-activation-verify.yml", verify);

const controlJobs = control.split(/^ {2}[a-z]+:/m);
if (!control.includes("activate") || !control.includes("deactivate")) {
  failures.push("control workflow must list activate and deactivate");
}
if (control.includes("reset-inventory-movement") || control.includes("INVENTORY_MOVEMENT_SHADOW_RESET")) {
  failures.push("control workflow must not offer reset");
}
const precheckAt = control.indexOf("shadow-activation-policy.ts precheck");
const applyAt = control.indexOf("shadow-activation-ssh.sh apply");
const postAt = control.indexOf("shadow-activation-policy.ts post-activate");
if (!(precheckAt > 0 && applyAt > precheckAt && postAt > applyAt)) {
  failures.push("control workflow must precheck, then apply the CLI, then post-check");
}
const contractBody = control.slice(control.indexOf("  contract:"), control.indexOf("  control:"));
if (contractBody.includes("environment:")) {
  failures.push("pin job must not receive production environment secrets");
}
if (!control.slice(control.indexOf("  control:")).includes("environment: production")) {
  failures.push("control job must use environment: production");
}

if (verify.includes("shadow-activation-ssh.sh apply")) {
  failures.push("post-activation verifier must not apply the gate");
}
if (verify.includes("shadow-activation-apply-deployed-cli.sh")) {
  failures.push("post-activation verifier must not call the apply script");
}
if (verify.includes("set-inventory-movement-shadow-write.ts")) {
  failures.push("post-activation verifier must not call the gate CLI");
}
if (!verify.includes("shadow-activation-ssh.sh snapshot")) {
  failures.push("post-activation verifier must take a read-only snapshot");
}
if (!verify.includes("verify-active")) failures.push("post-activation verifier must call verify-active");
const verifyContract = verify.slice(verify.indexOf("  contract:"), verify.indexOf("  verify:"));
if (verifyContract.includes("environment:")) {
  failures.push("verifier pin job must not receive production environment secrets");
}

if (!dormant.includes("PACKAGE3_PRODUCTION_POST_DEPLOY_VERIFY_OK")) {
  failures.push("Package 3 dormant verifier lost its historical success token");
}
if (!dormant.includes('shadow_setting" != "SHADOW_SETTING=ABSENT"')) {
  failures.push("Package 3 dormant verifier must still require ABSENT or INACTIVE");
}
if (dormant.includes("SHADOW_POST_ACTIVATION_VERIFY_OK")) {
  failures.push("Package 3 dormant verifier must not become the activation verifier");
}

for (const rel of [
  ".github/workflows/deploy-production.yml",
  ".github/workflows/ci.yml",
  "scripts/deploy.sh",
  "scripts/ci-prod-remote.sh",
  "scripts/preflight-prod.sh",
  "docker-entrypoint.sh",
]) {
  const src = rel === ".github/workflows/deploy-production.yml" ? deployWorkflow : rel === ".github/workflows/ci.yml" ? ci : read(rel);
  for (const token of [
    "set-inventory-movement-shadow-write",
    "shadow-activation-apply-deployed-cli",
    "shadow-activation-ssh.sh apply",
    "--state=on",
    "--state=off",
  ]) {
    if (src.includes(token)) failures.push(`${rel}: automatic or deploy path contains ${token}`);
  }
}

if (!ci.includes("security:shadow-activation-control")) {
  failures.push("CI must run security:shadow-activation-control");
}

void controlJobs;

if (failures.length > 0) {
  console.error(`SHADOW activation control policy failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "SHADOW activation control policy passed: pinned application SHA, explicit activate/deactivate, deployed CLI only, read-only verifier, deploy does not activate.",
);
