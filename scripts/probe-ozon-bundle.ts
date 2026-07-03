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

  const ids = [
    "019ed9de-d018-7d44-bf83-cc764c389795",
    "019edacb-9f0c-780b-aa55-24a0b4d7415b",
  ];

  const r = await fetchJson("https://api-seller.ozon.ru/v1/supply-order/bundle", {
    method: "POST",
    headers,
    body: JSON.stringify({ bundle_ids: ids, limit: 100 }),
  });
  console.log(JSON.stringify(r, null, 2).slice(0, 2500));

  await prisma.$disconnect();
}

main();
