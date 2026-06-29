"use server";

import { revalidatePath } from "next/cache";
import type {
  Batch as PrismaBatch,
  Detail as PrismaDetail,
  Employee as PrismaEmployee,
  NomenclatureItem as PrismaItem,
  Prisma,
  RailLot as PrismaRailLot,
} from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { buildStockSnapshot, type DetailStockRow } from "@/lib/detail-stock";
import type {
  Batch,
  Detail,
  Employee,
  NomenclatureItem,
  Product,
  RailLot,
  TerminalEntry,
} from "@/types/domain";
import type { TerminalData } from "@/components/terminal/types";

function num(value: Prisma.Decimal | number | null): number | null {
  if (value == null) return null;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ============================ СЕРИАЛИЗАЦИЯ =================================

function serEmployee(e: PrismaEmployee): Employee {
  return {
    id: e.id,
    fullName: e.fullName,
    birthDate: e.birthDate ? e.birthDate.toISOString().slice(0, 10) : null,
    pin: e.pin,
    status: e.status,
    hourlyRate: num(e.hourlyRate),
    rateTorcovkaSort1: num(e.rateTorcovkaSort1),
    rateTorcovkaSort2: num(e.rateTorcovkaSort2),
    ratePrisadkaTorcev: num(e.ratePrisadkaTorcev),
    ratePrisadkaPloskt: num(e.ratePrisadkaPloskt),
    rateUpakovka: num(e.rateUpakovka),
  };
}

function serBatch(b: PrismaBatch): Batch {
  return {
    id: b.id,
    name: b.name,
    sectionWidthMm: num(b.sectionWidthMm) ?? 0,
    sectionHeightMm: num(b.sectionHeightMm) ?? 0,
    purchaseCost: num(b.purchaseCost) ?? 0,
    totalCost: num(b.totalCost) ?? 0,
    priceSort1: num(b.priceSort1) ?? 0,
    priceSort2: num(b.priceSort2) ?? 0,
    status: b.status,
    purchaseDate: b.purchaseDate.toISOString().slice(0, 10),
    note: b.note,
  };
}

function serLot(l: PrismaRailLot): RailLot {
  return {
    id: l.id,
    batchId: l.batchId,
    lengthM: num(l.lengthM) ?? 0,
    railType: l.railType,
    sort: l.sort,
    isPackage: l.isPackage,
    code: l.code,
    rows: l.rows,
    layers: l.layers,
    quantity: l.quantity,
    remainingQuantity: l.remainingQuantity,
  };
}

function serDetail(d: PrismaDetail): Detail {
  return {
    id: d.id,
    name: d.name,
    lengthM: num(d.lengthM) ?? 0,
    detailType: d.detailType,
    sort: d.sort,
    prisadkaTorcevaya: d.prisadkaTorcevaya,
    prisadkaPloskost: d.prisadkaPloskost,
    status: d.status,
  };
}

function serItem(n: PrismaItem): NomenclatureItem {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    unitPrice: num(n.unitPrice) ?? 0,
    status: n.status,
    minStock: n.minStock,
  };
}

type ProductWithRel = Prisma.ProductGetPayload<{
  include: { details: true; fasteners: true; extras: true };
}>;

function serProduct(p: ProductWithRel): Product {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    sort: p.sort,
    salePrice: num(p.salePrice) ?? 0,
    packagingId: p.packagingId,
    status: p.status,
    details: p.details.map((d) => ({ detailId: d.detailId, quantity: d.quantity })),
    fastenerIds: p.fasteners.map((f) => ({ nomenclatureId: f.nomenclatureId, quantity: f.quantity })),
    extraIds: p.extras.map((e) => e.nomenclatureId),
  };
}

// ============================ ЧТЕНИЕ =======================================

export async function getTerminalData(): Promise<TerminalData> {
  const [employees, batches, lots, details, products, items, stockRows, purchases] =
    await Promise.all([
      prisma.employee.findMany({ where: { status: "ACTIVE" }, orderBy: { fullName: "asc" } }),
      prisma.batch.findMany({ orderBy: { purchaseDate: "desc" } }),
      prisma.railLot.findMany(),
      prisma.detail.findMany(),
      prisma.product.findMany({ include: { details: true, fasteners: true, extras: true } }),
      prisma.nomenclatureItem.findMany(),
      prisma.detailStock.findMany(),
      prisma.simplePurchase.findMany(),
    ]);

  const domainDetails = details.map(serDetail);

  // Склад крепежа/упаковки/разного — приход по простым закупкам (расход пока не
  // отслеживается; уточнится при оживлении упаковки).
  const nomenclatureStock: Record<string, number> = {};
  for (const p of purchases) {
    nomenclatureStock[p.nomenclatureId] = (nomenclatureStock[p.nomenclatureId] ?? 0) + p.quantity;
  }

  const rows: DetailStockRow[] = stockRows.map((r) => ({
    detailId: r.detailId,
    torcevayaDone: r.torcevayaDone,
    ploskostDone: r.ploskostDone,
    quantity: r.quantity,
  }));

  return {
    employees: employees.map(serEmployee),
    batches: batches.map(serBatch),
    railLots: lots.map(serLot),
    details: domainDetails,
    products: products.map(serProduct),
    nomenclature: items.map(serItem),
    stock: buildStockSnapshot(domainDetails, rows, nomenclatureStock),
  };
}

