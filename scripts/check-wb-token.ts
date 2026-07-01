/**
 * Проверка сохранённого токена WB.
 * npx tsx scripts/check-wb-token.ts
 */
import { prisma } from "../src/server/db";
import { SETTING_PREFIX } from "../src/lib/api-credentials";
import { fetchWbIncomes, fetchWbNmIdMapFromOrders, fetchWbSalesWithMeta, fetchWbStocks } from "../src/lib/wb-api";
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
  let hadFailure = false;

  try {
    const { data: incomes, warnings } = await fetchWbIncomes(token, since);
    console.log(`OK: поставки FBW — ${incomes.length} строк`);
    for (const w of warnings) console.log(`    WARN: ${w}`);
  } catch (err) {
    hadFailure = true;
    if (err instanceof MarketplaceApiError) {
      console.log(`FAIL: поставки FBW — ${err.message.slice(0, 200)}`);
      if (err.status === 401) {
        console.log("     Нужен токен с категорией Supplies (supplies-api.wildberries.ru).");
      }
    } else {
      console.log(`FAIL: поставки — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const { sales, nmIdToSku } = await fetchWbSalesWithMeta(token, since);
    console.log(`OK: Statistics /sales — ${sales.length} строк, nmId→sku: ${nmIdToSku.size}`);
  } catch (err) {
    if (err instanceof MarketplaceApiError && err.status === 429) {
      console.log(`WARN: Statistics /sales — rate limit (429), повторите позже`);
    } else if (err instanceof MarketplaceApiError) {
      hadFailure = true;
      console.log(`FAIL: Statistics /sales — ${err.message.slice(0, 200)}`);
    } else {
      hadFailure = true;
      console.log(`FAIL: sales — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const ordersMap = await fetchWbNmIdMapFromOrders(token, since).catch(
      () => new Map<number, string>(),
    );
    const { data: stocks, warnings } = await fetchWbStocks(token, ordersMap);
    console.log(`OK: Analytics /stocks — ${stocks.length} SKU`);
    for (const w of warnings) console.log(`    WARN: ${w}`);
  } catch (err) {
    if (err instanceof MarketplaceApiError && err.status === 429) {
      console.log(`WARN: Analytics /stocks — rate limit (429)`);
    } else {
      console.log(`WARN: остатки — ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    }
  }

  await prisma.$disconnect();
  if (hadFailure) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
