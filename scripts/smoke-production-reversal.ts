// Смок-скрипт для проверки обратной разноски торцовки/присадки/упаковки
// (правка/удаление операций производства) на реальной транзакционной БД. Не входит
// в автоматический набор тестов (vitest в этом проекте — только чистые
// функции, без БД, см. .cursor/rules/testing.mdc) — запуск вручную:
// npm run smoke:production
// Использует dev-БД из .env; после прогона данные возвращаются к исходному
// состоянию через `npm run db:seed`.
import { PrismaClient } from "@prisma/client";
import {
  submitPrisadka,
  submitTorcovka,
  submitUpakovka,
} from "../src/server/terminal";
import {
  deleteProductionOperation,
  updateProductionLineQuantity,
} from "../src/server/production";

const prisma = new PrismaClient();

// Скрипт запускается вне Next.js request-контекста, поэтому `revalidatePath`
// (вызывается ПОСЛЕ успешного commit транзакции во всех проверяемых функциях)
// бросает "static generation store missing" — это ожидаемо здесь и не
// означает, что мутация данных не прошла. Глушим только эту конкретную ошибку.
async function ignoringRevalidate<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("static generation store missing")) return undefined;
    throw err;
  }
}

function assertEqual(actual: number, expected: number, label: string) {
  if (actual !== expected) {
    throw new Error(`FAIL ${label}: expected ${expected}, got ${actual}`);
  }
  console.log(`OK   ${label}: ${actual}`);
}

async function snapshotDetailStock(detailId: string) {
  const rows = await prisma.detailStock.findMany({ where: { detailId } });
  return rows.reduce((s, r) => s + r.quantity, 0);
}

async function snapshotNomenclature(nomenclatureId: string) {
  const row = await prisma.nomenclatureStock.findUnique({ where: { nomenclatureId } });
  return row?.quantity ?? 0;
}

async function snapshotProductStock(productId: string) {
  const row = await prisma.productStock.findUnique({ where: { productId } });
  return row?.quantity ?? 0;
}

async function testPrisadkaRoundtrip() {
  console.log("\n=== ПРИСАДКА: submit -> edit -> delete ===");
  const employee = await prisma.employee.findFirstOrThrow({ where: { status: "ACTIVE" } });
  const detail = await prisma.detail.findFirstOrThrow({
    where: { prisadkaTorcevaya: true },
  });

  // Гарантируем достаточный сырой остаток для теста.
  await prisma.detailStock.upsert({
    where: { detailId_torcevayaDone_ploskostDone: { detailId: detail.id, torcevayaDone: false, ploskostDone: false } },
    create: { detailId: detail.id, torcevayaDone: false, ploskostDone: false, quantity: 100 },
    update: { quantity: { increment: 100 } },
  });

  const totalBefore = await snapshotDetailStock(detail.id);
  const readyBefore =
    (await prisma.detailStock.findFirst({
      where: { detailId: detail.id, torcevayaDone: true, ploskostDone: false },
    }))?.quantity ?? 0;
  const rawBefore =
    (await prisma.detailStock.findFirst({
      where: { detailId: detail.id, torcevayaDone: false, ploskostDone: false },
    }))?.quantity ?? 0;

  await ignoringRevalidate(() =>
    submitPrisadka({
      employeeId: employee.id,
      picks: [{ detailId: detail.id, kind: "torcev", quantity: 10 }],
    }),
  );
  const totalAfterSubmit = await snapshotDetailStock(detail.id);
  assertEqual(totalAfterSubmit, totalBefore, "суммарный остаток детали не меняется после присадки");

  const op = await prisma.productionOperation.findFirstOrThrow({
    where: { type: "PRISADKA", employeeId: employee.id },
    orderBy: { createdAt: "desc" },
    include: { lines: true },
  });
  const readyAfterSubmit =
    (await prisma.detailStock.findFirst({
      where: { detailId: detail.id, torcevayaDone: true, ploskostDone: false },
    }))?.quantity ?? 0;
  assertEqual(readyAfterSubmit - readyBefore, 10, "присажено +10 шт (torcev)");

  // Правка: увеличиваем с 10 до 15.
  await ignoringRevalidate(() => updateProductionLineQuantity(op.id, 0, 15));
  const afterEdit =
    (await prisma.detailStock.findFirst({
      where: { detailId: detail.id, torcevayaDone: true, ploskostDone: false },
    }))?.quantity ?? 0;
  assertEqual(afterEdit - readyBefore, 15, "после правки присажено +15 шт (torcev)");
  const totalAfterEdit = await snapshotDetailStock(detail.id);
  assertEqual(totalAfterEdit, totalBefore, "суммарный остаток детали не меняется после правки присадки");

  // Удаление — должно вернуть всё в исходное сырое состояние.
  await ignoringRevalidate(() => deleteProductionOperation(op.id));
  const totalAfterDelete = await snapshotDetailStock(detail.id);
  assertEqual(totalAfterDelete, totalBefore, "суммарный остаток детали не меняется после удаления присадки");
  const rawAfterDelete =
    (await prisma.detailStock.findFirst({
      where: { detailId: detail.id, torcevayaDone: false, ploskostDone: false },
    }))?.quantity ?? 0;
  assertEqual(rawAfterDelete, rawBefore, "весь остаток вернулся в сырую стадию");
}

