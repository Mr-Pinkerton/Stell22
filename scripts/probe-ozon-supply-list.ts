import { prisma } from "../src/server/db";
import { SETTING_PREFIX } from "../src/lib/api-credentials";
import { ozonCredentialsFrom } from "../src/lib/ozon-api";
import { fetchJson } from "../src/lib/marketplace-http";

const STATES = [
  "DATA_FILLING", "READY_TO_SUPPLY", "ACCEPTED_AT_SUPPLY_WAREHOUSE", "IN_TRANSIT",
  "ACCEPTANCE_AT_STORAGE_WAREHOUSE", "REPORTS_CONFIRMATION_AWAITING", "REPORT_REJECTED",
  "COMPLETED", "REJECTED_AT_SUPPLY_WAREHOUSE", "CANCELLED", "OVERDUE",
];

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

  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const to = new Date().toISOString();
  const headers = {
    "Client-Id": creds.clientId,
    "Api-Key": creds.apiKey,
    "Content-Type": "application/json",
  };

  let last_id: string | undefined;
  let total = 0;
  for (let p = 0; p < 5; p++) {
    const body: Record<string, unknown> = {
      since, to, limit: 100, sort_by: 1, filter: { states: STATES },
    };
    if (last_id) body.last_id = last_id;
    const r = await fetchJson<{ order_ids?: number[]; last_id?: string }>(
      "https://api-seller.ozon.ru/v3/supply-order/list",
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    total += r.order_ids?.length ?? 0;
    console.log("page", p, "got", r.order_ids?.length, "last_id", JSON.stringify(r.last_id));
    if (!r.last_id) break;
    last_id = r.last_id;
  }
  console.log("total", total);
  await prisma.$disconnect();
}

main();
