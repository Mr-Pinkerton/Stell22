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
  nomenclatureItemFindMany: vi.fn(),
  blankStockFindMany: vi.fn(),
  productionOperationCreate: vi.fn(),
  productionOperationFindUnique: vi.fn(async () => null),
  writeChangeLog: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/server/session", () => ({
  requireTerminalEmployee: mocks.requireTerminalEmployee,
}));
vi.mock("@/server/db", () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        employee: {
          findUnique: mocks.employeeFindUnique,
          findMany: mocks.employeeFindMany,
        },
        productionOperation: {
          create: mocks.productionOperationCreate,
          findUnique: mocks.productionOperationFindUnique,
          findMany: vi.fn(async () => []),
        },
        $queryRaw: vi.fn(async () => []),
      }),
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
    nomenclatureItem: { findMany: mocks.nomenclatureItemFindMany },
    blankStock: { findMany: mocks.blankStockFindMany },
    productionOperation: {
      create: mocks.productionOperationCreate,
      findUnique: mocks.productionOperationFindUnique,
      findMany: vi.fn(async () => []),
    },
  },
}));
vi.mock("@/server/change-log", () => ({ writeChangeLog: mocks.writeChangeLog }));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: vi.fn() }));
vi.mock("@/server/internal/cost", () => ({ archiveBatchIfDepleted: vi.fn() }));
vi.mock("@/server/internal/production-reversal", () => ({
  applyPrisadkaPick: vi.fn(),
  applyUpakovkaPick: vi.fn(),
  applyUpakovkaPrepared: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: mocks.cookieSet, delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));

import { headers } from "next/headers";
import { TERMINAL_COOKIE } from "@/lib/session";
import {
  getEmployeeEntries,
  getTerminalData,
  submitHours,
  submitPrisadka,
  submitTorcovka,
  submitUpakovka,
  terminalLoginByPin,
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
    mocks.nomenclatureItemFindMany.mockResolvedValue([]);
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
    mocks.nomenclatureItemFindMany.mockResolvedValue([]);
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
    mocks.employeeFindUnique.mockResolvedValue({
      id: "employee-1",
      fullName: "Иван Иванов",
      hourlyRate: 500,
      rateTorcovkaSort1: null,
      rateTorcovkaSort2: null,
      ratePrisadkaTorcev: null,
      ratePrisadkaPloskt: null,
      rateUpakovka: null,
    });
    mocks.productionOperationCreate.mockResolvedValue({ id: "operation-1" });

    await submitHours("employee-1", 8, "request-1");

    expect(mocks.requireTerminalEmployee).toHaveBeenCalledWith("employee-1");
    expect(mocks.productionOperationCreate).toHaveBeenCalledOnce();
    const created = mocks.productionOperationCreate.mock.calls[0]?.[0] as {
      data?: Record<string, unknown>;
    };
    expect(created?.data).toMatchObject({
      type: "HOURS",
      hours: 8,
      hourlyRateSnapshot: 500,
      rateSnapshotVersion: 1,
    });
    expect(created?.data).not.toHaveProperty("rateSnapshot");
    expect(mocks.writeChangeLog).toHaveBeenCalledOnce();
  });
});

function hoursEmployee(hourlyRate: number | null) {
  return {
    id: "employee-1",
    fullName: "Иван Иванов",
    hourlyRate,
    rateTorcovkaSort1: null,
    rateTorcovkaSort2: null,
    ratePrisadkaTorcev: null,
    ratePrisadkaPloskt: null,
    rateUpakovka: null,
  };
}