async function testUpakovkaRoundtrip() {
  console.log("\n=== УПАКОВКА: submit -> edit -> delete ===");
  const employee = await prisma.employee.findFirstOrThrow({ where: { status: "ACTIVE" } });
  const product = await prisma.product.findFirstOrThrow({
    include: { details: true, fasteners: true },
    where: { details: { some: {} } },
  });

  // Готовим достаточный запас готовых деталей/крепежа/упаковки под 5 изделий.
  for (const pd of product.details) {
    // (true, true) — готово при любых требуемых присадках детали.
    await prisma.detailStock.upsert({
      where: {
        detailId_torcevayaDone_ploskostDone: { detailId: pd.detailId, torcevayaDone: true, ploskostDone: true },
      },
      create: { detailId: pd.detailId, torcevayaDone: true, ploskostDone: true, quantity: 100 },
      update: { quantity: { increment: 100 } },
    });
  }
  for (const f of product.fasteners) {
    await prisma.nomenclatureStock.upsert({
      where: { nomenclatureId: f.nomenclatureId },
      create: { nomenclatureId: f.nomenclatureId, quantity: 1000 },
      update: { quantity: { increment: 1000 } },
    });
  }
  if (product.packagingId) {
    await prisma.nomenclatureStock.upsert({
      where: { nomenclatureId: product.packagingId },
      create: { nomenclatureId: product.packagingId, quantity: 1000 },
      update: { quantity: { increment: 1000 } },
    });
  }

  const detailTotalsBefore = new Map<string, number>();
  for (const pd of product.details) {
    detailTotalsBefore.set(pd.detailId, await snapshotDetailStock(pd.detailId));
  }
  const nomTotalsBefore = new Map<string, number>();
  for (const f of product.fasteners) nomTotalsBefore.set(f.nomenclatureId, await snapshotNomenclature(f.nomenclatureId));
  if (product.packagingId) nomTotalsBefore.set(product.packagingId, await snapshotNomenclature(product.packagingId));
  const productStockBefore = await snapshotProductStock(product.id);

  await ignoringRevalidate(() =>
    submitUpakovka({ employeeId: employee.id, picks: [{ productId: product.id, quantity: 5 }] }),
  );
  const productStockAfterSubmit = await snapshotProductStock(product.id);
  assertEqual(productStockAfterSubmit, productStockBefore + 5, "приход 5 изделий на склад");

  const op = await prisma.productionOperation.findFirstOrThrow({
    where: { type: "UPAKOVKA", employeeId: employee.id, productId: product.id },
    orderBy: { createdAt: "desc" },
  });

  // Правка: 5 -> 3 изделия (часть материала должна вернуться).
  await ignoringRevalidate(() => updateProductionLineQuantity(op.id, 0, 3));
  const productStockAfterEdit = await snapshotProductStock(product.id);
  assertEqual(productStockAfterEdit, productStockBefore + 3, "после правки на складе 3 изделия");

  // Удаление — всё возвращается в исходное состояние.
  await ignoringRevalidate(() => deleteProductionOperation(op.id));
  const productStockAfterDelete = await snapshotProductStock(product.id);
  assertEqual(productStockAfterDelete, productStockBefore, "остаток изделия вернулся к исходному после удаления");

  for (const pd of product.details) {
    const totalAfter = await snapshotDetailStock(pd.detailId);
    assertEqual(totalAfter, detailTotalsBefore.get(pd.detailId)!, `остаток детали ${pd.detailId} вернулся к исходному`);
  }
  for (const f of product.fasteners) {
    const totalAfter = await snapshotNomenclature(f.nomenclatureId);
    assertEqual(totalAfter, nomTotalsBefore.get(f.nomenclatureId)!, `остаток крепежа ${f.nomenclatureId} вернулся к исходному`);
  }
  if (product.packagingId) {
    const totalAfter = await snapshotNomenclature(product.packagingId);
    assertEqual(totalAfter, nomTotalsBefore.get(product.packagingId)!, "остаток упаковки вернулся к исходному");
  }
}

