export const MARKETPLACE_SYNC_PRODUCTION_FROZEN =
  "Синхронизация с маркетплейсами отключена: production freeze.";

const PRODUCTION_DATABASE_NAME = "stell22";
const NON_PRODUCTION_RUNTIMES = new Set(["development", "test"]);

export type MarketplaceSyncFreeze =
  | { frozen: false }
  | { frozen: true; message: string };

/**
 * Fail closed for Ozon and Wildberries sync.
 * Production runtime or the production database is enough to refuse.
 * A missing or unreadable runtime or database target is also a refusal.
 * The decision reads the process environment. Callers cannot pass an override.
 */
export function marketplaceSyncProductionFreeze(): MarketplaceSyncFreeze {
  const env = process.env;
  const runtime = env["NODE_ENV"] ?? "";
  const database = databaseName(env["DATABASE_URL"]);
  const productionRuntime = runtime === "production";
  const productionDatabase = database === PRODUCTION_DATABASE_NAME;
  const runtimeKnown = NON_PRODUCTION_RUNTIMES.has(runtime);
  if (productionRuntime || productionDatabase || !runtimeKnown || database === null) {
    return { frozen: true, message: MARKETPLACE_SYNC_PRODUCTION_FROZEN };
  }
  return { frozen: false };
}

function databaseName(raw: string | undefined): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return null;
  const segment = url.pathname.replace(/^\//, "").split("/")[0] ?? "";
  let name = "";
  try {
    name = decodeURIComponent(segment).trim().toLowerCase();
  } catch {
    return null;
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) return null;
  return name;
}
