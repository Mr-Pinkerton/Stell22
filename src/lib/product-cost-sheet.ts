import type { CostProductRow } from "@/lib/cost-report";
import { XLSX_FMT, type XlsxSheet } from "@/lib/xlsx-types";

/** Лист «Себестоимость (изделия)»: готовые числа, без формул. Комплектующие уже входят в прямую. */
export function productCostXlsxSheet(rows: CostProductRow[]): XlsxSheet {
  return {
    name: "Себестоимость (изделия)",
    columns: [
      { header: "Изделие", key: "name", width: 28 },
      { header: "Артикул", key: "sku" },
      { header: "Материал", key: "material", numFmt: XLSX_FMT.money },
      { header: "Работа", key: "work", numFmt: XLSX_FMT.money },
      { header: "Комплектующие", key: "materialsExtra", numFmt: XLSX_FMT.money },
      { header: "Прямая", key: "direct", numFmt: XLSX_FMT.money },
      { header: "Накладные", key: "overhead", numFmt: XLSX_FMT.money },
      { header: "Полная", key: "full", numFmt: XLSX_FMT.money },
    ],
    rows: rows.map((row) => ({
      name: row.name,
      sku: row.sku,
      material: row.material,
      work: row.work,
      materialsExtra: row.materialsExtra,
      direct: row.direct,
      overhead: row.overhead,
      full: row.full,
    })),
  };
}
