import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmployeeFormValues } from "@/server/employees";
import type { MaterialFormValues } from "@/server/materials";

const ADMIN_ID = "admin-user-1";

type Row = Record<string, unknown> & { id: string };

const state = vi.hoisted(() => ({
  logFails: false,
  employeeCreateFails: false,
  employees: [] as Row[],
  materials: [] as Row[],
  accounts: [] as Row[],
  payments: [] as Row[],
  logs: [] as Array<Record<string, unknown> & { inTransaction: boolean }>,
  ops: [] as Row[],
  order: [] as string[],
  nextId: 0,
}));

function clone<T>(value: T): T {
  return structuredClone(value);
}

function snapshot() {
  return {
    employees: clone(state.employees),
    materials: clone(state.materials),
    accounts: clone(state.accounts),
    payments: clone(state.payments),
    logs: clone(state.logs),
    ops: clone(state.ops),
  };
}

function restore(saved: ReturnType<typeof snapshot>) {
  state.employees = saved.employees;
  state.materials = saved.materials;
  state.accounts = saved.accounts;
  state.payments = saved.payments;
  state.logs = saved.logs;
  state.ops = saved.ops;
}

function byId(rows: Row[], id: string): Row | undefined {
  return rows.find((row) => row.id === id);
}

function changeLogCreate(inTransaction: boolean) {
  return async (args: { data: Record<string, unknown> }) => {
    state.order.push("change-log");
    if (state.logFails) throw new Error("журнал не записан");
    state.logs.push({ ...args.data, inTransaction });
  };
}

function makeTx() {
  return {
    $queryRaw: async () => {
      state.order.push("lock");
      return [];
    },
    setting: {
      findUnique: async () => {
        state.order.push("cost-flow-read");
        return null;
      },
    },
    employee: {
      findMany: async () => state.employees.map((row) => ({ ...row })),
      create: async (args: { data: Row }) => {
        if (state.employeeCreateFails) throw new Error("сотрудник не создан");
        const row = { ...args.data, id: `emp-${++state.nextId}` };
        state.employees.push(row);
        return { ...row };
      },
      update: async (args: { where: { id: string }; data: Row }) => {
        const index = state.employees.findIndex((row) => row.id === args.where.id);
        const next = { ...state.employees[index], ...args.data };
        state.employees[index] = next;
        return { ...next };
      },
      delete: async (args: { where: { id: string } }) => {
        state.employees = state.employees.filter((row) => row.id !== args.where.id);
      },
    },
    material: {
      create: async (args: { data: Row }) => {
        const row = { ...args.data, id: `mat-${++state.nextId}`, status: "ACTIVE" };
        state.materials.push(row);
        return { ...row };
      },
      update: async (args: { where: { id: string }; data: Row }) => {
        const index = state.materials.findIndex((row) => row.id === args.where.id);
        const next = { ...state.materials[index], ...args.data };
        state.materials[index] = next;
        return { ...next };
      },
      delete: async (args: { where: { id: string } }) => {
        state.materials = state.materials.filter((row) => row.id !== args.where.id);
      },
    },
    account: {
      update: async (args: { where: { id: string }; data: { confirmed: boolean } }) => {
        state.order.push("account-update");
        const index = state.accounts.findIndex((row) => row.id === args.where.id);
        const next = { ...state.accounts[index], ...args.data };
        state.accounts[index] = next;
        return { ...next };
      },
    },
    cashFlow: {
      findMany: async () => [],
    },
    dealItem: {
      findMany: async () => [],
    },
    productionOperation: {
      findMany: async (args: { where?: { id?: { in?: string[] } } }) => {
        const ids = args.where?.id?.in;
        const rows = ids ? state.ops.filter((op) => ids.includes(op.id)) : state.ops;
        return rows.map((op) => ({ ...op, lines: [] }));
      },
      updateMany: async (args: { data: { isPaid: boolean; paidAt: Date } }) => {
        for (const op of state.ops) {
          op.isPaid = args.data.isPaid;
          op.paidAt = args.data.paidAt;
        }
        return { count: state.ops.length };
      },
    },
    payment: {
      create: async (args: { data: Row }) => {
        const row = { ...args.data, id: `pay-${++state.nextId}`, items: [] as Row[] };
        state.payments.push(row);
        return { ...row };
      },
    },
    paymentBatchItem: {
      createMany: async (args: { data: Array<{ paymentId: string; operationId: string }> }) => {
        const payment = state.payments.find((row) => row.id === args.data[0]?.paymentId);
        if (payment) payment.items = args.data;
        return { count: args.data.length };
      },
    },
    detail: { findMany: async () => [] },
    notification: {
      upsert: async () => ({ id: "note-1" }),
    },
    changeLog: { create: changeLogCreate(true) },
  };
}

vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({
    id: ADMIN_ID,
    name: "Админ",
    email: "admin@example.invalid",
    role: "ADMIN",
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/db", () => ({
  prisma: {
    $transaction: async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => {
      const saved = snapshot();
      try {
        return await fn(makeTx());
      } catch (error) {
        restore(saved);
        throw error;
      }
    },
    employee: {
      findMany: async () => state.employees.map((row) => ({ ...row })),
      findUnique: async (args: { where: { id: string }; include?: { _count?: unknown } }) => {
        const row = byId(state.employees, args.where.id);
        if (!row) return null;
        return args.include?._count ? { ...row, _count: { operations: 0 } } : { ...row };
      },
      create: async (args: { data: Row }) => {
        if (state.employeeCreateFails) throw new Error("сотрудник не создан");
        const row = { ...args.data, id: `emp-${++state.nextId}` };
        state.employees.push(row);
        return { ...row };
      },
      update: async (args: { where: { id: string }; data: Row }) => {
        const index = state.employees.findIndex((row) => row.id === args.where.id);
        const next = { ...state.employees[index], ...args.data };
        state.employees[index] = next;
        return { ...next };
      },
      delete: async (args: { where: { id: string } }) => {
        state.employees = state.employees.filter((row) => row.id !== args.where.id);
      },
    },
    material: {
      findMany: async () => state.materials.map((row) => ({ ...row })),
      findFirst: async () => null,
      findUnique: async (args: { where: { id: string } }) => {
        const row = byId(state.materials, args.where.id);
        return row ? { ...row } : null;
      },
      count: async () => 0,
      create: async (args: { data: Row }) => {
        const row = { ...args.data, id: `mat-${++state.nextId}`, status: "ACTIVE" };
        state.materials.push(row);
        return { ...row };
      },
      update: async (args: { where: { id: string }; data: Row }) => {
        const index = state.materials.findIndex((row) => row.id === args.where.id);
        const next = { ...state.materials[index], ...args.data };
        state.materials[index] = next;
        return { ...next };
      },
      delete: async (args: { where: { id: string } }) => {
        state.materials = state.materials.filter((row) => row.id !== args.where.id);
      },
    },
    batch: { count: async () => 0 },
    detail: {
      count: async () => 0,
      findMany: async () => [],
    },
    product: { count: async () => 0 },
    blankStock: { count: async () => 0 },
    account: {
      findUniqueOrThrow: async (args: { where: { id: string } }) => {
        const row = byId(state.accounts, args.where.id);
        if (!row) throw new Error("Счёт не найден");
        return { ...row };
      },
      update: async (args: { where: { id: string }; data: { confirmed: boolean } }) => {
        const index = state.accounts.findIndex((row) => row.id === args.where.id);
        const next = { ...state.accounts[index], ...args.data };
        state.accounts[index] = next;
        return { ...next };
      },
    },
    cashFlow: { findMany: async () => [] },
    productionOperation: {
      findMany: async () => state.ops.map((op) => ({ ...op, lines: [] })),
    },
    payment: {
      findMany: async () => state.payments.map((row) => ({ ...row })),
    },
    changeLog: { create: changeLogCreate(false) },
  },
}));

import { archiveEmployee, createEmployee, deleteEmployee, updateEmployee } from "@/server/employees";
import { archiveMaterial, createMaterial, deleteMaterial, updateMaterial } from "@/server/materials";
import { markEmployeePaid } from "@/server/payroll";
import { setAccountConfirmed } from "@/server/finance";

const employeeForm: EmployeeFormValues = {
  fullName: "Иванов Иван",
  birthDate: null,
  pin: "1234",
  hourlyRate: null,
  rateTorcovkaSort1: null,
  rateTorcovkaSort2: null,
  ratePrisadka: null,
  rateUpakovka: null,
};

const materialForm: MaterialFormValues = {
  name: "Сосна",
  sectionWidthMm: 40,
  sectionHeightMm: 20,
  sortOrder: 1,
};

function seedEmployee(pin = "1234"): Row {
  const row: Row = {
    id: "emp-seed",
    fullName: "Иванов Иван",
    birthDate: null,
    pin,
    status: "ACTIVE",
    hourlyRate: null,
    rateTorcovkaSort1: null,
    rateTorcovkaSort2: null,
    ratePrisadkaTorcev: null,
    ratePrisadkaPloskt: null,
    rateUpakovka: null,
  };
  state.employees = [row];
  return row;
}

function seedMaterial(): void {
  state.materials = [
    {
      id: "mat-seed",
      name: "Сосна",
      sectionWidthMm: 40,
      sectionHeightMm: 20,
      status: "ACTIVE",
      sortOrder: 1,
    },
  ];
}

function seedAccount(): void {
  state.accounts = [
    {
      id: "acc-1",
      name: "Касса",
      openingBalance: 0,
      balanceAsOf: null,
      balanceMismatch: false,
      confirmed: false,
      isPrimary: false,
      accountNumber: null,
      bik: null,
    },
  ];
}

function seedHoursOp(): void {
  state.ops = [
    {
      id: "op-1",
      employeeId: "emp-1",
      isPaid: false,
      cancelledAt: null,
      type: "HOURS",
      hours: 2,
      productQty: null,
      workDate: new Date("2026-11-01T00:00:00.000Z"),
      batchId: null,
      hourlyRateSnapshot: 50,
      rateTorcovkaSort1Snapshot: null,
      rateTorcovkaSort2Snapshot: null,
      ratePrisadkaTorcevSnapshot: null,
      ratePrisadkaPlosktSnapshot: null,
      rateUpakovkaSnapshot: null,
    },
  ];
}

