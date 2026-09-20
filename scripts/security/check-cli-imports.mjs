import { spawnSync } from "node:child_process";
import process from "node:process";

const failures = [];

function run(label, args, extraEnv = {}) {
  const result = spawnSync("npx", ["tsx", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Prisma reads DATABASE_URL at client construction; no query is issued.
      DATABASE_URL:
        extraEnv.DATABASE_URL ??
        process.env.DATABASE_URL ??
        "postgresql://nouser:nopass@127.0.0.1:1/nodb",
      ...extraEnv,
    },
    shell: true,
  });
  if (result.status !== 0) {
    failures.push(
      `${label} failed (exit ${result.status}):\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
    return;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (/Cannot find module ['"]server-only['"]/i.test(output)) {
    failures.push(`${label}: still fails on server-only module resolution`);
  }
  console.log(`OK ${label}`);
}

run("scripts/run-mp-sync.ts --import-only", ["scripts/run-mp-sync.ts", "--import-only"]);

{
  const result = spawnSync("npx", ["tsx", "scripts/run-mp-sync.ts"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://nouser:nopass@127.0.0.1:1/nodb",
    },
    shell: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0 || !/MP_SYNC_CLI_PHYSICAL_EXECUTION_DISABLED/.test(output)) {
    failures.push(
      `scripts/run-mp-sync.ts physical execution must fail closed (exit ${result.status}):\n${output}`,
    );
  } else {
    console.log("OK scripts/run-mp-sync.ts physical execution disabled");
  }
}
run("scripts/fetch-statements.ts import smoke", ["scripts/fetch-statements.ts"], {
  MAIL_IMAP_HOST: "",
  MAIL_IMAP_USER: "",
  MAIL_IMAP_PASSWORD: "",
});
run("scripts/smoke-production-reversal.ts --import-only", [
  "scripts/smoke-production-reversal.ts",
  "--import-only",
]);
run("scripts/reset-inventory-movement-shadow.ts --import-only", [
  "scripts/reset-inventory-movement-shadow.ts",
  "--import-only",
]);
run("scripts/set-inventory-movement-shadow-write.ts --import-only", [
  "scripts/set-inventory-movement-shadow-write.ts",
  "--import-only",
]);

if (failures.length > 0) {
  console.error(`CLI import checks failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "CLI import checks passed: run-mp-sync, fetch-statements, smoke-production-reversal, reset-inventory-movement-shadow, and set-inventory-movement-shadow-write resolve without server-only.",
);
