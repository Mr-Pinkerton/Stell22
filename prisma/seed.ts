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
import { batchExtraShare, batchTotalCost, dealDeliveryExtra } from "../src/lib/deal-cost";
import { hashPassword } from "../src/lib/password";

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
    prisma.operationNomenclatureLine.deleteMany(),
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
    prisma.sale.deleteMany(),
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

  // Администратор (единственный аккаунт-роль). Пароль для локальной разработки
  // берётся из SEED_ADMIN_PASSWORD (по умолчанию — admin123).
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "admin123";
  await prisma.user.create({
    data: {
      id: "user-admin",
      email: "admin@stell22.local",
      passwordHash: await hashPassword(adminPassword),
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

  // Начальные остатки крепежа/упаковки на складе (с запасом под демо-упаковку).
  const nomenclatureStock: Record<string, number> = { "nom-1": 2000, "nom-2": 200 };
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

  // ===================== ПРОИЗВОДСТВО (демо-операции) ======================
  // Связный набор операций с соблюдением целостности склада и логики стадий
  // (как с терминала): торцовка снимает рейки и приходует сырые детали,
  // присадка переводит детали по стадиям, упаковка списывает готовые детали +
  // крепёж/упаковку и приходует ГП. Метры произведённого < взятых (отход ~12%).
  // В Части B эти данные заменятся реальными внесениями терминала.

  const addRawStock = (detailId: string, qty: number) =>
    prisma.detailStock.upsert({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId,
          torcevayaDone: false,
          ploskostDone: false,
        },
      },
      create: { detailId, torcevayaDone: false, ploskostDone: false, quantity: qty },
      update: { quantity: { increment: qty } },
    });

  const moveStock = async (
    detailId: string,
    from: { t: boolean; p: boolean },
    to: { t: boolean; p: boolean },
    qty: number,
  ) => {
    await prisma.detailStock.update({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId,
          torcevayaDone: from.t,
          ploskostDone: from.p,
        },
      },
      data: { quantity: { decrement: qty } },
    });
    await prisma.detailStock.upsert({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId,
          torcevayaDone: to.t,
          ploskostDone: to.p,
        },
      },
      create: { detailId, torcevayaDone: to.t, ploskostDone: to.p, quantity: qty },
      update: { quantity: { increment: qty } },
    });
  };

  const torcovka = async (o: {
    employeeId: string;
    batchId: string;
    railLotId: string;
    railsTaken: number;
    date: string;
    lines: { detailId: string; quantity: number }[];
  }) => {
    await prisma.railLot.update({
      where: { id: o.railLotId },
      data: { remainingQuantity: { decrement: o.railsTaken } },
    });
    await prisma.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: o.employeeId,
        batchId: o.batchId,
        railLotId: o.railLotId,
        railsTaken: o.railsTaken,
        workDate: new Date(o.date),
        lines: { create: o.lines },
      },
    });
    for (const l of o.lines) await addRawStock(l.detailId, l.quantity);
  };

  await torcovka({ employeeId: "emp-1", batchId: "batch-1", railLotId: "lot-1", railsTaken: 40, date: "2026-06-23", lines: [{ detailId: "det-1", quantity: 140 }] });
  await torcovka({ employeeId: "emp-1", batchId: "batch-1", railLotId: "lot-3", railsTaken: 30, date: "2026-06-24", lines: [{ detailId: "det-4", quantity: 132 }] });
  await torcovka({ employeeId: "emp-3", batchId: "batch-1", railLotId: "lot-2", railsTaken: 30, date: "2026-06-24", lines: [{ detailId: "det-3", quantity: 79 }] });
  await torcovka({ employeeId: "emp-3", batchId: "batch-2", railLotId: "lot-8", railsTaken: 40, date: "2026-06-25", lines: [{ detailId: "det-1", quantity: 158 }] });
  await torcovka({ employeeId: "emp-1", batchId: "batch-2", railLotId: "lot-11", railsTaken: 15, date: "2026-06-26", lines: [{ detailId: "det-2", quantity: 58 }] });

  const prisadka = async (o: {
    employeeId: string;
    detailId: string;
    kind: "torcev" | "plosk";
    quantity: number;
    date: string;
    from: { t: boolean; p: boolean };
  }) => {
    const to =
      o.kind === "torcev" ? { t: true, p: o.from.p } : { t: o.from.t, p: true };
    await prisma.productionOperation.create({
      data: {
        type: "PRISADKA",
        employeeId: o.employeeId,
        workDate: new Date(o.date),
        lines: {
          create: [
            {
              detailId: o.detailId,
              quantity: o.quantity,
              prisadkaTorcevaya: o.kind === "torcev",
              prisadkaPloskost: o.kind === "plosk",
              // Провенанс (откуда списано) — нужен для обратной разноски при
              // правке/удалении, см. src/server/terminal.ts.
              sourceTorcevayaDone: o.from.t,
              sourcePloskostDone: o.from.p,
            },
          ],
        },
      },
    });
    await moveStock(o.detailId, o.from, to, o.quantity);
  };

  await prisadka({ employeeId: "emp-1", detailId: "det-1", kind: "torcev", quantity: 200, date: "2026-06-26", from: { t: false, p: false } });
  await prisadka({ employeeId: "emp-3", detailId: "det-3", kind: "torcev", quantity: 60, date: "2026-06-26", from: { t: false, p: false } });
  await prisadka({ employeeId: "emp-1", detailId: "det-2", kind: "torcev", quantity: 55, date: "2026-06-27", from: { t: false, p: false } });
  await prisadka({ employeeId: "emp-1", detailId: "det-2", kind: "plosk", quantity: 50, date: "2026-06-27", from: { t: true, p: false } });

  const upakovka = async (o: {
    employeeId: string;
    productId: string;
    quantity: number;
    date: string;
    details: { detailId: string; ready: { t: boolean; p: boolean }; per: number }[];
    fasteners: { nomenclatureId: string; per: number }[];
    packagingId: string;
  }) => {
    for (const d of o.details) {
      await prisma.detailStock.update({
        where: {
          detailId_torcevayaDone_ploskostDone: {
            detailId: d.detailId,
            torcevayaDone: d.ready.t,
            ploskostDone: d.ready.p,
          },
        },
        data: { quantity: { decrement: d.per * o.quantity } },
      });
    }
    for (const f of o.fasteners) {
      await prisma.nomenclatureStock.update({
        where: { nomenclatureId: f.nomenclatureId },
        data: { quantity: { decrement: f.per * o.quantity } },
      });
    }
    await prisma.nomenclatureStock.update({
      where: { nomenclatureId: o.packagingId },
      data: { quantity: { decrement: o.quantity } },
    });
    await prisma.productStock.upsert({
      where: { productId: o.productId },
      create: { productId: o.productId, quantity: o.quantity },
      update: { quantity: { increment: o.quantity } },
    });
    await prisma.productionOperation.create({
      data: {
        type: "UPAKOVKA",
        employeeId: o.employeeId,
        productId: o.productId,
        productQty: o.quantity,
        workDate: new Date(o.date),
        // Провенанс списания — нужен для обратной разноски при правке/
        // удалении (см. src/server/terminal.ts, reverseUpakovkaOperation).
        lines: {
          create: o.details.map((d) => ({
            detailId: d.detailId,
            quantity: d.per * o.quantity,
            sourceTorcevayaDone: d.ready.t,
            sourcePloskostDone: d.ready.p,
          })),
        },
        nomenclatureLines: {
          create: [
            ...o.fasteners.map((f) => ({ nomenclatureId: f.nomenclatureId, quantity: f.per * o.quantity })),
            { nomenclatureId: o.packagingId, quantity: o.quantity },
          ],
        },
      },
    });
  };

  await upakovka({
    employeeId: "emp-2",
    productId: "prod-1",
    quantity: 90,
    date: "2026-06-29",
    details: [{ detailId: "det-1", ready: { t: true, p: false }, per: 2 }],
    fasteners: [{ nomenclatureId: "nom-1", per: 8 }],
    packagingId: "nom-2",
  });
  await upakovka({
    employeeId: "emp-2",
    productId: "prod-2",
    quantity: 30,
    date: "2026-06-29",
    details: [
      { detailId: "det-3", ready: { t: true, p: false }, per: 2 },
      { detailId: "det-2", ready: { t: true, p: true }, per: 1 },
    ],
    fasteners: [{ nomenclatureId: "nom-1", per: 12 }],
    packagingId: "nom-2",
  });

  // Часы (почасовая ЗП) — без влияния на склад.
  const hourLogs: { employeeId: string; date: string; hours: number }[] = [
    { employeeId: "emp-1", date: "2026-06-22", hours: 8 },
    { employeeId: "emp-1", date: "2026-06-23", hours: 8 },
    { employeeId: "emp-1", date: "2026-06-24", hours: 7.5 },
    { employeeId: "emp-1", date: "2026-06-25", hours: 8 },
    { employeeId: "emp-1", date: "2026-06-26", hours: 8 },
    { employeeId: "emp-2", date: "2026-06-22", hours: 8 },
    { employeeId: "emp-2", date: "2026-06-23", hours: 8 },
    { employeeId: "emp-2", date: "2026-06-24", hours: 8 },
    { employeeId: "emp-2", date: "2026-06-25", hours: 6 },
    { employeeId: "emp-3", date: "2026-06-24", hours: 8 },
    { employeeId: "emp-3", date: "2026-06-25", hours: 8 },
    { employeeId: "emp-3", date: "2026-06-26", hours: 8 },
  ];
  await prisma.productionOperation.createMany({
    data: hourLogs.map((h) => ({
      type: "HOURS" as const,
      employeeId: h.employeeId,
      workDate: new Date(h.date),
      hours: h.hours,
      isPaid: false,
    })),
  });

  // ===================== ЦЕЛИ ==============================================
  // Активные на июнь 2026 (факт — из операций упаковки этого месяца) и архив мая.
  await prisma.goal.createMany({
    data: [
      { name: "Июнь — полки настенные", productId: "prod-1", quantity: 300, month: new Date(2026, 5, 1), status: "ACTIVE" },
      { name: "Июнь — угловые", productId: "prod-2", quantity: 180, month: new Date(2026, 5, 1), status: "ACTIVE" },
      { name: "Май — полки", productId: "prod-1", quantity: 280, month: new Date(2026, 4, 1), status: "ARCHIVED" },
      { name: "Май — угловые", productId: "prod-2", quantity: 150, month: new Date(2026, 4, 1), status: "ARCHIVED" },
    ],
  });

  // ===================== ПРОДАЖИ / ОСТАТКИ МП (стартовый снимок) ============
  // Имитация уже полученных с маркетплейсов данных; обновляется кнопкой
  // «Синхронизировать» (server/marketplace — заглушка вместо Ozon/WB API).
  const priceById = new Map(products.map((p) => [p.id, p.salePrice]));
  const saleSeed: { mp: string; productId: string; sku: string; qty: number; date: string }[] = [
    { mp: "OZON", productId: "prod-1", sku: "ART-001", qty: 48, date: "2026-06-10" },
    { mp: "OZON", productId: "prod-2", sku: "ART-002", qty: 22, date: "2026-06-14" },
    { mp: "WB", productId: "prod-1", sku: "ART-001", qty: 31, date: "2026-06-12" },
    { mp: "WB", productId: "prod-2", sku: "ART-002", qty: 18, date: "2026-06-18" },
    { mp: "OZON", productId: "prod-1", sku: "ART-001", qty: 27, date: "2026-06-24" },
  ];
  await prisma.sale.createMany({
    data: saleSeed.map((s) => ({
      marketplace: s.mp,
      sku: s.sku,
      productId: s.productId,
      quantity: s.qty,
      revenue: (priceById.get(s.productId) ?? 0) * s.qty,
      date: new Date(s.date),
    })),
  });
  await prisma.mpStock.createMany({
    data: [
      { marketplace: "OZON", sku: "ART-001", quantity: 28 },
      { marketplace: "OZON", sku: "ART-002", quantity: 12 },
      { marketplace: "WB", sku: "ART-001", quantity: 15 },
      { marketplace: "WB", sku: "ART-002", quantity: 7 },
    ],
  });

  // ============================ ФИНАНСЫ ====================================

  await prisma.account.createMany({
    data: financeAccounts.map((a) => ({ id: a.id, name: a.name, balance: a.balance })),
  });

  await prisma.counterparty.createMany({
    data: financeCounterparties.map((c) => ({ id: c.id, name: c.name, inn: c.inn ?? null })),
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

  // Согласуем «Стоимость общую» партий с доставкой/доп. расходами их сделок,
  // чтобы стартовое состояние совпадало с движком (закупка + доставка из ДДС).
  const dealsForSync = await prisma.deal.findMany({
    include: { items: { include: { batch: true } }, cashFlows: true },
  });
  for (const deal of dealsForSync) {
    const expense = deal.cashFlows
      .filter((c) => c.flowType === "EXPENSE")
      .reduce((s, c) => s + Number(c.amount), 0);
    const purchaseTotal = deal.items.reduce((s, i) => s + Number(i.batch?.purchaseCost ?? 0), 0);
    const extra = dealDeliveryExtra(expense, purchaseTotal);
    for (const item of deal.items) {
      if (!item.batchId || !item.batch) continue;
      const share = batchExtraShare(
        extra,
        Number(item.batch.purchaseCost),
        purchaseTotal,
        deal.items.length,
      );
      const total = batchTotalCost(Number(item.batch.purchaseCost), share);
      await prisma.batch.update({ where: { id: item.batchId }, data: { totalCost: total.toFixed(2) } });
    }
  }

  console.log(
    `Seed готов: ${employees.length} сотр., ${nomenclatureItems.length} номенкл., ` +
      `${details.length} дет., ${batches.length} партий, ${railLots.length} реек, ${products.length} изделий, ` +
      `${financeAccounts.length} счетов, ${financeArticles.length} статей, ${financeCashFlows.length} операций ДДС, ` +
      `5 торцовок + 4 присадки + 2 упаковки + ${hourLogs.length} часов.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
