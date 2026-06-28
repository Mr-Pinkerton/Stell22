import { formatGoalMonthIso } from "@/lib/goals";
import { createLocalDate } from "@/lib/dates";
import { products } from "./fixtures";
import type { GoalStatus } from "@/types/domain";

export interface GoalRow {
  id: string;
  name: string;
  productId: string;
  productName: string;
  quantity: number;
  /** Первый день календарного месяца цели (YYYY-MM-DD). */
  month: string;
  status: GoalStatus;
  /** Факт производства (упаковка) за месяц — мок. */
  producedQty: number;
}

const currentMonth = formatGoalMonthIso(createLocalDate(2026, 5, 1));
const prevMonth = formatGoalMonthIso(createLocalDate(2026, 4, 1));

export const goalRows: GoalRow[] = [
  {
    id: "goal-1",
    name: "Июнь — полки настенные",
    productId: "prod-1",
    productName: products[0]!.name,
    quantity: 300,
    month: currentMonth,
    status: "ACTIVE",
    producedQty: 142,
  },
  {
    id: "goal-2",
    name: "Июнь — угловые",
    productId: "prod-2",
    productName: products[1]!.name,
    quantity: 180,
    month: currentMonth,
    status: "ACTIVE",
    producedQty: 96,
  },
  {
    id: "goal-3",
    name: "Май — полки",
    productId: "prod-1",
    productName: products[0]!.name,
    quantity: 280,
    month: prevMonth,
    status: "ARCHIVED",
    producedQty: 265,
  },
  {
    id: "goal-4",
    name: "Май — угловые",
    productId: "prod-2",
    productName: products[1]!.name,
    quantity: 150,
    month: prevMonth,
    status: "ARCHIVED",
    producedQty: 158,
  },
];

export function createGoalRow(input: {
  name: string;
  productId: string;
  quantity: number;
  month?: Date;
}): GoalRow {
  const product = products.find((p) => p.id === input.productId);
  const monthDate = input.month ?? createLocalDate(new Date().getFullYear(), new Date().getMonth(), 1);
  return {
    id: `goal-${Date.now()}`,
    name: input.name.trim(),
    productId: input.productId,
    productName: product?.name ?? "—",
    quantity: input.quantity,
    month: formatGoalMonthIso(monthDate),
    status: "ACTIVE",
    producedQty: 0,
  };
}
