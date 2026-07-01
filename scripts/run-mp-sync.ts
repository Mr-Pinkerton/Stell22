/**
 * Запуск синхронизации маркетплейсов из CLI (без cookie-сессии).
 * npx tsx scripts/run-mp-sync.ts
 */
import { prisma } from "../src/server/db";
import { syncMarketplacesAsUser } from "../src/server/marketplace";

async function main() {
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    select: { id: true, email: true },
  });
  if (!admin) {
    console.log("FAIL: нет пользователя ADMIN");
    process.exit(1);
  }

  console.log(`Синхронизация от ${admin.email}…`);
  const res = await syncMarketplacesAsUser(admin.id);

  console.log(JSON.stringify(res, null, 2));

  const lastLog = await prisma.systemLog.findFirst({
    where: { source: "Маркетплейсы" },
    orderBy: { createdAt: "desc" },
    select: { level: true, message: true, details: true, createdAt: true },
  });
  if (lastLog) {
    console.log("\nПоследняя запись SystemLog:");
    console.log(`  ${lastLog.createdAt.toISOString()} [${lastLog.level}] ${lastLog.message}`);
  }

  await prisma.$disconnect();
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
