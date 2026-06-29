// Seed: наполняет БД теми же данными, что использовал UI-прототип (моки),
// чтобы оживлённые экраны выглядели идентично. Идемпотентно: перед вставкой
// чистит таблицы. Запуск: `npm run db:seed` (или авто после `prisma migrate`).

import { PrismaClient } from "@prisma/client";
import {
  batches,
  details,
  employees,
  nomenclatureItems,
  products,
  railLots,
} from "../src/mocks/fixtures";

const prisma = new PrismaClient();

function toDate(iso?: string | null): Date | null {
  return iso ? new Date(iso) : null;
}

async function main() {
  // Чистим в порядке, обратном зависимостям (FK).
  await prisma.$transaction([
    prisma.productExtra.deleteMany(),
    prisma.productFastener.deleteMany(),
    prisma.productDetail.deleteMany(),
    prisma.product.deleteMany(),
    prisma.railLot.deleteMany(),
    prisma.batch.deleteMany(),
    prisma.detailStock.deleteMany(),
    prisma.detail.deleteMany(),
    prisma.nomenclatureStock.deleteMany(),
    prisma.nomenclatureItem.deleteMany(),
    prisma.employee.deleteMany(),
    prisma.changeLog.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  // Администратор (единственный аккаунт-роль).
  await prisma.user.create({
    data: {
      id: "user-admin",
      email: "admin@stell22.local",
      // Заглушка хэша до настоящей аутентификации (Этап 5, конец).
      passwordHash: "dev-placeholder",
      name: "Администратор",
      role: "ADMIN",
    },
  });

  await prisma.employee.createMany({
    data: employees.map((e) => ({
      id: e.id,
      fullName: e.fullName,
      birthDate: toDate(e.birthDate),
      pin: e.pin,
      status: e.status,
      hourlyRate: e.hourlyRate ?? null,
      rateTorcovkaSort1: e.rateTorcovkaSort1 ?? null,
      rateTorcovkaSort2: e.rateTorcovkaSort2 ?? null,
      ratePrisadkaTorcev: e.ratePrisadkaTorcev ?? null,
      ratePrisadkaPloskt: e.ratePrisadkaPloskt ?? null,
      rateUpakovka: e.rateUpakovka ?? null,
    })),
  });

  await prisma.nomenclatureItem.createMany({
    data: nomenclatureItems.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      unitPrice: n.unitPrice,
      status: n.status,
      minStock: n.minStock ?? null,
    })),
  });

  await prisma.detail.createMany({
    data: details.map((d) => ({
      id: d.id,
      name: d.name,
      lengthM: d.lengthM,
      detailType: d.detailType,
      sort: d.sort,
      prisadkaTorcevaya: d.prisadkaTorcevaya,
      prisadkaPloskost: d.prisadkaPloskost,
      status: d.status,
    })),
  });

  await prisma.batch.createMany({
    data: batches.map((b) => ({
      id: b.id,
      name: b.name,
      sectionWidthMm: b.sectionWidthMm,
      sectionHeightMm: b.sectionHeightMm,
      purchaseCost: b.purchaseCost,
      totalCost: b.totalCost,
      priceSort1: b.priceSort1,
      priceSort2: b.priceSort2,
      status: b.status,
      purchaseDate: new Date(b.purchaseDate),
      note: b.note ?? null,
    })),
  });

  await prisma.railLot.createMany({
    data: railLots.map((l) => ({
      id: l.id,
      batchId: l.batchId,
      lengthM: l.lengthM,
      railType: l.railType,
      sort: l.sort,
      isPackage: l.isPackage,
      code: l.code ?? null,
      rows: l.rows ?? null,
      layers: l.layers ?? null,
      quantity: l.quantity,
      remainingQuantity: l.remainingQuantity,
    })),
  });

  // Начальные остатки крепежа/упаковки на складе (как в прототипе).
  const nomenclatureStock: Record<string, number> = { "nom-1": 800, "nom-2": 40 };
  for (const [nomenclatureId, quantity] of Object.entries(nomenclatureStock)) {
    await prisma.nomenclatureStock.create({ data: { nomenclatureId, quantity } });
  }

  for (const p of products) {
    await prisma.product.create({
      data: {
        id: p.id,
        name: p.name,
        sku: p.sku,
        sort: p.sort,
        salePrice: p.salePrice,
        packagingId: p.packagingId ?? null,
        status: p.status,
        details: {
          create: p.details.map((d) => ({
            detailId: d.detailId,
            quantity: d.quantity,
          })),
        },
        fasteners: {
          create: p.fastenerIds.map((f) => ({
            nomenclatureId: f.nomenclatureId,
            quantity: f.quantity,
          })),
        },
        extras: {
          create: p.extraIds.map((nomenclatureId) => ({ nomenclatureId })),
        },
      },
    });
  }

  console.log(
    `Seed готов: ${employees.length} сотр., ${nomenclatureItems.length} номенкл., ` +
      `${details.length} дет., ${batches.length} партий, ${railLots.length} реек, ${products.length} изделий.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
