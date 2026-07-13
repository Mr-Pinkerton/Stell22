import { prisma } from "../src/server/db";
import { SETTING_PREFIX } from "../src/lib/api-credentials";
import { ozonCredentialsFrom } from "../src/lib/ozon-api";
import { fetchJson } from "../src/lib/marketplace-http";

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

  const headers = {
    "Client-Id": creds.clientId,
    "Api-Key": creds.apiKey,
    "Content-Type": "application/json",
  };

  const id = 112006250; // COMPLETED
  for (const body of [
    { supply_order_ids: [id] },
    { order_ids: [id] },
    { supply_order_id: id },
  ]) {
    try {
      const getRes = await fetchJson("https://api-seller.ozon.ru/v3/supply-order/get", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      console.log("body", body, JSON.stringify(getRes, null, 2).slice(0, 4000));
      break;
    } catch (e) {
      console.log("fail", body, e instanceof Error ? e.message.slice(0, 120) : e);
    }
  }

  await prisma.$disconnect();
}

main();