function expectAdminLog(entity: string) {
  expect(state.logs).toHaveLength(1);
  expect(state.logs[0]?.entity).toBe(entity);
  expect(state.logs[0]?.userId).toBe(ADMIN_ID);
  expect(state.logs[0]?.inTransaction).toBe(true);
  expect(JSON.stringify(state.logs[0])).not.toContain("1234");
  expect(JSON.stringify(state.logs[0])).not.toContain("9876");
  expect(JSON.stringify(state.logs[0])).not.toContain('"pin"');
}

beforeEach(() => {
  state.logFails = false;
  state.employeeCreateFails = false;
  state.employees = [];
  state.materials = [];
  state.accounts = [];
  state.payments = [];
  state.logs = [];
  state.ops = [];
  state.order = [];
  state.nextId = 0;
});

describe("журнал называет администратора и пишется в той же транзакции", () => {
  it("создание сотрудника пишет User.id администратора и не пишет PIN", async () => {
    await createEmployee({ ...employeeForm, userId: "client-forged" } as EmployeeFormValues);
    expectAdminLog("Employee");
    expect(state.employees).toHaveLength(1);
  });

  it("сбой журнала откатывает создание сотрудника", async () => {
    state.logFails = true;
    await expect(createEmployee(employeeForm)).rejects.toThrow("журнал не записан");
    expect(state.employees).toEqual([]);
    expect(state.logs).toEqual([]);
  });

  it("сбой создания сотрудника не оставляет запись журнала", async () => {
    state.employeeCreateFails = true;
    await expect(createEmployee(employeeForm)).rejects.toThrow("сотрудник не создан");
    expect(state.employees).toEqual([]);
    expect(state.logs).toEqual([]);
  });

  it("правка сотрудника пишет администратора и только факт смены PIN", async () => {
    seedEmployee("1234");
    await updateEmployee("emp-seed", { ...employeeForm, pin: "9876" });
    expectAdminLog("Employee");
    expect(state.logs[0]?.newValues).toMatchObject({ pinChanged: true });
  });

  it("архив и удаление сотрудника пишут того же администратора", async () => {
    seedEmployee();
    await archiveEmployee("emp-seed");
    expectAdminLog("Employee");

    state.logs = [];
    await deleteEmployee("emp-seed");
    expectAdminLog("Employee");
    expect(state.employees).toEqual([]);
  });

  it("создание материала пишет User.id администратора", async () => {
    await createMaterial(materialForm);
    expectAdminLog("Material");
    expect(state.materials).toHaveLength(1);
  });

  it("сбой журнала откатывает создание материала", async () => {
    state.logFails = true;
    await expect(createMaterial(materialForm)).rejects.toThrow("журнал не записан");
    expect(state.materials).toEqual([]);
    expect(state.logs).toEqual([]);
  });

  it("правка, архив и удаление материала пишут того же администратора", async () => {
    seedMaterial();
    await updateMaterial("mat-seed", { ...materialForm, name: "Ель" });
    expectAdminLog("Material");

    state.logs = [];
    await archiveMaterial("mat-seed");
    expectAdminLog("Material");

    state.logs = [];
    await deleteMaterial("mat-seed");
    expectAdminLog("Material");
    expect(state.materials).toEqual([]);
  });

  it("выплата зарплаты пишет администратора внутри существующей транзакции", async () => {
    seedHoursOp();
    await markEmployeePaid("emp-1");
    expectAdminLog("Payment");
    expect(state.logs[0]?.userId).not.toBe("emp-1");
    expect(state.payments).toHaveLength(1);
    expect(state.order.indexOf("lock")).toBeLessThan(state.order.indexOf("change-log"));
  });

  it("сбой журнала откатывает выплату", async () => {
    seedHoursOp();
    state.logFails = true;
    await expect(markEmployeePaid("emp-1")).rejects.toThrow("журнал не записан");
    expect(state.payments).toEqual([]);
    expect(state.ops[0]?.isPaid).toBe(false);
    expect(state.logs).toEqual([]);
  });

  it("подтверждение счёта пишет администратора в той же транзакции, что и смену счёта", async () => {
    seedAccount();
    const account = await setAccountConfirmed("acc-1", true);
    expect(account.confirmed).toBe(true);
    expectAdminLog("Account");
    expect(state.order).toEqual([
      "lock",
      "cost-flow-read",
      "cost-flow-read",
      "account-update",
      "change-log",
    ]);
  });

  it("сбой журнала откатывает подтверждение счёта", async () => {
    seedAccount();
    state.logFails = true;
    await expect(setAccountConfirmed("acc-1", true)).rejects.toThrow("журнал не записан");
    expect(state.accounts[0]?.confirmed).toBe(false);
    expect(state.logs).toEqual([]);
  });
});
