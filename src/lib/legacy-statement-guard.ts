export interface LegacyStatementEvidence {
  id: string;
  /** Сохранённая Statement.date. Это не доказанный periodStart/periodEnd. */
  date: string;
}

export interface LegacyCashFlowEvidence {
  id: string;
  date: string;
  importKey: string | null;
}

export interface LegacyImportCollision {
  periodStart: string;
  periodEnd: string;
  statementDates: Array<{ id: string; date: string }>;
  cashFlowDates: Array<{ id: string; date: string }>;
  importKeys: Array<{ id: string; importKey: string }>;
}

function inPeriod(date: string, periodStart: string, periodEnd: string): boolean {
  return date >= periodStart && date <= periodEnd;
}

/**
 * Пересечение новой выписки с непроверенной историей того же счёта.
 * Одна совпавшая операция не становится доказанным периодом.
 */
export function findLegacyImportCollision(input: {
  periodStart: string;
  periodEnd: string;
  incomingImportKeys: string[];
  legacyStatements: LegacyStatementEvidence[];
  legacyCashFlows: LegacyCashFlowEvidence[];
}): LegacyImportCollision | null {
  const statementDates = input.legacyStatements
    .filter((row) => inPeriod(row.date, input.periodStart, input.periodEnd))
    .map((row) => ({ id: row.id, date: row.date }));
  const cashFlowDates = input.legacyCashFlows
    .filter((row) => inPeriod(row.date, input.periodStart, input.periodEnd))
    .map((row) => ({ id: row.id, date: row.date }));
  const incoming = new Set(input.incomingImportKeys);
  const importKeys = input.legacyCashFlows.flatMap((row) =>
    row.importKey && incoming.has(row.importKey)
      ? [{ id: row.id, importKey: row.importKey }]
      : [],
  );
  if (statementDates.length === 0 && cashFlowDates.length === 0 && importKeys.length === 0) {
    return null;
  }
  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    statementDates,
    cashFlowDates,
    importKeys,
  };
}

export function legacyImportCollisionMessage(collision: LegacyImportCollision): string {
  const evidence: string[] = [];
  if (collision.statementDates.length > 0) {
    evidence.push(
      `сохранённые выписки без установленного периода: ${collision.statementDates
        .slice(0, 3)
        .map((row) => `${row.id} (сохранённая дата ${row.date})`)
        .join(", ")}`,
    );
  }
  if (collision.cashFlowDates.length > 0) {
    evidence.push(
      `операции непроверенной истории: ${collision.cashFlowDates
        .slice(0, 3)
        .map((row) => `${row.id} от ${row.date}`)
        .join(", ")}`,
    );
  }
  if (collision.importKeys.length > 0) {
    evidence.push(
      `ключи операций уже есть у записей ${collision.importKeys
        .slice(0, 3)
        .map((row) => row.id)
        .join(", ")}`,
    );
  }
  return (
    `Импорт остановлен: период ${collision.periodStart}–${collision.periodEnd} пересекает непроверенную историю этого счёта ` +
    `(${evidence.join("; ")}). Совпадение отдельных операций не доказывает весь исторический период. ` +
    `Новая выписка не создана. Загрузите период, который не включает эти сохранённые даты и ключи.`
  );
}

/** Все операции файла уже сохранены на счёте: пустую вторую выписку создавать нельзя. */
export function incomingKeysAlreadyStored(incoming: string[], stored: string[]): boolean {
  if (incoming.length === 0) return false;
  const present = new Set(stored);
  return incoming.every((key) => present.has(key));
}

export const DUPLICATE_STORED_OPERATIONS_MESSAGE =
  "Импорт остановлен: все операции файла уже есть на этом счёте. Пустая повторная выписка не создаётся.";
