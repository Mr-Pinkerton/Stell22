export interface AppSettings {
  wasteThresholdPct: number;
}

export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface SystemLogRow {
  id: string;
  at: string;
  level: LogLevel;
  source: string;
  message: string;
  /** Структурированные детали (только операционный журнал). */
  details?: Record<string, unknown> | null;
  kind: "system" | "audit";
}

export type MinStockKind = "PRODUCT" | "DETAIL" | "NOMENCLATURE";

export interface MinStockRow {
  id: string;
  kind: MinStockKind;
  name: string;
  minStock: number;
}

export const defaultAppSettings: AppSettings = {
  wasteThresholdPct: 30,
};

export const systemLogRows: SystemLogRow[] = [
  {
    id: "log-1",
    at: "2026-06-28T08:12:00.000Z",
    level: "INFO",
    source: "Ozon API",
    message: "Синхронизация остатков: 4 позиции",
    kind: "system",
  },
  {
    id: "log-2",
    at: "2026-06-28T07:45:00.000Z",
    level: "INFO",
    source: "Банк",
    message: "Выписка Тинькофф: 18 операций",
    kind: "system",
  },
  {
    id: "log-3",
    at: "2026-06-27T16:20:00.000Z",
    level: "WARN",
    source: "WB API",
    message: "Повтор запроса поставок (таймаут)",
    kind: "system",
  },
  {
    id: "log-4",
    at: "2026-06-27T11:05:00.000Z",
    level: "ERROR",
    source: "Принтер",
    message: "Этикетки: нет связи с устройством",
    kind: "system",
  },
  {
    id: "log-5",
    at: "2026-06-26T09:30:00.000Z",
    level: "INFO",
    source: "Система",
    message: "Инвентаризация inv-1 проведена",
    kind: "audit",
  },
];

export const MIN_STOCK_KIND_LABEL: Record<MinStockKind, string> = {
  PRODUCT: "Изделие",
  DETAIL: "Деталь",
  NOMENCLATURE: "Номенклатура",
};

export const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  INFO: "Инфо",
  WARN: "Предупр.",
  ERROR: "Ошибка",
};
