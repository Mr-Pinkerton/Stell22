import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
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
});
