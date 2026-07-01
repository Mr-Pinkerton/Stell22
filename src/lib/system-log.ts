import type { LogLevel, SystemLogRow } from "@/mocks/settings-fixtures";

export type SystemLogLevel = LogLevel;

export interface SystemLogInput {
  level: SystemLogLevel;
  /** Короткая подпись источника, напр. «Маркетплейсы», «WB API». */
  source: string;
  /** Человекочитаемое сообщение для таблицы логов. */
  message: string;
  /** Структурированные детали (счётчики, ошибки API, период и т.д.). */
  details?: Record<string, unknown>;
  userId?: string | null;
}

export interface MpSyncSideReport {
  mode: "api" | "stub";
  sales: number;
  supplies: number;
  stocks: number;
  durationMs: number;
  error?: string;
}

export interface MpSyncReport {
  since: string;
  to: string;
  ok: boolean;
  durationMs: number;
  sources: { wb: "api" | "stub"; ozon: "api" | "stub" };
  wb: MpSyncSideReport;
  ozon: MpSyncSideReport;
  warnings: string[];
  totals: {
    sales: number;
    supplies: number;
    stocks: number;
    deductedFromProduction?: number;
    gpShortfall?: number;
    restoredFromCancelled?: number;
  };
  error?: string;
}

export function mpSyncLogLevel(report: Pick<MpSyncReport, "ok" | "warnings" | "totals">): SystemLogLevel {
  if (!report.ok) return "ERROR";
  if (report.warnings.length > 0) return "WARN";
  return "INFO";
}

export function formatMpSyncMessage(report: MpSyncReport): string {
  const { totals, wb, ozon, ok } = report;
  if (!ok) {
    return report.error ?? report.warnings.join("; ") ?? "Синхронизация не выполнена";
  }
  const parts = [
    `продажи ${totals.sales}`,
    `поставки ${totals.supplies}`,
    `остатки ${totals.stocks}`,
  ];
  if (totals.deductedFromProduction != null && totals.deductedFromProduction > 0) {
    parts.push(`списано ГП ${totals.deductedFromProduction}`);
  }
  if (totals.restoredFromCancelled != null && totals.restoredFromCancelled > 0) {
    parts.push(`возврат ГП ${totals.restoredFromCancelled}`);
  }
  if (report.warnings.length > 0) {
    return `Синхронизация с предупреждениями (${parts.join(", ")})`;
  }
  const modes = `WB:${wb.mode}, Ozon:${ozon.mode}`;
  return `Синхронизация (${parts.join(", ")}; ${modes})`;
}

export type SettingsLogRow = SystemLogRow;
