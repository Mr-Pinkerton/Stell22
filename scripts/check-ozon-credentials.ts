/**
 * Проверка Client-Id + Api-Key Ozon: чтение из Setting + тест Seller API.
 * Запуск: npx tsx scripts/check-ozon-credentials.ts
 */
import { prisma } from "../src/server/db";
import { SETTING_PREFIX } from "../src/lib/api-credentials";
import { fetchOzonPostings, ozonCredentialsFrom } from "../src/lib/ozon-api";
import { MarketplaceApiError, fetchJson } from "../src/lib/marketplace-http";

async function main() {
  const rows = await prisma.setting.findMany({
    where: {
      key: { in: [`${SETTING_PREFIX}ozon.clientId`, `${SETTING_PREFIX}ozon.apiKey`] },
    },
  });
  const map = new Map(rows.map((r) => [r.key.slice(SETTING_PREFIX.length), r.value]));
  const clientId = map.get("ozon.clientId");
  const apiKey = map.get("ozon.apiKey");
  const creds = ozonCredentialsFrom({
    "ozon.clientId": typeof clientId === "string" ? clientId : "",
    "ozon.apiKey": typeof apiKey === "string" ? apiKey : "",
  });

  if (!creds) {
    console.log("FAIL: Client-Id или Api-Key не заполнены в БД");
    process.exit(1);
  }

  console.log(`OK: Client-Id сохранён (${creds.clientId.length} символов)`);
  console.log(`OK: Api-Key сохранён (${creds.apiKey.length} символов, начало: ${creds.apiKey.slice(0, 8)}…)`);

  // Лёгкий ping — список складов (часто доступен при валидных ключах).
  try {
    await fetchJson("https://api-seller.ozon.ru/v1/warehouse/list", {
      method: "POST",
      headers: {
        "Client-Id": creds.clientId,
        "Api-Key": creds.apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    console.log("OK: Seller API /v1/warehouse/list — авторизация прошла");
  } catch (err) {
    if (err instanceof MarketplaceApiError) {
      console.log(`WARN: /v1/warehouse/list — ${err.message}`);
      if (err.status === 401) {
        console.log("     Неверный Client-Id или Api-Key.");
        process.exit(1);
      }
      if (err.status === 403) {
        console.log("     Ключ без нужных прав (нужен Admin read only).");
        process.exit(1);
      }
    } else {
      console.log(`WARN: ping — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const to = new Date();
  try {
    const postings = await fetchOzonPostings(creds, since, to);
    console.log(`OK: отправления FBO+FBS за 7 дней — ${postings.length} шт`);
    if (postings.length > 0) {
      const p = postings[0];
      const sku = p.products[0]?.offer_id ?? "—";
      console.log(`    пример: ${p.posting_number}, статус=${p.status}, sku=${sku}`);
    }
  } catch (err) {
    if (err instanceof MarketplaceApiError) {
      console.log(`FAIL: отправления — ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
