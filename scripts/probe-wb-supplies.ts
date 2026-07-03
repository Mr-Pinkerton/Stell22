import { prisma } from "../src/server/db";
import { SETTING_PREFIX } from "../src/lib/api-credentials";

async function main() {
  const row = await prisma.setting.findUnique({ where: { key: `${SETTING_PREFIX}wb.token` } });
  const token = String(row?.value ?? "").trim();
  const dateFrom = new Date(Date.now() - 7 * 86400000).toISOString();
  const headers = { Authorization: token, Accept: "application/json" };

  for (const url of [
    `https://statistics-api.wildberries.ru/api/v1/supplier/incomes?dateFrom=${encodeURIComponent(dateFrom)}`,
    `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(dateFrom)}`,
  ]) {
    const r = await fetch(url, { headers });
    const t = await r.text();
    console.log(r.status, url.split("?")[0], t.slice(0, 150));
  }
  await prisma.$disconnect();
}

main();
