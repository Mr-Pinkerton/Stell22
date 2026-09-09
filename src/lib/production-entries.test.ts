import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import type { ProductionEntryRow } from "@/mocks/production-fixtures";
import {
  filterProductionEntries,
  filterProductionTableRows,
  getDefaultProductionTableFilters,
  isProductionExtraFiltersDefault,
  productionEmployeeOptions,
  sortProductionEntries,
} from "@/lib/production-entries";

function row(partial: Partial<ProductionEntryRow> & Pick<ProductionEntryRow, "id">): ProductionEntryRow {
  return {
    employeeId: "emp-1",
    employeeName: "Тест",
    type: "TORCOVKA",
    workDate: "2026-06-10",
    createdAt: "2026-06-10T10:00:00.000Z",
    quantity: 10,
    amount: 50,
    unitRate: 5,
    isPaid: false,
    changeLog: [],
    ...partial,
  };
}

describe("filterProductionEntries", () => {
  const rows = [
    row({ id: "a", workDate: "2026-06-01" }),
    row({ id: "b", workDate: "2026-06-15" }),
    row({ id: "c", workDate: "2026-07-01" }),
  ];

  it("фильтрует по месяцу", () => {
    const filtered = filterProductionEntries(rows, {
      allTime: false,
      month: createLocalDate(2026, 5, 1),
      rangeStart: null,
      rangeEnd: null,
    });
    expect(filtered.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("allTime возвращает все", () => {
    expect(
      filterProductionEntries(rows, {
        allTime: true,
        month: new Date(),
        rangeStart: null,
        rangeEnd: null,
      }),
    ).toHaveLength(3);
  });
});

describe("sortProductionEntries", () => {
  it("сортирует по createdAt убыванию", () => {
    const sorted = sortProductionEntries([
      row({ id: "old", createdAt: "2026-06-01T08:00:00.000Z" }),
      row({ id: "new", createdAt: "2026-06-10T12:00:00.000Z" }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["new", "old"]);
  });
});

const june = {
  allTime: false,
  month: createLocalDate(2026, 5, 1),
  rangeStart: null,
  rangeEnd: null,
};

const mixed: ProductionEntryRow[] = [
  row({
    id: "ivan-torc-paid",
    employeeId: "emp-ivan",
    employeeName: "Иванов",
    type: "TORCOVKA",
    workDate: "2026-06-10",
    isPaid: true,
  }),
  row({
    id: "ivan-hours-unpaid",
    employeeId: "emp-ivan",
    employeeName: "Иванов",
    type: "HOURS",
    workDate: "2026-07-02",
    isPaid: false,
  }),
  row({
    id: "petr-pris",
    employeeId: "emp-petr",
    employeeName: "Петров",
    type: "PRISADKA",
    workDate: "2026-06-15",
    isPaid: false,
  }),
  row({
    id: "other-ivan-upak",
    employeeId: "emp-ivan-2",
    employeeName: "Иванов",
    type: "UPAKOVKA",
    workDate: "2026-06-20",
    isPaid: true,
  }),
];

describe("filterProductionTableRows", () => {
  it("employee ALL → все", () => {
    expect(filterProductionTableRows(mixed, getDefaultProductionTableFilters())).toHaveLength(4);
  });

  it("конкретный employeeId → только его строки", () => {
    const rows = filterProductionTableRows(mixed, {
      ...getDefaultProductionTableFilters(),
      employeeId: "emp-ivan",
    });
    expect(rows.map((r) => r.id)).toEqual(["ivan-torc-paid", "ivan-hours-unpaid"]);
  });

  it("одинаковые имена у разных id не смешиваются", () => {
    const rows = filterProductionTableRows(mixed, {
      ...getDefaultProductionTableFilters(),
      employeeId: "emp-ivan-2",
    });
    expect(rows.map((r) => r.id)).toEqual(["other-ivan-upak"]);
  });

  it("operation ALL → все; конкретный type режет по type", () => {
    expect(
      filterProductionTableRows(mixed, {
        ...getDefaultProductionTableFilters(),
        operation: "ALL",
      }),
    ).toHaveLength(4);
    expect(
      filterProductionTableRows(mixed, {
        ...getDefaultProductionTableFilters(),
        operation: "TORCOVKA",
      }).map((r) => r.id),
    ).toEqual(["ivan-torc-paid"]);
    expect(
      filterProductionTableRows(mixed, {
        ...getDefaultProductionTableFilters(),
        operation: "PRISADKA",
      }).map((r) => r.id),
    ).toEqual(["petr-pris"]);
    expect(
      filterProductionTableRows(mixed, {
        ...getDefaultProductionTableFilters(),
        operation: "UPAKOVKA",
      }).map((r) => r.id),
    ).toEqual(["other-ivan-upak"]);
    expect(
      filterProductionTableRows(mixed, {
        ...getDefaultProductionTableFilters(),
        operation: "HOURS",
      }).map((r) => r.id),
    ).toEqual(["ivan-hours-unpaid"]);
  });

  it("payment ALL / PAID / UNPAID", () => {
    expect(
      filterProductionTableRows(mixed, {
        ...getDefaultProductionTableFilters(),
        payment: "ALL",
      }),
    ).toHaveLength(4);
    expect(
      filterProductionTableRows(mixed, {
        ...getDefaultProductionTableFilters(),
        payment: "PAID",
      }).every((r) => r.isPaid === true),
    ).toBe(true);
    expect(
      filterProductionTableRows(mixed, {
        ...getDefaultProductionTableFilters(),
        payment: "UNPAID",
      }).every((r) => r.isPaid === false),
    ).toBe(true);
  });

  it("date + employee + operation + payment через AND", () => {
    const period = filterProductionEntries(mixed, june);
    const rows = filterProductionTableRows(period, {
      employeeId: "emp-ivan",
      operation: "TORCOVKA",
      payment: "PAID",
    });
    expect(rows.map((r) => r.id)).toEqual(["ivan-torc-paid"]);
    expect(period.some((r) => r.id === "ivan-hours-unpaid")).toBe(false);
    expect(period.some((r) => r.id === "petr-pris")).toBe(true);
  });
});

describe("productionEmployeeOptions", () => {
  it("уникальны по employeeId; полный журнал шире period slice", () => {
    const july = {
      allTime: false,
      month: createLocalDate(2026, 6, 1),
      rangeStart: null,
      rangeEnd: null,
    };
    const period = filterProductionEntries(mixed, july);
    expect(period.map((r) => r.id)).toEqual(["ivan-hours-unpaid"]);
    expect(productionEmployeeOptions(period).map((o) => o.id)).toEqual(["emp-ivan"]);
    expect(productionEmployeeOptions(mixed).map((o) => o.id)).toEqual([
      "emp-ivan",
      "emp-ivan-2",
      "emp-petr",
    ]);
  });

  it("один id с разными labels → один option, первый label", () => {
    const rows = [
      row({ id: "a", employeeId: "emp-1", employeeName: "Иванов И." }),
      row({ id: "b", employeeId: "emp-1", employeeName: "Иванов Иван" }),
    ];
    expect(productionEmployeeOptions(rows)).toEqual([{ id: "emp-1", label: "Иванов И." }]);
  });
});

describe("isProductionExtraFiltersDefault", () => {
  it("defaults не dirty; любое отклонение → dirty", () => {
    expect(isProductionExtraFiltersDefault(getDefaultProductionTableFilters())).toBe(true);
    expect(
      isProductionExtraFiltersDefault({
        ...getDefaultProductionTableFilters(),
        employeeId: "emp-ivan",
      }),
    ).toBe(false);
    expect(
      isProductionExtraFiltersDefault({
        ...getDefaultProductionTableFilters(),
        operation: "HOURS",
      }),
    ).toBe(false);
    expect(
      isProductionExtraFiltersDefault({
        ...getDefaultProductionTableFilters(),
        payment: "UNPAID",
      }),
    ).toBe(false);
  });
});
