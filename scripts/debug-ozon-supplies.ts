import { prisma } from "../src/server/db";
import { SETTING_PREFIX } from "../src/lib/api-credentials";
import { fetchOzonSupplyOrders, ozonCredentialsFrom } from "../src/lib/ozon-api";

async function main() {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: `${SETTING_PREFIX}ozon.` } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key.slice(SETTING_PREFIX.length), r.value]));
  const creds = ozonCredentialsFrom({
    "ozon.clientId": typeof map["ozon.clientId"] === "string" ? map["ozon.clientId"] : "",
    "ozon.apiKey": typeof map["ozon.apiKey"] === "string" ? map["ozon.apiKey"] : "",
  });
  if (!creds) process.exit(1);

  const since = new Date(Date.now() - 14 * 86400000);
  const { data: supplies } = await fetchOzonSupplyOrders(creds, since, new Date());
  console.log("count", supplies.length);
  console.log("sample", supplies.slice(0, 2));
  await prisma.$disconnect();
}

main();
