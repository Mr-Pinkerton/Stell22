"use server";

import ExcelJS from "exceljs";
import type { XlsxSheet } from "@/lib/xlsx-types";

/**
 * Сборка книги .xlsx из листов. Возвращает base64 (клиент декодирует и
 * скачивает). ExcelJS остаётся серверным — не тянем его в клиентский бандл.
 */
export async function buildXlsx(sheets: XlsxSheet[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Stell22";
  wb.created = new Date();

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31)); // лимит Excel на имя листа
    ws.columns = sheet.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width ?? 18,
      style: c.numFmt ? { numFmt: c.numFmt } : undefined,
    }));

    for (const row of sheet.rows) ws.addRow(row);

    const header = ws.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: "middle" };
    header.height = 20;
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer).toString("base64");
}
