// Общие типы экспорта в xlsx (используются и клиентом, и серверным экшеном).

export interface XlsxColumn {
  header: string;
  key: string;
  width?: number;
  /** Числовой формат ExcelJS (напр. `#,##0" ₽"`). Если задан — ячейка числовая. */
  numFmt?: string;
}

export interface XlsxSheet {
  name: string;
  columns: XlsxColumn[];
  rows: Record<string, string | number | null>[];
}

// Готовые форматы чисел для колонок (ExcelJS numFmt).
export const XLSX_FMT = {
  money: '#,##0" ₽"',
  length: '#,##0.0" м"',
  volume: '#,##0.0000" м³"',
  int: "#,##0",
  pct: '0"%"',
} as const;
