import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const failures = [];
const PIN = "2d2cbcbdc01ee83cb9103ad8fdaa43ebf8488dcf";

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

const workflow = read(".github/workflows/shadow-soak-evidence.yml");
const snapshot = read("scripts/shadow-soak-evidence-readonly-snapshot.sh");
const ssh = read("scripts/shadow-soak-evidence-ssh.sh");
const policy = read("src/server/internal/inventory-movement-shadow-soak-evidence.ts");
const cli = read("scripts/shadow-soak-evidence-policy.ts");
const ci = read(".github/workflows/ci.yml");
const packageJson = read("package.json");

const heredoc = snapshot.match(/<<'SQL'\r?\n([\s\S]*?)\r?\nSQL/);
const sql = heredoc?.[1] ?? "";
if (!sql) failures.push("soak snapshot SQL heredoc missing");

const onAt = workflow.indexOf("\non:");
const permissionsAt = workflow.indexOf("\npermissions:");
const onBlock = onAt >= 0 && permissionsAt > onAt ? workflow.slice(onAt, permissionsAt) : "";
if (!onBlock.includes("workflow_dispatch:")) {
  failures.push("soak workflow must be workflow_dispatch");
}
for (const auto of ["push:", "pull_request:", "schedule:", "workflow_run:", "workflow_call:"]) {
  if (onBlock.includes(auto)) failures.push(`soak workflow must not declare ${auto}`);
}

if (!workflow.includes(`PINNED_PRODUCTION_APPLICATION_SHA: ${PIN}`)) {
  failures.push("soak workflow must pin the production application SHA");
}
if (!workflow.includes("environment: production")) {
  failures.push("soak evidence job must use the production environment");
}
if (!workflow.includes("scripts/shadow-activation-assert-canonical-main.sh")) {
  failures.push("soak workflow must prove canonical main");
}
if (!workflow.includes("scripts/shadow-soak-evidence-ssh.sh snapshot")) {
  failures.push("soak workflow must call only the soak snapshot wrapper");
}
if (!workflow.includes("scripts/shadow-soak-evidence-policy.ts assert-pin")) {
  failures.push("soak workflow must assert the application SHA pin");
}
for (const banned of [
  "shadow-activation-ssh.sh",
  "shadow-activation-apply-deployed-cli",
  "set-inventory-movement-shadow-write",
  "reset-inventory-movement-shadow",
  "deploy-production",
  "SOAK_COMPLETE=YES",
]) {
  if (workflow.includes(banned) || ssh.includes(banned) || snapshot.includes(banned)) {
    failures.push(`soak path must not reference ${banned}`);
  }
}
if (/\bapply\b/.test(ssh)) failures.push("soak ssh wrapper must not grow an apply mode");

const mutation = /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY)\b/i;
if (mutation.test(sql)) failures.push("soak SQL contains a mutating statement");
if (!sql.includes("BEGIN TRANSACTION READ ONLY;")) {
  failures.push("soak SQL must open a read-only transaction");
}
if (!sql.includes("\nCOMMIT;")) failures.push("soak SQL must commit the read-only transaction");
for (const personal of ["employeeId", "userId", "fullName", "actorDisplaySnapshot"]) {
  if (sql.includes(personal)) failures.push(`soak SQL must not project ${personal}`);
}

function logicalDockerLines(src) {
  return withoutComments(src)
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .filter((line) => line.includes("docker compose"));
}

const dockerLines = logicalDockerLines(snapshot);
if (dockerLines.length !== 1) {
  failures.push("soak snapshot must keep exactly one docker command");
} else {
  const line = dockerLines[0];
  const dockerAt = line.indexOf("docker compose");
  if (!line.slice(0, dockerAt).includes("printf") || !line.includes("psql") || line.includes("</dev/null")) {
    failures.push("soak docker stdin must stay the SQL printf pipe");
  }
  const psqlAt = line.indexOf("psql");
  const invocation = line.slice(psqlAt).split("|")[0] ?? "";
  const tokens = invocation.trim().split(/\s+/);
  const short = new Set();
  const variables = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "-v" || tok === "--set" || tok === "--variable") {
      variables.push(tokens[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(tok)) {
      for (const ch of tok.slice(1)) short.add(ch);
    }
  }
  if (!short.has("X") || !short.has("q") || !short.has("A") || !short.has("t")) {
    failures.push("soak psql must use -X -q -A -t");
  }
  if (!variables.includes("ON_ERROR_STOP=1")) {
    failures.push("soak psql must keep ON_ERROR_STOP=1");
  }
}

if (!snapshot.includes('^\\[A-Za-z0-9_\\]+=\\[A-Za-z0-9_\\]+$') && !snapshot.includes("^[A-Za-z0-9_]+=[A-Za-z0-9_]+$")) {
  failures.push("soak snapshot parser allowlist missing");
}
if (!snapshot.includes("SNAPSHOT_LINE_REJECTED") || !snapshot.includes("exit 1")) {
  failures.push("soak snapshot parser must fail closed");
}
if (policy.includes("SOAK_COMPLETE=YES") || cli.includes("SOAK_COMPLETE=YES")) {
  failures.push("soak policy must not declare soak complete");
}
if (!policy.includes('SOAK_COMPLETE=NO')) {
  failures.push("soak policy must keep SOAK_COMPLETE=NO");
}
if (!ci.includes("security:shadow-soak-evidence") || !packageJson.includes("security:shadow-soak-evidence")) {
  failures.push("CI must run security:shadow-soak-evidence");
}

if (failures.length > 0) {
  console.error(`SHADOW soak evidence checks failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("SHADOW soak evidence checks passed: manual read-only diagnostic, pinned SHA, no setter or deploy path.");
