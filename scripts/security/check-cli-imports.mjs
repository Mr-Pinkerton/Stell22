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
run("scripts/fetch-statements.ts import smoke", ["scripts/fetch-statements.ts"], {
  MAIL_IMAP_HOST: "",
  MAIL_IMAP_USER: "",
  MAIL_IMAP_PASSWORD: "",
});
run("scripts/smoke-production-reversal.ts --import-only", [
  "scripts/smoke-production-reversal.ts",
  "--import-only",
]);

if (failures.length > 0) {
  console.error(`CLI import checks failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "CLI import checks passed: run-mp-sync, fetch-statements, and smoke-production-reversal resolve without server-only.",
);
