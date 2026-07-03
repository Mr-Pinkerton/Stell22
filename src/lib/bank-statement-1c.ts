// Парсер банковской выписки формата 1CClientBankExchange (kl_to_1c).
// Чистая функция: на вход — уже декодированный текст (CP1251/UTF-8 декодирует
// загрузчик), на выход — структура счёта и операций. Используется server/finance.

export interface Bank1CDocument {
  docNumber: string | null;
  date: string; // ISO yyyy-mm-dd
  amount: number;
  payerName: string | null;
  payerInn: string | null;
  payerAccount: string | null;
  payeeName: string | null;
  payeeInn: string | null;
  payeeAccount: string | null;
  purpose: string | null;
}

export interface Bank1CStatement {
  accountNumber: string | null;
  bik: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  documents: Bank1CDocument[];
}

/** dd.mm.yyyy → yyyy-mm-dd (или null). */
function toIso(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function toAmount(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

/** Является ли строка началом формата. */
export function is1CStatement(text: string): boolean {
  return text.trimStart().startsWith("1CClientBankExchange");
}

/**
 * Декодирование байтов выписки 1С по объявленной кодировке (Windows-1251 по
 * умолчанию, либо UTF-8 / DOS-866 из строки «Кодировка=…»). Работает и в
 * браузере, и в Node (глобальный `TextDecoder`). Используется загрузкой файла
 * в UI и приёмом выписок с почты.
 */
export function decodeStatementBytes(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let text = new TextDecoder("windows-1251").decode(bytes);
  const enc = text.match(/Кодировка\s*=\s*(\S+)/)?.[1]?.toUpperCase() ?? "";
  if (enc.includes("UTF")) text = new TextDecoder("utf-8").decode(bytes);
  else if (enc.includes("DOS") || enc.includes("866")) text = new TextDecoder("ibm866").decode(bytes);
  return text;
}

export function parse1CStatement(text: string): Bank1CStatement {
  const result: Bank1CStatement = {
    accountNumber: null,
    bik: null,
    dateStart: null,
    dateEnd: null,
    openingBalance: null,
    closingBalance: null,
    documents: [],
  };

  type Mode = "header" | "account" | "document";
  let mode: Mode = "header";
  let current: Partial<Bank1CDocument> & { raw?: Record<string, string> } = {};

  const lines = text.split(/\r?\n/);

  const flushDocument = () => {
    if (mode !== "document") return;
    result.documents.push({
      docNumber: current.docNumber ?? null,
      date: current.date ?? "",
      amount: current.amount ?? 0,
      payerName: current.payerName ?? null,
      payerInn: current.payerInn ?? null,
      payerAccount: current.payerAccount ?? null,
      payeeName: current.payeeName ?? null,
      payeeInn: current.payeeInn ?? null,
      payeeAccount: current.payeeAccount ?? null,
      purpose: current.purpose ?? null,
    });
    current = {};
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line === "СекцияРасчСчет") {
      mode = "account";
      continue;
    }
    if (line === "КонецРасчСчет") {
      mode = "header";
      continue;
    }
    if (line.startsWith("СекцияДокумент")) {
      flushDocument();
      mode = "document";
      current = {};
      continue;
    }
    if (line === "КонецДокумента") {
      flushDocument();
      mode = "header";
      continue;
    }
    if (line === "КонецФайла") {
      flushDocument();
      break;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (mode === "document") {
      switch (key) {
        case "Номер":
          current.docNumber = value || null;
          break;
        case "Дата":
          current.date = toIso(value) ?? "";
          break;
        case "Сумма":
          current.amount = toAmount(value);
          break;
        case "Плательщик":
        case "Плательщик1":
          if (!current.payerName) current.payerName = value || null;
          break;
        case "ПлательщикИНН":
          current.payerInn = value || null;
          break;
        case "ПлательщикСчет":
        case "ПлательщикРасчСчет":
          current.payerAccount = value || null;
          break;
        case "Получатель":
        case "Получатель1":
          if (!current.payeeName) current.payeeName = value || null;
          break;
        case "ПолучательИНН":
          current.payeeInn = value || null;
          break;
        case "ПолучательСчет":
        case "ПолучательРасчСчет":
          current.payeeAccount = value || null;
          break;
        case "НазначениеПлатежа":
          current.purpose = value || null;
          break;
      }
      continue;
    }

    // account / header
    switch (key) {
      case "РасчСчет":
        if (!result.accountNumber) result.accountNumber = value || null;
        break;
      case "БИК":
        if (!result.bik) result.bik = value || null;
        break;
      case "ДатаНачала":
        if (!result.dateStart) result.dateStart = toIso(value);
        break;
      case "ДатаКонца":
        if (!result.dateEnd) result.dateEnd = toIso(value);
        break;
      case "НачальныйОстаток":
        result.openingBalance = toAmount(value);
        break;
      case "КонечныйОстаток":
        result.closingBalance = toAmount(value);
        break;
    }
  }

  return result;
}
