import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const dbTouched = vi.fn();
  const deepDb = new Proxy(
    function deepDbCall() {
      dbTouched();
      return Promise.resolve(null);
    },
    {
      get: () => deepDb,
      apply: () => {
        dbTouched();
        return Promise.resolve(null);
      },
    },
  );
  return {
    dbTouched,
    prisma: deepDb,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/server/session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/server/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/server/change-log", () => ({ writeChangeLog: vi.fn() }));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: vi.fn() }));
vi.mock("@/server/internal/api-credentials", () => ({
  loadStoredApiCredentialsInternal: vi.fn(),
}));
vi.mock("@/server/internal/cost", () => ({
  archiveBatchIfDepleted: vi.fn(),
  buildCostReport: vi.fn(),
  getUnitCostSnapshot: vi.fn(),
  maybeFreezeBatch: vi.fn(),
}));
vi.mock("@/server/internal/finance-operations", () => ({
  applyAutoRulesInternal: vi.fn(),
  syncBatchTotalCostInternal: vi.fn(),
  syncDealInternal: vi.fn(),
}));
vi.mock("@/server/internal/notification-event", () => ({ notifyEvent: vi.fn() }));
vi.mock("@/server/internal/production-reversal", () => ({
  applyPrisadkaPick: vi.fn(),
  applyUpakovkaPick: vi.fn(),
  reversePrisadkaLine: vi.fn(),
  reverseUpakovkaOperation: vi.fn(),
}));
vi.mock("@/server/internal/statement-import", () => ({ importStatementInternal: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createCashFlow } from "@/server/finance";
import { markEmployeePaid } from "@/server/payroll";
import { createBatch } from "@/server/purchases";
import { deleteProductionOperation } from "@/server/production";
import { getApiCredentials } from "@/server/settings";
import { conductInventory } from "@/server/warehouse";

const unauthorized = new Error("Требуется сессия администратора");

describe("representative admin action boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockRejectedValue(unauthorized);
  });

  it.each([
    ["finance", () => createCashFlow({} as never)],
    ["payroll", () => markEmployeePaid("employee-1")],
    ["purchases", () => createBatch({} as never)],
    ["production", () => deleteProductionOperation("operation-1")],
    ["warehouse", () => conductInventory("inventory-1")],
    ["settings", () => getApiCredentials()],
  ])("rejects %s before any database access", async (_domain, invoke) => {
    await expect(invoke()).rejects.toThrow(unauthorized.message);
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.dbTouched).not.toHaveBeenCalled();
  });
});

