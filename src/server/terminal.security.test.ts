import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireTerminalEmployee: vi.fn(),
  employeeFindUnique: vi.fn(),
  employeeFindMany: vi.fn(),
  materialFindMany: vi.fn(),
  batchFindMany: vi.fn(),
  railLotFindMany: vi.fn(),
  detailFindMany: vi.fn(),
  productFindMany: vi.fn(),
  detailStockFindMany: vi.fn(),
  nomenclatureStockFindMany: vi.fn(),
  blankStockFindMany: vi.fn(),
  productionOperationCreate: vi.fn(),
  writeChangeLog: vi.fn(),
}));

vi.mock("@/server/session", () => ({
  requireTerminalEmployee: mocks.requireTerminalEmployee,
}));
vi.mock("@/server/db", () => ({
  prisma: {
    employee: {
      findUnique: mocks.employeeFindUnique,
      findMany: mocks.employeeFindMany,
    },
    material: { findMany: mocks.materialFindMany },
    batch: { findMany: mocks.batchFindMany },
    railLot: { findMany: mocks.railLotFindMany },
    detail: { findMany: mocks.detailFindMany },
    product: { findMany: mocks.productFindMany },
    detailStock: { findMany: mocks.detailStockFindMany },
    nomenclatureStock: { findMany: mocks.nomenclatureStockFindMany },
    blankStock: { findMany: mocks.blankStockFindMany },
    productionOperation: { create: mocks.productionOperationCreate },
  },
}));
vi.mock("@/server/change-log", () => ({ writeChangeLog: mocks.writeChangeLog }));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: vi.fn() }));
vi.mock("@/server/internal/cost", () => ({ archiveBatchIfDepleted: vi.fn() }));
vi.mock("@/server/internal/production-reversal", () => ({
  applyPrisadkaPick: vi.fn(),
  applyUpakovkaPick: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));

import {
  getEmployeeEntries,
  getTerminalData,
  submitHours,
  submitPrisadka,
  submitTorcovka,
  submitUpakovka,
} from "@/server/terminal";

const noSession = new Error("Нет активной сессии терминала. Войдите по PIN.");

describe("terminal action boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireTerminalEmployee.mockRejectedValue(noSession);
  });

  it.each([
    ["getTerminalData", () => getTerminalData()],
    ["submitTorcovka", () => submitTorcovka({} as never)],
    ["submitPrisadka", () => submitPrisadka({} as never)],
    ["submitUpakovka", () => submitUpakovka({} as never)],
    ["submitHours", () => submitHours("employee-1", 8, "request-1")],
    ["getEmployeeEntries", () => getEmployeeEntries("employee-1")],
  ])("rejects %s without a terminal session", async (_name, invoke) => {
    await expect(invoke()).rejects.toThrow(noSession.message);
    expect(mocks.employeeFindUnique).not.toHaveBeenCalled();
    expect(mocks.productionOperationCreate).not.toHaveBeenCalled();
  });

  it("returns only the post-auth terminal DTO", async () => {
    const now = new Date();
    mocks.requireTerminalEmployee.mockResolvedValue({
      id: "employee-1",
      fullName: "Иван Иванов",
    });
    mocks.employeeFindUnique.mockResolvedValue({
      id: "employee-1",
      fullName: "Иван Иванов",
      hourlyRate: { toNumber: () => 500 },
    });
    mocks.employeeFindMany.mockResolvedValue([
      { id: "employee-2", fullName: "Пётр Петров", birthDate: now },
    ]);
    mocks.materialFindMany.mockResolvedValue([]);
    mocks.batchFindMany.mockResolvedValue([
      {
        id: "batch-1",
        name: "Партия 1",
        materialId: "material-1",
        sectionWidthMm: { toNumber: () => 50 },
        sectionHeightMm: { toNumber: () => 30 },
        purchaseCost: { toNumber: () => 100_000 },
        totalCost: { toNumber: () => 110_000 },
        priceSort1: { toNumber: () => 1 },
        priceSort2: { toNumber: () => 2 },
        status: "IN_WORK",
        purchaseDate: now,
        note: null,
      },
    ]);
    mocks.railLotFindMany.mockResolvedValue([]);
    mocks.detailFindMany.mockResolvedValue([]);
    mocks.productFindMany.mockResolvedValue([]);
    mocks.detailStockFindMany.mockResolvedValue([]);
    mocks.nomenclatureStockFindMany.mockResolvedValue([]);
    mocks.blankStockFindMany.mockResolvedValue([]);

    const data = await getTerminalData();

    expect(mocks.requireTerminalEmployee).toHaveBeenCalledWith();
    expect(data.currentEmployee).toEqual({
      id: "employee-1",
      fullName: "Иван Иванов",
      hourlyRate: 500,
    });
    expect(data.birthdaysToday).toEqual([
      { id: "employee-2", fullName: "Пётр Петров" },
    ]);
    expect(data.batches[0]).toEqual({
      id: "batch-1",
      name: "Партия 1",
      materialId: "material-1",
      sectionWidthMm: 50,
      sectionHeightMm: 30,
      status: "IN_WORK",
    });
    expect(data).not.toHaveProperty("employees");
    expect(data).not.toHaveProperty("nomenclature");
    expect(data.stock).not.toHaveProperty("blanks");
  });

  it("derives prisadkaPending and detailsReady from BlankStock without exposing blanks", async () => {
    mocks.requireTerminalEmployee.mockResolvedValue({
      id: "employee-1",
      fullName: "Иван Иванов",
    });
    mocks.employeeFindUnique.mockResolvedValue({
      id: "employee-1",
      fullName: "Иван Иванов",
      hourlyRate: { toNumber: () => 500 },
    });
    mocks.employeeFindMany.mockResolvedValue([]);
    mocks.materialFindMany.mockResolvedValue([]);
    mocks.batchFindMany.mockResolvedValue([]);
    mocks.railLotFindMany.mockResolvedValue([]);
    mocks.detailFindMany.mockResolvedValue([
      {
        id: "detail-a",
        name: "Detail A",
        materialId: "mat-1",
        detailNumber: 1,
        lengthM: { toNumber: () => 0.6 },
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
        status: "ACTIVE",
      },
      {
        id: "detail-b",
        name: "Detail B",
        materialId: "mat-1",
        detailNumber: 2,
        lengthM: { toNumber: () => 0.8 },
        detailType: "KANAVKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
        status: "ACTIVE",
      },
    ]);
    mocks.productFindMany.mockResolvedValue([]);
    mocks.detailStockFindMany.mockResolvedValue([]);
    mocks.nomenclatureStockFindMany.mockResolvedValue([]);
    mocks.blankStockFindMany.mockResolvedValue([
      {
        materialId: "mat-1",
        lengthM: { toNumber: () => 0.6 },
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 40,
      },
      {
        materialId: "mat-1",
        lengthM: { toNumber: () => 0.8 },
        detailType: "KANAVKA",
        sort: "SORT1",
        quantity: 40,
      },
    ]);

    const data = await getTerminalData();

    expect(mocks.blankStockFindMany).toHaveBeenCalledOnce();
    expect(data.stock.prisadkaPending["detail-a"]).toEqual({ torcev: 40, plosk: 0 });
    expect(data.stock.detailsReady["detail-b"]).toBe(40);
    expect(data.stock).not.toHaveProperty("blanks");
  });

  it("keeps a valid terminal session working for hours submission", async () => {
    mocks.requireTerminalEmployee.mockResolvedValue({
      id: "employee-1",
      fullName: "Иван Иванов",
    });
    mocks.productionOperationCreate.mockResolvedValue({ id: "operation-1" });

    await submitHours("employee-1", 8, "request-1");

    expect(mocks.requireTerminalEmployee).toHaveBeenCalledWith("employee-1");
    expect(mocks.productionOperationCreate).toHaveBeenCalledOnce();
    expect(mocks.writeChangeLog).toHaveBeenCalledOnce();
  });
});

