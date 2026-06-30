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
import {
  financeAccounts,
  financeArticles,
  financeAutoRules,
  financeCashFlows,
  financeCounterparties,
  financeDeals,
} from "../src/mocks/finance-fixtures";

const prisma = new PrismaClient();

function toDate(iso?: string | null): Date | null {
  return iso ? new Date(iso) : null;
}

async function main() {
  // Полный сброс к состоянию прототипа. Порядок строго от детей к родителям (FK).
  await prisma.$transaction([
    // выплаты / снапшоты себестоимости
    prisma.paymentBatchItem.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.batchCost.deleteMany(),
    prisma.productCost.deleteMany(),
    // производство
    prisma.operationDetailLine.deleteMany(),
    prisma.productionOperation.deleteMany(),
    // финансы (cashflow ссылается на счёт/статью/сделку/контрагента/выписку)
    prisma.cashFlow.deleteMany(),
    prisma.autoRule.deleteMany(),
    prisma.statement.deleteMany(),
    prisma.dealItem.deleteMany(),
    prisma.deal.deleteMany(),
    prisma.article.deleteMany(),
    prisma.articleCategory.deleteMany(),
    prisma.counterparty.deleteMany(),
    prisma.account.deleteMany(),
    // планы / инвентаризация / остатки
    prisma.goal.deleteMany(),
    prisma.inventoryLine.deleteMany(),
    prisma.inventory.deleteMany(),
    prisma.mpStock.deleteMany(),
    prisma.productStock.deleteMany(),
    prisma.detailStock.deleteMany(),
    prisma.nomenclatureStock.deleteMany(),
    prisma.simplePurchase.deleteMany(),
    // каталог
    prisma.productExtra.deleteMany(),
    prisma.productFastener.deleteMany(),
    prisma.productDetail.deleteMany(),
    prisma.product.deleteMany(),
    prisma.railLot.deleteMany(),
    prisma.batch.deleteMany(),
    prisma.detail.deleteMany(),
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

  // ============================ ФИНАНСЫ ====================================

  await prisma.account.createMany({
    data: financeAccounts.map((a) => ({ id: a.id, name: a.name, balance: a.balance })),
  });

  await prisma.counterparty.createMany({
    data: financeCounterparties.map((c) => ({ id: c.id, name: c.name })),
  });

  // Категории статей выводим из статей (id «cat-N»), накладные — флаг isOverhead.
  const categoryByName = new Map<string, { id: string; isOverhead: boolean }>();
  let categoryIndex = 1;
  for (const a of financeArticles) {
    const existing = categoryByName.get(a.categoryName);
    if (existing) {
      if (a.isOverhead) existing.isOverhead = true;
    } else {
      categoryByName.set(a.categoryName, { id: `cat-${categoryIndex++}`, isOverhead: a.isOverhead });
    }
  }
  await prisma.articleCategory.createMany({
    data: [...categoryByName.entries()].map(([name, c]) => ({
      id: c.id,
      name,
      isOverhead: c.isOverhead,
    })),
  });

  // Статьи: сначала корневые, затем субстатьи (self-FK parentId).
  const articlesRootFirst = [...financeArticles].sort((a, b) =>
    a.parentId === b.parentId ? 0 : a.parentId ? 1 : -1,
  );
  await prisma.article.createMany({
    data: articlesRootFirst.map((a) => ({
      id: a.id,
      name: a.name,
      flowType: a.flowType,
      categoryId: categoryByName.get(a.categoryName)!.id,
      parentId: a.parentId,
      description: a.description ?? null,
    })),
  });

  await prisma.deal.createMany({
    data: financeDeals.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      total: d.total,
    })),
  });

  // Привязка партий к сделкам (по имени партии).
  const batchIdByName = new Map(batches.map((b) => [b.name, b.id]));
  const dealItems = financeDeals.flatMap((d) =>
    d.batchNames
      .map((name) => batchIdByName.get(name))
      .filter((id): id is string => Boolean(id))
      .map((batchId) => ({ dealId: d.id, batchId })),
  );
  if (dealItems.length > 0) await prisma.dealItem.createMany({ data: dealItems });

  const dealIdByName = new Map(financeDeals.map((d) => [d.name, d.id]));
  const articleIdByName = new Map(financeArticles.map((a) => [a.name, a.id]));
  const counterpartyIdByName = new Map(financeCounterparties.map((c) => [c.name, c.id]));
  const accountIdByName = new Map(financeAccounts.map((a) => [a.name, a.id]));

  await prisma.autoRule.createMany({
    data: financeAutoRules.map((r) => ({
      id: r.id,
      flowType: r.flowType,
      counterpartyId: r.counterpartyName ? counterpartyIdByName.get(r.counterpartyName) ?? null : null,
      articleId: r.articleName ? articleIdByName.get(r.articleName) ?? null : null,
      dealId: r.dealName ? dealIdByName.get(r.dealName) ?? null : null,
      logicOperator: r.logicOperator,
      descriptionKeywords: r.descriptionKeywords,
    })),
  });

  await prisma.cashFlow.createMany({
    data: financeCashFlows.map((cf) => ({
      id: cf.id,
      amount: cf.amount,
      flowType: cf.flowType,
      accountId: accountIdByName.get(cf.accountName)!,
      counterpartyId: cf.counterpartyName ? counterpartyIdByName.get(cf.counterpartyName) ?? null : null,
      description: cf.description,
      articleId: cf.articleName ? articleIdByName.get(cf.articleName) ?? null : null,
      dealId: cf.dealId,
      date: new Date(cf.date),
      isAutoAssigned: cf.isAutoAssigned,
    })),
  });

  console.log(
    `Seed готов: ${employees.length} сотр., ${nomenclatureItems.length} номенкл., ` +
      `${details.length} дет., ${batches.length} партий, ${railLots.length} реек, ${products.length} изделий, ` +
      `${financeAccounts.length} счетов, ${financeArticles.length} статей, ${financeCashFlows.length} операций ДДС.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