// ============================ ТОРЦОВКА =====================================

export interface TorcovkaInput {
  employeeId: string;
  batchId: string;
  railLotId: string;
  railsTaken: number;
  picks: { detailId: string; quantity: number }[];
}

export async function submitTorcovka(input: TorcovkaInput): Promise<void> {
  const { employeeId, batchId, railLotId, railsTaken } = input;
  const picks = input.picks.filter((p) => p.quantity > 0);
  if (!employeeId) throw new Error("Не выбран работник");
  if (railsTaken <= 0) throw new Error("Укажите количество взятых реек");
  if (picks.length === 0) throw new Error("Не выбраны детали");

  await prisma.$transaction(async (tx) => {
    // Атомарное списание: уйти в минус нельзя (cost-integrity).
    const dec = await tx.railLot.updateMany({
      where: { id: railLotId, batchId, remainingQuantity: { gte: railsTaken } },
      data: { remainingQuantity: { decrement: railsTaken } },
    });
    if (dec.count === 0) throw new Error("Недостаточно реек в пакете");

    const op = await tx.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId,
        batchId,
        railLotId,
        railsTaken,
        workDate: new Date(),
        lines: { create: picks.map((p) => ({ detailId: p.detailId, quantity: p.quantity })) },
      },
    });

    // Произведённые детали приходуются на сырую стадию (присадки не сделаны).
    for (const p of picks) {
      await tx.detailStock.upsert({
        where: {
          detailId_torcevayaDone_ploskostDone: {
            detailId: p.detailId,
            torcevayaDone: false,
            ploskostDone: false,
          },
        },
        create: {
          detailId: p.detailId,
          torcevayaDone: false,
          ploskostDone: false,
          quantity: p.quantity,
        },
        update: { quantity: { increment: p.quantity } },
      });
    }

    await writeChangeLog(
      {
        entity: "ProductionOperation",
        entityId: op.id,
        newValues: { type: "TORCOVKA", batchId, railLotId, railsTaken, picks },
      },
      tx,
    );
  });

  revalidatePath("/production");
  revalidatePath("/terminal");
}

// ============================ РАБОЧИЕ ЧАСЫ =================================

export async function submitHours(employeeId: string, hours: number): Promise<void> {
  if (!employeeId) throw new Error("Не выбран работник");
  if (!(hours > 0)) throw new Error("Укажите количество часов");

  const op = await prisma.productionOperation.create({
    data: { type: "HOURS", employeeId, hours, workDate: new Date() },
  });
  await writeChangeLog({
    entity: "ProductionOperation",
    entityId: op.id,
    newValues: { type: "HOURS", hours },
  });

  revalidatePath("/production");
  revalidatePath("/terminal");
}

// ============================ ЖУРНАЛ РАБОТНИКА =============================

type OpWithLines = Prisma.ProductionOperationGetPayload<{ include: { lines: true } }>;

function entryFromOperation(
  op: OpWithLines,
  emp: PrismaEmployee,
  detailSort: Map<string, "SORT1" | "SORT2">,
): TerminalEntry {
  let quantity = 0;
  let amount = 0;

  if (op.type === "HOURS") {
    quantity = num(op.hours) ?? 0;
    amount = quantity * (num(emp.hourlyRate) ?? 0);
  } else if (op.type === "UPAKOVKA") {
    quantity = op.productQty ?? 0;
    amount = quantity * (num(emp.rateUpakovka) ?? 0);
  } else if (op.type === "TORCOVKA") {
    const r1 = num(emp.rateTorcovkaSort1) ?? 0;
    const r2 = num(emp.rateTorcovkaSort2) ?? 0;
    for (const l of op.lines) {
      quantity += l.quantity;
      amount += l.quantity * (detailSort.get(l.detailId) === "SORT2" ? r2 : r1);
    }
  } else {
    // PRISADKA
    const rt = num(emp.ratePrisadkaTorcev) ?? 0;
    const rp = num(emp.ratePrisadkaPloskt) ?? 0;
    for (const l of op.lines) {
      quantity += l.quantity;
      amount += l.quantity * ((l.prisadkaTorcevaya ? rt : 0) + (l.prisadkaPloskost ? rp : 0));
    }
  }

  return {
    id: op.id,
    employeeId: op.employeeId,
    type: op.type,
    occurredAt: op.createdAt.toISOString(),
    quantity,
    amount: round2(amount),
  };
}

export async function getEmployeeEntries(employeeId: string): Promise<TerminalEntry[]> {
  const [emp, ops, details] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId } }),
    prisma.productionOperation.findMany({
      where: { employeeId },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.detail.findMany({ select: { id: true, sort: true } }),
  ]);
  if (!emp) return [];

  const detailSort = new Map(details.map((d) => [d.id, d.sort]));
  return ops.map((op) => entryFromOperation(op, emp, detailSort));
}
