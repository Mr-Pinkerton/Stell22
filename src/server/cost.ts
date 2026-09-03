"use server";

import type { CostDetailRow, CostProductRow } from "@/lib/cost-report";
import { getMonthPeriod, type Period } from "@/lib/dates";
import { buildCostReport } from "@/server/internal/cost";
import { requireAdmin } from "@/server/session";

export interface CostReport {
  details: CostDetailRow[];
  products: CostProductRow[];
}

export interface UnitCostSnapshot {
  productFull: Map<string, number>;
  detailUnit: Map<string, number>;
  nomenclatureUnit: Map<string, number>;
}

export async function getCostReport(
  period: Period | null = getMonthPeriod(),
): Promise<CostReport> {
  await requireAdmin();
  return buildCostReport(period);
}
