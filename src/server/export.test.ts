import { describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";

vi.mock("@/server/session", () => ({
  requireAdmin: vi.fn(async () => ({
    id: "test-admin",
    name: "Test Admin",
    email: "admin@test.local",
    role: "ADMIN",
  })),
}));

import type { CostProductRow } from "@/lib/cost-report";
import { productCostXlsxSheet } from "@/lib/product-cost-sheet";
import { buildXlsx } from "@/server/export";
import { XLSX_FMT, type XlsxSheet } from "@/lib/xlsx-types";

async function readWorkbook(base64: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const bytes = Buffer.from(base64, "base64");
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return wb;
}

describe("buildXlsx", () => {
  it("создаёт книгу с листами, заголовками и значениями", async () => {
    const sheets: XlsxSheet[] = [
      {
        name: "Закупки",
        columns: [
          { header: "Партия", key: "name" },
          { header: "Сумма", key: "amount", numFmt: XLSX_FMT.money },
        ],
        rows: [
          { name: "Партия №1", amount: 12500 },
          { name: "Партия №2", amount: 0 },
        ],
      },
    ];

    const wb = await readWorkbook(await buildXlsx(sheets));
    const ws = wb.getWorksheet("Закупки");
    expect(ws).toBeDefined();

    expect(ws!.getRow(1).getCell(1).value).toBe("Партия");
    expect(ws!.getRow(1).getCell(2).value).toBe("Сумма");
    expect(ws!.getRow(2).getCell(1).value).toBe("Партия №1");
    expect(ws!.getRow(2).getCell(2).value).toBe(12500);
    expect(ws!.getColumn(2).numFmt).toBe(XLSX_FMT.money);
  });

  it("обрезает слишком длинное имя листа до лимита Excel (31 символ)", async () => {
    const longName = "Очень-длинное-имя-листа-которое-точно-длиннее-31";
    const wb = await readWorkbook(
      await buildXlsx([{ name: longName, columns: [{ header: "X", key: "x" }], rows: [{ x: 1 }] }]),
    );
    expect(wb.worksheets[0].name).toBe(longName.slice(0, 31));
    expect(wb.worksheets[0].name.length).toBeLessThanOrEqual(31);
  });

  it("ставит комплектующие числом между работой и прямой", async () => {
    const row: CostProductRow = {
      id: "shelf",
      name: "Полка",
      sku: "OZ-SHELF",
      material: 1600,
      materialPct: 95,
      work: 60,
      workPct: 4,
      materialsExtra: 22,
      direct: 1682,
      directPct: 100,
      overhead: 100,
      overheadPct: 6,
      full: 1782,
      details: [],
    };
    const wb = await readWorkbook(await buildXlsx([productCostXlsxSheet([row])]));
    const ws = wb.getWorksheet("Себестоимость (изделия)");
    expect(ws).toBeDefined();

    const headers = [1, 2, 3, 4, 5, 6, 7, 8].map((col) => ws!.getRow(1).getCell(col).value);
    expect(headers).toEqual([
      "Изделие",
      "Артикул",
      "Материал",
      "Работа",
      "Комплектующие",
      "Прямая",
      "Накладные",
      "Полная",
    ]);

    const values = [3, 4, 5, 6, 7, 8].map((col) => ws!.getRow(2).getCell(col).value);
    expect(values).toEqual([1600, 60, 22, 1682, 100, 1782]);
    for (const col of [3, 4, 5, 6, 7, 8]) {
      const cell = ws!.getRow(2).getCell(col);
      expect(typeof cell.value).toBe("number");
      expect(cell.value).not.toHaveProperty("formula");
      expect(ws!.getColumn(col).numFmt).toBe(XLSX_FMT.money);
    }
  });
});
