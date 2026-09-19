import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const rel = ".github/workflows/supply-production-preflight.yml";
const file = path.join(root, rel);

if (!fs.existsSync(file)) {
  console.error(`${rel}: missing`);
  process.exit(1);
}

const src = fs.readFileSync(file, "utf8");
const withoutComments = src
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

const required = [
  "workflow_dispatch",
  "environment: production",
  "contents: read",
  "BEGIN TRANSACTION READ ONLY",
  "SUPPLY_PREFLIGHT_RESULT=",
  "^SUPPLY_PREFLIGHT_RESULT=[0-9]+,[0-9]+,[0-9]+,[0-9]+$",
  "SUPPLY_PREFLIGHT_RESULT_PARSE_FAILED",
  "SUPPLY_PREFLIGHT_TOTAL=",
  "SUPPLY_PREFLIGHT_DEDUCTED_POSITIVE=",
  "SUPPLY_PREFLIGHT_SHORTFALL_ONLY=",
  "SUPPLY_PREFLIGHT_OPEN_DEDUCTED_POSITIVE=",
  "SUPPLY_DATA_BLOCKER=",
];

const failures = [];
for (const token of required) {
  if (!src.includes(token)) failures.push(`${rel}: missing ${token}`);
}

const forbidden = [
  [/\bdeploy\.sh\b/, "deploy.sh"],
  [/prisma\s+migrate/i, "prisma migrate"],
  [/\bgit\s+reset\b/, "git reset"],
  [/docker\s+compose[^\n]*(up|down|restart)/i, "docker compose up/down/restart"],
  [/\b(UPDATE|INSERT|DELETE|TRUNCATE|ALTER|DROP)\b/, "mutating SQL"],
];
for (const [pattern, label] of forbidden) {
  if (pattern.test(withoutComments)) failures.push(`${rel}: contains ${label}`);
}

if (withoutComments.includes("awk 'NF { print; exit }'")) {
  failures.push(`${rel}: fragile first-non-empty-line parser`);
}
if (src.includes("actions/checkout")) failures.push(`${rel}: contains actions/checkout`);
if (src.includes("ci.yml")) failures.push(`${rel}: contains ci.yml`);
if (src.includes("scripts/deploy.sh")) failures.push(`${rel}: contains scripts/deploy.sh`);
if (src.includes("ci-prod-remote.sh")) failures.push(`${rel}: contains ci-prod-remote.sh`);

if (failures.length > 0) {
  console.error(`Supply production preflight workflow safety failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Supply production preflight workflow safety passed: read-only SELECT path only.");
