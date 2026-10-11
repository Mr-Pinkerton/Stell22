import { FORBIDDEN_DATABASE_NAMES } from "@/server/internal/p1-isolated-runner/contract";

const DROPPED_KEYS = new Set([
  "DATABASE_URL",
  "DIRECT_URL",
  "SHADOW_DATABASE_URL",
  "INTEGRITY_TEST_DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
  "POSTGRES_PASSWORD",
  "POSTGRES_USER",
  "POSTGRES_DB",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
]);

export function buildChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  disposableUrl: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (DROPPED_KEYS.has(key) || key.startsWith("PROD_")) continue;
    if (valueLooksLikeForbiddenDatabase(value)) continue;
    env[key] = value;
  }
  env.DATABASE_URL = disposableUrl;
  return env;
}

function valueLooksLikeForbiddenDatabase(value: string): boolean {
  if (!value.includes("postgres")) return false;
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.replace(/^\//, "").split("/")[0] ?? "");
    return FORBIDDEN_DATABASE_NAMES.includes(
      database.toLowerCase() as (typeof FORBIDDEN_DATABASE_NAMES)[number],
    );
  } catch {
    return /stell22_integrity|(^|\/)stell22(\?|$)/.test(value);
  }
}
