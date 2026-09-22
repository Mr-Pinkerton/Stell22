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

const mutation = /\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP)\b/i;
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

function logicalDockerLines(src) {
  return withoutComments(src)
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .filter((line) => line.includes("docker compose"));
}

function assertDockerStdin(rel, src) {
  if (/(^|\n)\s*exec\s+</.test(src)) {
    failures.push(`${rel}: must not replace bash -s script stdin with exec </dev/null`);
  }
  const lines = logicalDockerLines(src);
  if (lines.length === 0) failures.push(`${rel}: expected docker commands`);
  for (const line of lines) {
    const dockerAt = line.indexOf("docker compose");
    const piped = line.slice(0, dockerAt).includes("|");
    if (piped) {
      if (!line.slice(0, dockerAt).includes("printf") || !line.includes("psql")) {
        failures.push(`${rel}: piped docker stdin must remain the SQL printf | psql pipe`);
      }
      if (line.includes("</dev/null")) {
        failures.push(`${rel}: SQL pipe must not be replaced with /dev/null`);
      }
    } else if (!line.includes("</dev/null")) {
      failures.push(`${rel}: non-piped docker command must detach stdin with </dev/null`);
    }
  }
}

assertDockerStdin("scripts/shadow-activation-readonly-snapshot.sh", snapshot);
assertDockerStdin("scripts/shadow-activation-apply-deployed-cli.sh", apply);
if (!snapshot.includes("SHADOW_CTRL SNAPSHOT_MODE=READ_ONLY")) {
  failures.push("snapshot script must emit the completion token");
}
if (!apply.includes("SHADOW_CONTROL_APPLY_OK state=${CLI_STATE}")) {
  failures.push("apply script must emit SHADOW_CONTROL_APPLY_OK");
}

if (!snapshot.includes("BEGIN TRANSACTION READ ONLY")) {
  failures.push("snapshot must be a read-only transaction");
}
if (!snapshot.includes("\nCOMMIT;")) {
  failures.push("snapshot must commit the read-only transaction");
}