async function testTorcovkaDeleteDoesNotReturnRails() {
  console.log("\n=== ТОРЦОВКА: удаление НЕ возвращает рейки (списание = отход) ===");
  const employee = await prisma.employee.findFirstOrThrow({ where: { status: "ACTIVE" } });
  const lot = await prisma.railLot.findFirstOrThrow({ where: { remainingQuantity: { gte: 5 } } });
  const detail = await prisma.detail.findFirstOrThrow({ where: { detailType: lot.railType } });

  const blankBefore =
    (await prisma.blankStock.findFirst({
      where: { lengthM: detail.lengthM, detailType: detail.detailType, sort: detail.sort },
    }))?.quantity ?? 0;
  const remainingBefore = lot.remainingQuantity;

  await ignoringRevalidate(() =>
    submitTorcovka({
      employeeId: employee.id,
      batchId: lot.batchId,
      railLotId: lot.id,
      railsTaken: 5,
      picks: [{ lengthM: Number(detail.lengthM), quantity: 20 }],
    }),
  );

  const remainingAfterSubmit = (await prisma.railLot.findUniqueOrThrow({ where: { id: lot.id } }))
    .remainingQuantity;
  assertEqual(remainingAfterSubmit, remainingBefore - 5, "рейки списаны из пакета при торцовке");

  const op = await prisma.productionOperation.findFirstOrThrow({
    where: { type: "TORCOVKA", employeeId: employee.id, railLotId: lot.id },
    orderBy: { createdAt: "desc" },
  });

  // Удаляем запись — рейки НЕ должны вернуться в пакет (они уже распилены),
  // а произведённые заготовки должны уйти со склада заготовок.
  await ignoringRevalidate(() => deleteProductionOperation(op.id));

  const remainingAfterDelete = (await prisma.railLot.findUniqueOrThrow({ where: { id: lot.id } }))
    .remainingQuantity;
  assertEqual(remainingAfterDelete, remainingBefore - 5, "рейки НЕ возвращены в пакет после удаления");

  const blankAfterDelete =
    (await prisma.blankStock.findFirst({
      where: { lengthM: detail.lengthM, detailType: detail.detailType, sort: detail.sort },
    }))?.quantity ?? 0;
  assertEqual(blankAfterDelete, blankBefore, "произведённые заготовки сняты со склада заготовок");

  console.log(
    "OK   5 реек остаются «взятыми» без записи о производстве — это и есть отход по партии",
  );
}

