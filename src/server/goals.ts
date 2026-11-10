"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { requireAdmin } from "@/server/session";
import { businessMonthIso, startOfBusinessMonth } from "@/lib/dates";
import { formatProductSku } from "@/lib/format";
import type { GoalRow } from "@/mocks/goals-fixtures";

export interface GoalProductOption {
  id: string;
  name: string;
  sku: string;
}

export interface GoalsData {
  goals: GoalRow[];
  products: GoalProductOption[];
}

/**
 * Цели с фактом производства. Факт — суммарное количество упакованных изделий
 * (операции УПАКОВКИ) этого изделия за хозяйственный месяц цели (UTC+3).
 * Goal.month — выбранный календарный месяц (полночь его начала), не новое
 * событие: businessMonthIso читает этот месяц, не переписывая строку.
 */
export async function getGoalsData(): Promise<GoalsData> {
  await requireAdmin();
  const [goals, products, upakovka] = await Promise.all([
    prisma.goal.findMany({ include: { product: true }, orderBy: { month: "desc" } }),
    prisma.product.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }),
    prisma.productionOperation.findMany({
      where: { type: "UPAKOVKA", cancelledAt: null },
      select: { productId: true, productQty: true, workDate: true },
    }),
  ]);

  // Факт упаковки по ключу productId|YYYY-MM.
  const producedByKey = new Map<string, number>();
  for (const op of upakovka) {
    if (!op.productId) continue;
    const key = `${op.productId}|${businessMonthIso(op.workDate)}`;
    producedByKey.set(key, (producedByKey.get(key) ?? 0) + (op.productQty ?? 0));
  }

  const rows: GoalRow[] = goals.map((g) => {
    const monthIso = businessMonthIso(g.month);
    return {
      id: g.id,
      name: g.name,
      productId: g.productId,
      productName: g.product.name,
      quantity: g.quantity,
      month: monthIso,
      status: g.status,
      producedQty: producedByKey.get(`${g.productId}|${monthIso}`) ?? 0,
    };
  });

  return {
    goals: rows,
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: formatProductSku(p.skuOzon, p.skuWb),
    })),
  };
}

export interface CreateGoalInput {
  name: string;
  productId: string;
  quantity: number;
}

/** Создать цель на текущий календарный месяц. */
export async function createGoal(input: CreateGoalInput): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireAdmin();
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Укажите название цели" };
  if (!input.productId) return { ok: false, error: "Выберите изделие" };
  if (!(input.quantity > 0)) return { ok: false, error: "Количество должно быть больше нуля" };

  const goal = await prisma.goal.create({
    data: {
      name,
      productId: input.productId,
      quantity: Math.round(input.quantity),
      month: startOfBusinessMonth(),
      status: "ACTIVE",
    },
  });
  await writeChangeLog({
    entity: "Goal",
    entityId: goal.id,
    newValues: { name, productId: input.productId, quantity: input.quantity },
  });

  revalidatePath("/goals");
  revalidatePath("/dashboard");
  return { ok: true };
}
