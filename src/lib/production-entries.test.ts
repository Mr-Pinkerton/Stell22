import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import type { ProductionEntryRow } from "@/mocks/production-fixtures";
import {
  filterProductionEntries,
  filterProductionEntriesByCreatedAt,
  filterProductionTableRows,
  formatProductionQuantity,
  getDefaultProductionCreatedAtFilter,
  getDefaultProductionTableFilters,
  isProductionCreatedAtFilterDefault,
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

describe("filterProductionEntriesByCreatedAt", () => {
  // 2026-06-30T21:30:00Z = 01.07.2026, 00:30 Europe/Moscow (см. format.test.ts).
  const midnightMoscow = row({
    id: "utc-june-msk-july",
    workDate: "2026-06-30",
    createdAt: "2026-06-30T21:30:00.000Z",
  });
  const juneAfternoon = row({
    id: "june-afternoon",
    workDate: "2026-06-15",
    createdAt: "2026-06-15T10:00:00.000Z",
  });
  const rows = [midnightMoscow, juneAfternoon];

  const june = {
    allTime: false,
    month: createLocalDate(2026, 5, 1),
    rangeStart: null,
    rangeEnd: null,
  };
  const july = {
    allTime: false,
    month: createLocalDate(2026, 6, 1),
    rangeStart: null,
    rangeEnd: null,
  };

  it("режет по календарному дню createdAt в зоне проекта, не по UTC-дате", () => {
    expect(filterProductionEntriesByCreatedAt(rows, june).map((r) => r.id)).toEqual([
      "june-afternoon",
    ]);
    expect(filterProductionEntriesByCreatedAt(rows, july).map((r) => r.id)).toEqual([
      "utc-june-msk-july",
    ]);
  });

  it("allTime возвращает все", () => {
    expect(
      filterProductionEntriesByCreatedAt(rows, {
        allTime: true,
        month: new Date(),
        rangeStart: null,
        rangeEnd: null,
      }),
    ).toHaveLength(2);
  });

  it("независим от workDate: AND с фильтром даты работы", () => {
    const byWork = filterProductionEntries(rows, june);
    expect(byWork.map((r) => r.id)).toEqual(["utc-june-msk-july", "june-afternoon"]);
    expect(filterProductionEntriesByCreatedAt(byWork, july).map((r) => r.id)).toEqual([
      "utc-june-msk-july",
    ]);
    expect(filterProductionEntriesByCreatedAt(byWork, june).map((r) => r.id)).toEqual([
      "june-afternoon",
    ]);
  });
});

describe("getDefaultProductionCreatedAtFilter / reset", () => {
  it("по умолчанию и после reset — За всё время, не текущий месяц", () => {
    const defaults = getDefaultProductionCreatedAtFilter();
    expect(defaults.allTime).toBe(true);
    expect(isProductionCreatedAtFilterDefault(defaults)).toBe(true);
    expect(
      isProductionCreatedAtFilterDefault({
        month: createLocalDate(2026, 8, 1),
        rangeStart: null,
        rangeEnd: null,
        allTime: false,
      }),
    ).toBe(false);
  });

  it("default allTime не отрезает workDate-период по месяцу внесения", () => {
    const rows = [
      row({
        id: "june-work-sept-entry",
        workDate: "2026-06-15",
        createdAt: "2026-09-09T13:07:00.000Z",
      }),
    ];
    const juneWork = filterProductionEntries(rows, {
      allTime: false,
      month: createLocalDate(2026, 5, 1),
      rangeStart: null,
      rangeEnd: null,
    });
    expect(juneWork.map((r) => r.id)).toEqual(["june-work-sept-entry"]);
    expect(
      filterProductionEntriesByCreatedAt(juneWork, getDefaultProductionCreatedAtFilter()).map(
        (r) => r.id,
      ),
    ).toEqual(["june-work-sept-entry"]);
  });
});

describe("formatProductionQuantity", () => {
  it("торцовка / присадка / часы — количество и единица", () => {
    expect(formatProductionQuantity(row({ id: "t", type: "TORCOVKA", quantity: 10 }))).toBe(
      "10 дет",
    );
    expect(formatProductionQuantity(row({ id: "p", type: "PRISADKA", quantity: 5 }))).toBe(
      "5 присадк.",
    );
    expect(formatProductionQuantity(row({ id: "h", type: "HOURS", quantity: 8 }))).toBe("8 ч");
  });

  it("упаковка добавляет имя изделия, если оно есть", () => {
    expect(formatProductionQuantity(row({ id: "u1", type: "UPAKOVKA", quantity: 2 }))).toBe("2 шт");
    expect(
      formatProductionQuantity(
        row({ id: "u2", type: "UPAKOVKA", quantity: 2, productName: "Стеллаж 5" }),
      ),
    ).toBe("2 шт · Стеллаж 5");
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