const BUSINESS_ERROR_MARKER = "уже использована в упаковке или дальнейшей присадке";

async function testPrisadkaDeleteBlockedWhenConsumedFurther() {
  console.log("\n=== ПРИСАДКА: удаление блокируется, если деталь ушла дальше ===");
  const employee = await prisma.employee.findFirstOrThrow({ where: { status: "ACTIVE" } });
  // Деталь, требующая ОБЕ присадки — после второй присадка-операция первого
  // типа больше не может быть отменена «как было» без ухода в минус.
  const detail = await prisma.detail.findFirstOrThrow({
    where: { prisadkaTorcevaya: true, prisadkaPloskost: true },
  });

  // Полностью изолируем сток детали от посевных данных, чтобы гарантировать
  // детерминированный источник для allocate() (иначе распределение зависит
  // от порядка id уже существующих строк остатка).
  await prisma.detailStock.deleteMany({ where: { detailId: detail.id } });
  // Ровно 10 шт сырья — после первой присадки (torcev, 10) сырой остаток
  // истощится полностью, и единственным источником для второй присадки
  // (plosk) станет результат ПЕРВОЙ операции (true,false,10).
  await prisma.detailStock.create({
    data: { detailId: detail.id, torcevayaDone: false, ploskostDone: false, quantity: 10 },
  });

  await ignoringRevalidate(() =>
    submitPrisadka({ employeeId: employee.id, picks: [{ detailId: detail.id, kind: "torcev", quantity: 10 }] }),
  );
  const opTorcev = await prisma.productionOperation.findFirstOrThrow({
    where: { type: "PRISADKA", employeeId: employee.id },
    orderBy: { createdAt: "desc" },
  });

  // Вторая присадка переводит эти же 10 шт (единственный источник — raw) в (true, true).
  await ignoringRevalidate(() =>
    submitPrisadka({ employeeId: employee.id, picks: [{ detailId: detail.id, kind: "plosk", quantity: 10 }] }),
  );

  const rawBefore =
    (await prisma.detailStock.findFirst({
      where: { detailId: detail.id, torcevayaDone: false, ploskostDone: false },
    }))?.quantity ?? 0;

  let caughtBusinessError = false;
  try {
    await deleteProductionOperation(opTorcev.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(BUSINESS_ERROR_MARKER)) {
      caughtBusinessError = true;
    } else if (!msg.includes("static generation store missing")) {
      throw err;
    }
    // Если словили именно "static generation store missing" — значит удаление
    // фактически ПРОШЛО (мутация уже закоммичена), это провал теста ниже по
    // проверке наличия операции в БД.
  }

  const opStillExists = await prisma.productionOperation.findUnique({ where: { id: opTorcev.id } });
  if (!opStillExists) {
    throw new Error(
      "FAIL: операция удалена, хотя деталь уже ушла в plosk (обратная разноска должна была заблокировать удаление)",
    );
  }
  if (!caughtBusinessError) {
    throw new Error("FAIL: ожидалась бизнес-ошибка cost-integrity, но её не было");
  }
  console.log("OK   удаление первой присадки заблокировано (деталь ушла в plosk), операция осталась в БД");

  const rawAfter =
    (await prisma.detailStock.findFirst({
      where: { detailId: detail.id, torcevayaDone: false, ploskostDone: false },
    }))?.quantity ?? 0;
  assertEqual(rawAfter, rawBefore, "сырой остаток не изменился после неудачной попытки удаления (rollback)");
}

async function main() {
  await testTorcovkaDeleteDoesNotReturnRails();
  await testPrisadkaRoundtrip();
  await testUpakovkaRoundtrip();
  await testPrisadkaDeleteBlockedWhenConsumedFurther();
  console.log("\nВСЁ ОК");
}

main()
  .catch((err) => {
    console.error("\nSMOKE FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
