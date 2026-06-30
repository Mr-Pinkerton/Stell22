import { buildXlsx } from "@/server/export";
import type { XlsxSheet } from "@/lib/xlsx-types";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: XLSX_MIME });
}

/** Имя файла с датой: `<base>-2026-06-30.xlsx`. */
export function xlsxFileName(base: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${base}-${today}.xlsx`;
}

/**
 * Собрать книгу на сервере и скачать в браузере. Бросает при пустых данных,
 * чтобы вызывающий показал тост.
 */
export async function exportXlsx(fileBase: string, sheets: XlsxSheet[]): Promise<void> {
  const hasRows = sheets.some((s) => s.rows.length > 0);
  if (!hasRows) throw new Error("Нет данных для экспорта");

  const base64 = await buildXlsx(sheets);
  const blob = base64ToBlob(base64);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = xlsxFileName(fileBase);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
