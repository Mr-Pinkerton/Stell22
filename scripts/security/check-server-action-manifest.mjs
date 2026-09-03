import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  actionPolicy,
  manifestOnlyInternalNames,
} from "./server-action-policy.mjs";

const manifestPath = path.join(
  process.cwd(),
  ".next",
  "server",
  "server-reference-manifest.json",
);
if (!fs.existsSync(manifestPath)) {
  console.error(`Build manifest not found: ${manifestPath}. Run npm run build first.`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entries = Object.values(manifest.node ?? {});
const failures = [];

function actionKey(entry) {
  const normalized = String(entry.filename).replaceAll("\\", "/");
  return `${path.posix.basename(normalized, ".ts")}.${entry.exportedName}`;
}

const byKey = new Map(entries.map((entry) => [actionKey(entry), entry]));
const publicKeys = Object.entries(actionPolicy)
  .filter(([category]) => category !== "INTERNAL_SERVER")
  .flatMap(([, keys]) => keys);

for (const key of publicKeys) {
  if (!byKey.has(key)) failures.push(`${key}: expected public action is absent from manifest`);
}

for (const key of actionPolicy.INTERNAL_SERVER) {
  if (byKey.has(key)) failures.push(`${key}: internal helper is registered as a Server Action`);
}
for (const exportedName of manifestOnlyInternalNames) {
  const hit = entries.find((entry) => entry.exportedName === exportedName);
  if (hit) failures.push(`${exportedName}: internal helper is registered as a Server Action`);
}

const terminalWorker = "app/terminal/page";
const actualTerminalKeys = entries
  .filter((entry) => Object.hasOwn(entry.workers ?? {}, terminalWorker))
  .map(actionKey)
  .sort();
const allowedTerminalKeys = [
  ...actionPolicy.TERMINAL_ACTION,
  ...actionPolicy.AUTH_ACTION.filter((key) => key.startsWith("terminal.")),
].sort();

for (const key of actualTerminalKeys) {
  if (!allowedTerminalKeys.includes(key)) {
    failures.push(`${key}: unexpected action on ${terminalWorker}`);
  }
}
for (const key of allowedTerminalKeys) {
  if (!actualTerminalKeys.includes(key)) {
    failures.push(`${key}: required terminal action missing from ${terminalWorker}`);
  }
}

if (failures.length > 0) {
  console.error(`Server Action manifest policy failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    `Observed ${entries.length} manifest entries and ${actualTerminalKeys.length} terminal workers.`,
  );
  process.exit(1);
}

console.log(
  `Server Action manifest policy passed: ${entries.length} actions; ` +
    `${actualTerminalKeys.length} terminal workers; internal helpers absent.`,
);

