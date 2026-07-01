/**
 * Проверка сохранённого токена WB: чтение из Setting + один запрос к Statistics API.
 * Запуск: npx tsx scripts/check-wb-token.ts
 */
import { prisma } from "../src/server/db";
import { SETTING_PREFIX } from "../src/lib/api-credentials";
import { fetchWbSalesWithMeta } from "../src/lib/wb-api";
import { MarketplaceApiError } from "../src/lib/marketplace-http";

async function main() {
  const row = await prisma.setting.findUnique({
    where: { key: `${SETTING_PREFIX}wb.token` },
  });
  const token = typeof row?.value === "string" ? row.value.trim() : "";

  if (!token) {
    console.log("FAIL: токен WB не найден в БД (Setting apiCred:wb.token пуст)");
    process.exit(1);
  }

  console.log(`OK: токен в БД сохранён (${token.length} символов, начало: ${token.slice(0, 8)}…)`);

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  try {
    const { sales, nmIdToSku } = await fetchWbSalesWithMeta(token, since);
    console.log(`OK: Statistics API /supplier/sales — ${sales.length} строк за 7 дней`);
    console.log(`    nmId→артикул в карте: ${nmIdToSku.size}`);
    if (sales.length > 0) {
      const sample = sales[0];
      console.log(
        `    пример: saleID=${sample.saleID}, sku=${sample.supplierArticle}, цена=${sample.finishedPrice}`,
      );
    }
  } catch (err) {
    if (err instanceof MarketplaceApiError) {
      console.log(`FAIL: Statistics API /sales — ${err.message}`);
      if (err.status === 401) {
        console.log("     Возможно неверный токен или нет категории Statistics.");
      }
      if (err.status === 403) {
        console.log("     Токен без доступа к Statistics API.");
      }
    } else {
      console.log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  try {
    const { fetchWbIncomes } = await import("../src/lib/wb-api");
    const incomes = await fetchWbIncomes(token, since);
    console.log(`OK: поставки FBW — ${incomes.length} строк`);
  } catch (err) {
    if (err instanceof MarketplaceApiError) {
      console.log(`WARN: поставки FBW — ${err.message}`);
      if (err.status === 401) {
        console.log("     Нужен токен с категорией Supplies (supplies-api.wildberries.ru).");
      }
    } else {
      console.log(`WARN: поставки — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
