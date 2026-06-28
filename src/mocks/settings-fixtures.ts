export interface AppSettings {
  wasteThresholdPct: number;
  labelWidthMm: number;
  labelHeightMm: number;
}

export interface ApiKeyRow {
  id: string;
  service: string;
  description: string;
  keyValue: string;
  updatedAt: string;
}

export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface SystemLogRow {
  id: string;
  at: string;
  level: LogLevel;
  source: string;
  message: string;
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
  labelWidthMm: 58,
  labelHeightMm: 40,
};

/** Пароль для просмотра API-ключей в прототипе. */
export const SETTINGS_API_PASSWORD = "stell22";

export const apiKeyRows: ApiKeyRow[] = [
  {
    id: "api-ozon",
    service: "Ozon Seller API",
    description: "Остатки, поставки, отчёты",
    keyValue: "ozon_live_8f3a2c91d4e7b605",
    updatedAt: "2026-06-15T10:00:00.000Z",
  },
  {
    id: "api-wb",
    service: "Wildberries API",
    description: "Остатки и поставки",
    keyValue: "wb_stat_44ac90ef12bb8801",
    updatedAt: "2026-06-10T14:30:00.000Z",
  },
  {
    id: "api-bank",
    service: "Банк (выписки)",
    description: "Загрузка выписок в ДДС",
    keyValue: "bank_token_91fe22aa77cd",
    updatedAt: "2026-06-01T09:00:00.000Z",
  },
];

export const systemLogRows: SystemLogRow[] = [
  {
    id: "log-1",
    at: "2026-06-28T08:12:00.000Z",
    level: "INFO",
    source: "Ozon API",
    message: "Синхронизация остатков: 4 позиции",
  },
  {
    id: "log-2",
    at: "2026-06-28T07:45:00.000Z",
    level: "INFO",
    source: "Банк",
    message: "Выписка Тинькофф: 18 операций",
  },
  {
    id: "log-3",
    at: "2026-06-27T16:20:00.000Z",
    level: "WARN",
    source: "WB API",
    message: "Повтор запроса поставок (таймаут)",
  },
  {
    id: "log-4",
    at: "2026-06-27T11:05:00.000Z",
    level: "ERROR",
    source: "Принтер",
    message: "Этикетки: нет связи с устройством",
  },
  {
    id: "log-5",
    at: "2026-06-26T09:30:00.000Z",
    level: "INFO",
    source: "Система",
    message: "Инвентаризация inv-1 проведена",
  },
];

export const minStockRows: MinStockRow[] = [
  { id: "ms-prod-1", kind: "PRODUCT", name: "Полка настенная", minStock: 10 },
  { id: "ms-prod-2", kind: "PRODUCT", name: "Полка угловая", minStock: 8 },
  { id: "ms-det-1", kind: "DETAIL", name: "Полка 600", minStock: 50 },
  { id: "ms-nom-1", kind: "NOMENCLATURE", name: "Саморез 4x40", minStock: 500 },
  { id: "ms-nom-2", kind: "NOMENCLATURE", name: "Коробка стандарт", minStock: 50 },
  { id: "ms-nom-5", kind: "NOMENCLATURE", name: "Шуруп 3×25", minStock: 300 },
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
