import fs from "node:fs";

const entrypoint = fs.readFileSync("docker-entrypoint.sh", "utf8");
const deploy = fs.readFileSync("scripts/deploy.sh", "utf8");
const migration =
  "prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql";

const bundlesMigrationAndApp =
  entrypoint.includes("npx prisma migrate deploy") &&
  entrypoint.includes("npm run start") &&
  deploy.includes("docker compose") &&
  deploy.includes("up -d --build") &&
  fs.existsSync(migration);

if (bundlesMigrationAndApp) {
  console.error(
    "STOP DEPLOY_BUNDLES_MIGRATION_AND_APP: Production Deploy would apply pending migrations and start the new application in one container start. P1 stays on the separate migration-only path.",
  );
  process.exit(1);
}

console.log("DEPLOY_SEPARATION_CLEAR");
