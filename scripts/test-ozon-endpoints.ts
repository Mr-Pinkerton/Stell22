/**
 * Диагностика отдельных методов Ozon API.
 * npx tsx scripts/test-ozon-endpoints.ts
 */
import { prisma } from "../src/server/db";
import { SETTING_PREFIX } from "../src/lib/api-credentials";
import {
  fetchOzonPostings,
  fetchOzonSupplyOrders,
  fetchOzonStocks,
  ozonCredentialsFrom,
} from "../src/lib/ozon-api";

async function main() {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: `${SETTING_PREFIX}ozon.` } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key.slice(SETTING_PREFIX.length), r.value]));
  const creds = ozonCredentialsFrom({
    "ozon.clientId": typeof map["ozon.clientId"] === "string" ? map["ozon.clientId"] : "",
    "ozon.apiKey": typeof map["ozon.apiKey"] === "string" ? map["ozon.apiKey"] : "",
  });
  if (!creds) {
    console.log("no creds");
    process.exit(1);
  }

  const since = new Date(Date.now() - 7 * 86400000);
  const to = new Date();

  for (const [name, fn] of [
    ["postings", () => fetchOzonPostings(creds, since, to)],
    ["supplies", () => fetchOzonSupplyOrders(creds, since, to)],
    ["stocks", () => fetchOzonStocks(creds, ["stellage2_VKPS"])],
  ] as const) {
    try {
      const r = await fn();
      const n = "data" in r && Array.isArray(r.data) ? r.data.length : (r as { length: number }).length;
      const w = "warnings" in r && r.warnings.length ? ` (${r.warnings.join("; ")})` : "";
      console.log(`${name}: OK ${n}${w}`);
    } catch (e) {
      console.log(`${name}: FAIL`, e instanceof Error ? e.message.slice(0, 200) : e);
    }
  }

  await prisma.$disconnect();
}

main();
