import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import type { ProductionEntryRow } from "@/mocks/production-fixtures";
import {
  filterProductionEntries,
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
