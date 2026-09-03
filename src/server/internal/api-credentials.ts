import {
  API_CREDENTIAL_KEYS,
  SETTING_PREFIX,
  type ApiCredentialValues,
} from "@/lib/api-credentials";
import { prisma } from "@/server/db";

/** Значения API-ключей из БД без проверки сессии (для серверной синхронизации). */
export async function loadStoredApiCredentialsInternal(): Promise<ApiCredentialValues> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: SETTING_PREFIX } },
  });
  const stored = new Map(rows.map((r) => [r.key.slice(SETTING_PREFIX.length), r.value]));
  const out: ApiCredentialValues = {};
  for (const key of API_CREDENTIAL_KEYS) {
    const value = stored.get(key);
    out[key] = typeof value === "string" ? value : "";
  }
  return out;
}
