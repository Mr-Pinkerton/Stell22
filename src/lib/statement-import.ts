// Идемпотентность импорта банковской выписки. Чистое ядро вынесено из
// src/server/finance.ts, чтобы тестировать детерминированность ключа без БД.

export interface StatementDoc {
  docNumber: string | null;
  date: string;
  amount: number;
  payerAccount: string | null;
  payeeAccount: string | null;
}

/**
 * Детерминированный ключ операции выписки для защиты от повторного импорта.
 * Одна и та же операция (тот же номер/дата/сумма/счета) всегда даёт один ключ —
 * повторная загрузка того же файла пропускается (см. importStatement). Сумма
 * нормализуется до 2 знаков, чтобы 100 и 100.00 совпадали.
 */
export function statementImportKey(doc: StatementDoc): string {
  return [
    doc.docNumber ?? "",
    doc.date,
    doc.amount.toFixed(2),
    doc.payerAccount ?? "",
    doc.payeeAccount ?? "",
  ].join("|");
}
