import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";

export const PRODUCTION_COST_FLOW_KEY = "production_cost_flow";

export const COST_FLOW_MALFORMED_SETTING =
  "Некорректная настройка production_cost_flow. Денежный учёт заблокирован.";

export class CostFlowConfigError extends Error {
  constructor(message = COST_FLOW_MALFORMED_SETTING) {
    super(message);
    this.name = "CostFlowConfigError";
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Technical activation gate. Absent → inactive. Malformed / unsupported version
 * fail closed (never silently treated as active or inactive).
 * Package 2 does not create active=true for business data.
 */
export function parseProductionCostFlowValue(value: unknown): { active: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CostFlowConfigError();
  }
  const rec = value as Record<string, unknown>;
  if (rec.version !== 1) throw new CostFlowConfigError();
  if (typeof rec.active !== "boolean") throw new CostFlowConfigError();
  return { active: rec.active };
}

export async function isCostFlowActive(db: Db = prisma): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: PRODUCTION_COST_FLOW_KEY } });
  if (!row) return false;
  return parseProductionCostFlowValue(row.value).active;
}