function psqlInvocationFlags(line) {
  const psqlAt = line.indexOf("psql");
  const invocation = line.slice(psqlAt).split("|")[0] ?? "";
  const tokens = invocation.trim().split(/\s+/);
  const short = new Set();
  const long = new Set();
  const variables = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "-v" || tok === "--set" || tok === "--variable") {
      variables.push(tokens[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (tok.startsWith("--")) {
      long.add(tok);
      continue;
    }
    if (/^-[A-Za-z]+$/.test(tok)) {
      for (const ch of tok.slice(1)) short.add(ch);
    }
  }
  return { short, long, variables };
}

const snapshotQueries = logicalDockerLines(snapshot).filter(
  (line) => line.includes("printf") && line.includes("psql"),
);
if (snapshotQueries.length !== 1) {
  failures.push("snapshot must keep exactly one printf | psql query invocation");
} else {
  const flags = psqlInvocationFlags(snapshotQueries[0]);
  const quiet = flags.short.has("q") || flags.long.has("--quiet");
  const noPsqlrc = flags.short.has("X") || flags.long.has("--no-psqlrc");
  const unaligned = flags.short.has("A") || flags.long.has("--no-align");
  const tuplesOnly = flags.short.has("t") || flags.long.has("--tuples-only");
  if (!quiet || !noPsqlrc || !unaligned || !tuplesOnly) {
    failures.push(
      "snapshot psql must use deterministic quiet query-output mode (-X -q -A -t) so BEGIN/COMMIT command tags never enter stdout",
    );
  }
  if (!flags.variables.includes("ON_ERROR_STOP=1")) {
    failures.push("snapshot psql must keep ON_ERROR_STOP=1");
  }
}

const snapshotAllowlist = /^[A-Za-z0-9_]+=[A-Za-z0-9_]+$/;
const snapshotParserAt = snapshot.indexOf("while IFS= read -r line");
if (snapshotParserAt < 0) {
  failures.push("snapshot KEY=VALUE parser loop missing");
} else {
  const parser = snapshot.slice(snapshotParserAt);
  const pattern = "^[A-Za-z0-9_]+=[A-Za-z0-9_]+$";
  if (!parser.includes(pattern)) {
    failures.push("snapshot parser allowlist must remain ^[A-Za-z0-9_]+=[A-Za-z0-9_]+$");
  }
  if (!parser.includes("SNAPSHOT_LINE_REJECTED") || !parser.includes("exit 1")) {
    failures.push("snapshot parser must fail closed on unexpected stdout");
  }
  for (const tag of ["BEGIN", "COMMIT", "ROLLBACK", "NOTICE", "WARNING"]) {
    if (parser.includes(tag)) failures.push(`snapshot parser must not special-case ${tag}`);
  }
  for (const sample of ["BEGIN", "COMMIT", "ROLLBACK", "NOTICE: x", "WARNING: y", "SET"]) {
    if (snapshotAllowlist.test(sample)) failures.push(`snapshot allowlist must reject ${sample}`);
  }
  for (const sample of ["SHADOW_SETTING=ABSENT", "COST_FLOW_SETTING=INACTIVE", "AUTHORITATIVE_COUNT=0"]) {
    if (!snapshotAllowlist.test(sample)) failures.push(`snapshot allowlist must accept ${sample}`);
  }
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
  if (src.includes("github.sha")) {
    failures.push(`${rel}: must not treat github.sha as the application pin`);
  }
  if (src.includes("rev-parse origin/main") && src.includes("EXPECTED_APPLICATION_SHA")) {
    const pinFromMain = /EXPECTED_APPLICATION_SHA[^\n]*origin\/main/;
    if (pinFromMain.test(src)) {
      failures.push(`${rel}: origin/main must not become the production application pin`);
    }
  }
  if (!src.includes(PIN)) failures.push(`${rel}: missing pinned production application SHA`);
  if (!src.includes("scripts/shadow-activation-policy.ts assert-pin")) {
    failures.push(`${rel}: missing assert-pin`);
  }
  if (!src.includes("environment: production")) failures.push(`${rel}: missing environment: production`);
}

assertDispatchOnly(".github/workflows/shadow-activation-control.yml", control);
assertDispatchOnly(".github/workflows/shadow-post-activation-verify.yml", verify);

const canonicalMainGuard = read("scripts/shadow-activation-assert-canonical-main.sh");
for (const token of [
  'refs/heads/main',
  "git fetch origin main",
  "git rev-parse HEAD",
  "git rev-parse origin/main",
  "CONTROL_PLANE_CHECKOUT_SHA=",
  "ORIGIN_MAIN_SHA=",
  "exit 1",
]) {
  if (!canonicalMainGuard.includes(token)) {
    failures.push(`canonical-main guard missing ${token}`);
  }
}

function requireCanonicalMain(rel, src, productionJob) {
  const required = [
    "github.ref == 'refs/heads/main' && needs.contract.result == 'success'",
    "ref: main",
    "scripts/shadow-activation-assert-canonical-main.sh",
    "REFUSE code=DISPATCH_REF_NOT_MAIN",
  ];
  for (const token of required) {
    if (!src.includes(token)) failures.push(`${rel}: missing ${token}`);
  }
  const calls = src.split("shadow-activation-assert-canonical-main.sh").length - 1;
  if (calls < 2) failures.push(`${rel}: canonical-main proof must run before and inside the production job`);
  const checkouts = src.split("uses: actions/checkout@v4");
  if (checkouts.length < 3) failures.push(`${rel}: expected an explicit checkout in each job`);
  for (let i = 1; i < checkouts.length; i += 1) {
    if (!checkouts[i].slice(0, 220).includes("ref: main")) {
      failures.push(`${rel}: checkout must set ref: main and must not use the dispatch ref implicitly`);
    }
  }
  const job = src.slice(src.indexOf(`\n  ${productionJob}:`));
  const assertAt = job.indexOf("shadow-activation-assert-canonical-main.sh");
  const sshAt = job.indexOf("shadow-activation-ssh.sh");
  if (!(assertAt >= 0 && sshAt > assertAt)) {
    failures.push(`${rel}: canonical-main proof must run before production SSH`);
  }
  if (!job.startsWith(`\n  ${productionJob}:`) && !src.includes(`\n  ${productionJob}:`)) {
    failures.push(`${rel}: missing ${productionJob} job`);
  }
  const jobHeader = job.slice(0, job.indexOf("steps:"));
  if (!jobHeader.includes("if: github.ref == 'refs/heads/main' && needs.contract.result == 'success'")) {
    failures.push(`${rel}: production job must require canonical main before the environment`);
  }
  if (!jobHeader.includes("environment: production")) {
    failures.push(`${rel}: production job missing environment: production`);
  }
}

requireCanonicalMain(".github/workflows/shadow-activation-control.yml", control, "control");
requireCanonicalMain(".github/workflows/shadow-post-activation-verify.yml", verify, "verify");

if (policy.includes("shadowCount !== before.shadowCount")) {
  failures.push("post-control must not require SHADOW count equality");
}
if (!policy.includes("after.shadowCount < before.shadowCount")) {
  failures.push("post-control must refuse SHADOW row loss");
}

const controlJobs = control.split(/^ {2}[a-z]+:/m);
if (!control.includes("activate") || !control.includes("deactivate")) {
  failures.push("control workflow must list activate and deactivate");
}
if (control.includes("reset-inventory-movement") || control.includes("INVENTORY_MOVEMENT_SHADOW_RESET")) {
  failures.push("control workflow must not offer reset");
}
const precheckAt = control.indexOf("shadow-activation-policy.ts precheck");
const applyAt = control.indexOf("shadow-activation-ssh.sh apply");
const applyProofAt = control.indexOf("shadow-activation-policy.ts assert-apply");
const postAt = control.indexOf("shadow-activation-policy.ts post-activate");
if (!(precheckAt > 0 && applyAt > precheckAt && applyProofAt > applyAt && postAt > applyProofAt)) {
  failures.push("control workflow must precheck, then apply the CLI, prove the apply token, then post-check");
}
const snapshotProofs = control.split("shadow-activation-policy.ts assert-snapshot").length - 1;
if (snapshotProofs !== 2) {
  failures.push("control workflow must require a complete snapshot before precheck and post-check");
}
if (!control.includes("id: apply")) failures.push("apply step must be identifiable for post-mutation remediation");
if (
  !control.includes(
    "failure() && (steps.apply.outcome == 'failure' || steps.apply.outcome == 'success')",
  )
) {
  failures.push("remediation must run only after the mutation step was entered");
}
if (!control.includes("ACTIVATION_STATE_UNCONFIRMED — gate may already be ACTIVE.")) {
  failures.push("activation failure must say the gate state is unconfirmed");
}
if (!control.includes("DEACTIVATION_STATE_UNCONFIRMED — gate state may already have changed.")) {
  failures.push("deactivation failure must say the gate state is unconfirmed");
}
const remediation = control.slice(control.indexOf("Report unconfirmed gate"));
if (remediation.includes("shadow-activation-ssh.sh") || remediation.includes("set-inventory-movement-shadow-write")) {
  failures.push("remediation must not automatically roll back or dispatch the gate CLI");
}
if (!control.includes("NO_AUTOMATIC_ROLLBACK=YES")) {
  failures.push("remediation must record that rollback is not automatic");
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
if (!verify.includes("shadow-activation-policy.ts assert-snapshot")) {
  failures.push("post-activation verifier must require a complete snapshot");
}
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