describe("submitHours owner invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireTerminalEmployee.mockResolvedValue({
      id: "employee-1",
      fullName: "Иван Иванов",
    });
    mocks.productionOperationFindUnique.mockResolvedValue(null);
  });

  it("creates 1h and 0.5h when hourly rate is set", async () => {
    mocks.employeeFindUnique.mockResolvedValue(hoursEmployee(500));
    mocks.productionOperationCreate.mockResolvedValue({ id: "operation-1" });

    await submitHours("employee-1", 1, "hours-1");
    await submitHours("employee-1", 0.5, "hours-0.5");
    await submitHours("employee-1", 7.5, "hours-7.5");

    expect(mocks.productionOperationCreate).toHaveBeenCalledTimes(3);
    const hours = mocks.productionOperationCreate.mock.calls.map((call) => {
      const arg = call[0] as { data?: { hours?: number; hourlyRateSnapshot?: unknown } };
      return arg.data?.hours;
    });
    expect(hours).toEqual([1, 0.5, 7.5]);
    expect(
      (mocks.productionOperationCreate.mock.calls[0]?.[0] as { data?: { hourlyRateSnapshot?: unknown } })
        .data?.hourlyRateSnapshot,
    ).toBe(500);
  });

  it("rejects 1.25h without creating an operation", async () => {
    mocks.employeeFindUnique.mockResolvedValue(hoursEmployee(500));

    await expect(submitHours("employee-1", 1.25, "hours-1.25")).rejects.toThrow(
      "Часы — кратно 0,5",
    );
    expect(mocks.productionOperationCreate).not.toHaveBeenCalled();
  });

  it("rejects missing hourly rate before create", async () => {
    mocks.employeeFindUnique.mockResolvedValue(hoursEmployee(null));

    await expect(submitHours("employee-1", 1, "hours-no-rate-1")).rejects.toThrow(
      "Почасовая ставка не задана",
    );
    await expect(submitHours("employee-1", 0.5, "hours-no-rate-0.5")).rejects.toThrow(
      "Почасовая ставка не задана",
    );
    expect(mocks.productionOperationCreate).not.toHaveBeenCalled();
  });

  it("rejects zero hourly rate before create", async () => {
    mocks.employeeFindUnique.mockResolvedValue(hoursEmployee(0));

    await expect(submitHours("employee-1", 1, "hours-zero-rate-1")).rejects.toThrow(
      "Почасовая ставка не задана",
    );
    expect(mocks.productionOperationCreate).not.toHaveBeenCalled();
  });
});


describe("terminalLoginByPin expected failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(new Headers());
    process.env.SESSION_SECRET ??= "stell22-unit-test-session-secret";
  });

  it("returns Неверный PIN instead of throwing when nobody matches", async () => {
    mocks.employeeFindMany.mockResolvedValue([]);

    await expect(terminalLoginByPin("9999")).resolves.toEqual({
      ok: false,
      error: "Неверный PIN",
    });
    expect(mocks.employeeFindUnique).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("returns a lockout message instead of throwing after 10 failures", async () => {
    // Отдельный IP: pinLimiter — модульный синглтон, не делим ключ с соседними тестами.
    vi.mocked(headers).mockResolvedValue(new Headers({ "x-forwarded-for": "203.0.113.10" }));
    mocks.employeeFindMany.mockResolvedValue([]);

    for (let i = 0; i < 10; i++) {
      await expect(terminalLoginByPin("8888")).resolves.toEqual({
        ok: false,
        error: "Неверный PIN",
      });
    }

    mocks.employeeFindMany.mockClear();
    await expect(terminalLoginByPin("8888")).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/^Слишком много попыток\. Повторите через \d+ с\.$/),
    });
    expect(mocks.employeeFindMany).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("throws when employee lookup fails instead of returning invalid PIN", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ "x-forwarded-for": "203.0.113.20" }));
    mocks.employeeFindMany.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(terminalLoginByPin("1234")).rejects.toThrow("ECONNREFUSED");
    await expect(terminalLoginByPin("1234")).rejects.not.toMatchObject({
      ok: false,
      error: "Неверный PIN",
    });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("sets the terminal cookie only after a successful PIN", async () => {
    vi.mocked(headers).mockResolvedValue(new Headers({ "x-forwarded-for": "203.0.113.30" }));
    mocks.employeeFindMany.mockResolvedValue([
      { id: "emp-1", pin: "1234", status: "ACTIVE" },
    ]);
    mocks.employeeFindUnique.mockResolvedValue({
      id: "emp-1",
      fullName: "Иван Иванов",
    });

    await expect(terminalLoginByPin("1234")).resolves.toEqual({
      ok: true,
      employee: { id: "emp-1", fullName: "Иван Иванов" },
    });
    expect(mocks.cookieSet).toHaveBeenCalledOnce();
    expect(mocks.cookieSet.mock.calls[0]?.[0]).toBe(TERMINAL_COOKIE);
    expect(String(mocks.cookieSet.mock.calls[0]?.[1] ?? "")).not.toMatch(/1234/);
  });
});

