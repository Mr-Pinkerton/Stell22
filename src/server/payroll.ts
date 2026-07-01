"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { maybeFreezeBatch } from "@/server/cost";
import { operationEarning } from "@/lib/payroll";
import { dayKey } from "@/lib/entries";
import type { SalaryDayLine, SalaryReportRow } from "@/mocks/report-fixtures";

const PATH = "/reports";

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

type OpFull = Prisma.ProductionOperationGetPayload<{ include: { lines: true } }>;

interface ComputedOp {
  op: OpFull;
  amount: number;
  quantity: number;
}

/** Карты расценок работников и сортов деталей для расчёта сумм операций. */
async function buildRefMaps() {
  const [employees, details] = await Promise.all([
    prisma.employee.findMany(),
    prisma.detail.findMany({ select: { id: true, sort: true } }),
  ]);
  return {
    employeeName: new Map(employees.map((e) => [e.id, e.fullName])),
    empRates: new Map(
      employees.map((e) => [
        e.id,
        {
          hourly: num(e.hourlyRate),
          torcovkaSort1: num(e.rateTorcovkaSort1),
          torcovkaSort2: num(e.rateTorcovkaSort2),
          prisadkaTorcev: num(e.ratePrisadkaTorcev),
          prisadkaPlosk: num(e.ratePrisadkaPloskt),
          upakovka: num(e.rateUpakovka),
        },
      ]),
    ),
    detailSort: new Map(details.map((d) => [d.id, d.sort])),
  };
}

type RefMaps = Awaited<ReturnType<typeof buildRefMaps>>;

function computeOp(op: OpFull, maps: RefMaps): ComputedOp {
  const rates = maps.empRates.get(op.employeeId);
  if (!rates) return { op, amount: 0, quantity: 0 };
  const { quantity, amount } = operationEarning({
    type: op.type,
    rates,
    hours: num(op.hours),
    productQty: op.productQty ?? 0,
    lines: op.lines.map((l) => ({
      quantity: l.quantity,
      sort: maps.detailSort.get(l.detailId),
      prisadkaTorcevaya: l.prisadkaTorcevaya,
      prisadkaPloskost: l.prisadkaPloskost,
    })),
  });
  return { op, amount, quantity };
}

/** Агрегирует набор операций в строку отчёта (дневная разбивка по типам). */
function aggregate(items: ComputedOp[]): { produced: number; total: number; days: SalaryDayLine[] } {
  const byDay = new Map<string, SalaryDayLine>();
  let total = 0;
  let produced = 0;

  for (const { op, amount, quantity } of items) {
    total += amount;
    if (op.type !== "HOURS") produced += quantity;

    const day = dayKey(op.workDate);
    const line =
      byDay.get(day) ??
      ({ date: day, hours: null, torcovka: 0, prisadka: 0, upakovka: 0, total: 0 } as SalaryDayLine);

    if (op.type === "HOURS") line.hours = (line.hours ?? 0) + quantity;
    if (op.type === "TORCOVKA") line.torcovka += amount;
    if (op.type === "PRISADKA") line.prisadka += amount;
    if (op.type === "UPAKOVKA") line.upakovka += amount;
    line.total += amount;
    byDay.set(day, line);
  }

  const days = [...byDay.values()]
    .map((d) => ({ ...d, total: round2(d.total) }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 31);

  return { produced, total: round2(total), days };
}

/**
 * Отчёт ЗП: невыплаченные строки по работникам (агрегат неоплаченных
 * операций) + выплаченные строки по факту выплаты (`Payment`). Невыплаченные
 * сверху по сумме ↓, выплаченные ниже по дате выплаты ↓.
 */
export async function getSalaryReport(): Promise<SalaryReportRow[]> {
  const maps = await buildRefMaps();
  const ops = await prisma.productionOperation.findMany({ include: { lines: true } });
  const computed = new Map(ops.map((op) => [op.id, computeOp(op, maps)]));

  // Невыплаченные — по работнику.
  const unpaidByEmp = new Map<string, ComputedOp[]>();
  for (const c of computed.values()) {
    if (c.op.isPaid) continue;
    const list = unpaidByEmp.get(c.op.employeeId) ?? [];
    list.push(c);
    unpaidByEmp.set(c.op.employeeId, list);
  }

  const unpaidRows: SalaryReportRow[] = [];
  for (const [employeeId, items] of unpaidByEmp) {
    const { produced, total, days } = aggregate(items);
    unpaidRows.push({
      id: `unpaid:${employeeId}`,
      employeeName: maps.employeeName.get(employeeId) ?? "—",
      amountDue: total,
      produced,
      avgPerUnit: produced > 0 ? round2(total / produced) : 0,
      total,
      paid: false,
      paidAt: null,
      days,
    });
  }
  unpaidRows.sort((a, b) => b.total - a.total);

  // Выплаченные — по фактам выплат.
  const payments = await prisma.payment.findMany({
    include: { items: true },
    orderBy: { paidAt: "desc" },
  });
  const paidRows: SalaryReportRow[] = payments.map((p) => {
    const items = p.items
      .map((i) => computed.get(i.operationId))
      .filter((c): c is ComputedOp => Boolean(c));
    const { produced, days } = aggregate(items);
    const total = num(p.amount);
    return {
      id: p.id,
      employeeName: maps.employeeName.get(p.employeeId) ?? "—",
      amountDue: total,
      produced,
      avgPerUnit: produced > 0 ? round2(total / produced) : 0,
      total,
      paid: true,
      paidAt: dayKey(p.paidAt),
      days,
    };
  });

  return [...unpaidRows, ...paidRows];
}

/**
 * Зафиксировать выплату работнику: все его невыплаченные операции переводятся
 * в `Payment` + `PaymentBatchItem`, помечаются isPaid/paidAt. После выплаты
 * операции нельзя редактировать/удалять (инвариант из v2). Возвращает
 * обновлённый отчёт.
 */
export async function markEmployeePaid(employeeId: string): Promise<SalaryReportRow[]> {
  const maps = await buildRefMaps();
  const ops = await prisma.productionOperation.findMany({
    where: { employeeId, isPaid: false },
    include: { lines: true },
  });
  if (ops.length === 0) throw new Error("Нет невыплаченных операций");

  const amount = round2(ops.reduce((s, op) => s + computeOp(op, maps).amount, 0));
  const paidAt = new Date();
  const opIds = ops.map((o) => o.id);
  // Партии выплачиваемых операций торцовки — кандидаты на заморозку.
  const torcovkaBatchIds = [
    ...new Set(
      ops
        .filter((o) => o.type === "TORCOVKA" && o.batchId)
        .map((o) => o.batchId as string),
    ),
  ];

  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: { employeeId, amount: amount.toFixed(2), paidAt },
    });
    await tx.paymentBatchItem.createMany({
      data: opIds.map((operationId) => ({ paymentId: payment.id, operationId })),
    });
    await tx.productionOperation.updateMany({
      where: { id: { in: opIds } },
      data: { isPaid: true, paidAt },
    });
    await writeChangeLog(
      {
        entity: "Payment",
        entityId: payment.id,
        newValues: { employeeId, amount, operations: opIds.length },
      },
      tx,
    );

    // Выработанная партия, у которой все операции торцовки выплачены, —
    // замораживаем себестоимость (FINAL).
    for (const batchId of torcovkaBatchIds) {
      await maybeFreezeBatch(tx, batchId);
    }
  });

  revalidatePath(PATH);
  revalidatePath("/production");
  return getSalaryReport();
}
