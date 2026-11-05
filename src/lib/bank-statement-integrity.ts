// Provenance, verified 1C periods, and per-account coverage.
// Dates are inclusive calendar days, yyyy-mm-dd, compared in UTC.
// Coverage is never inferred from CashFlow dates.

export type CashFlowSource = "BANK" | "MANUAL";

export function isBankImportedOperation(row: {
  statementId: string | null;
  importKey: string | null;
}): boolean {
  return row.statementId != null || row.importKey != null;
}

export function transferGroupIsBankProtected(
  legs: Array<{ statementId: string | null; importKey: string | null }>,
): boolean {
  return legs.some(isBankImportedOperation);
}

export function cashFlowSource(row: {
  statementId: string | null;
  importKey: string | null;
  isAutoAssigned?: boolean;
  linkedToImportedTransfer: boolean;
}): CashFlowSource {
  if (isBankImportedOperation(row) || row.linkedToImportedTransfer) return "BANK";
  return "MANUAL";
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_SPAN_DAYS = 3660;

export function isRealCalendarDate(iso: string): boolean {
  const match = ISO_DAY.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function addDays(iso: string, days: number): string {
  const match = ISO_DAY.exec(iso);
  if (!match) throw new Error("Некорректная дата");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const FIXED_HOLIDAY_MD = new Set([
  "01-01",
  "01-02",
  "01-03",
  "01-04",
  "01-05",
  "01-06",
  "01-07",
  "01-08",
  "02-23",
  "03-08",
  "05-01",
  "05-09",
  "06-12",
  "11-04",
]);

/** Выходной или фиксированный праздник. Это не покрытие и не рабочий пропуск. */
export function isPotentialBankReportingGap(iso: string): boolean {
  const match = ISO_DAY.exec(iso);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return true;
  return FIXED_HOLIDAY_MD.has(iso.slice(5));
}

export function eachInclusiveDay(start: string, end: string): string[] {
  if (start > end) return [];
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    days.push(day);
    if (days.length > MAX_SPAN_DAYS) {
      throw new Error("Период выписки слишком длинный");
    }
  }
  return days;
}

export type PeriodCheck =
  | { ok: true; periodStart: string; periodEnd: string }
  | { ok: false; reason: string };

export function validateVerifiedPeriod(input: {
  dateStart: string | null;
  dateEnd: string | null;
  documentDates: string[];
  accountNumber: string | null;
  boundAccountNumber: string | null;
}): PeriodCheck {
  if (!input.dateStart || !input.dateEnd) {
    return { ok: false, reason: "В выписке нет доказанного периода: нужны ДатаНачала и ДатаКонца" };
  }
  if (!isRealCalendarDate(input.dateStart) || !isRealCalendarDate(input.dateEnd)) {
    return { ok: false, reason: "ДатаНачала или ДатаКонца не является календарной датой" };
  }
  if (input.dateStart > input.dateEnd) {
    return { ok: false, reason: "ДатаНачала позже ДатаКонца" };
  }
  if (!input.accountNumber) {
    return { ok: false, reason: "В выписке нет номера счёта" };
  }
  if (input.boundAccountNumber && input.boundAccountNumber !== input.accountNumber) {
    return { ok: false, reason: "Номер счёта выписки не совпадает со счётом привязки" };
  }
  for (const documentDate of input.documentDates) {
    if (!isRealCalendarDate(documentDate) || documentDate < input.dateStart || documentDate > input.dateEnd) {
      return {
        ok: false,
        reason: `Дата документа ${documentDate || "пуста"} вне периода ${input.dateStart}–${input.dateEnd}`,
      };
    }
  }
  eachInclusiveDay(input.dateStart, input.dateEnd);
  return { ok: true, periodStart: input.dateStart, periodEnd: input.dateEnd };
}

export function statementPeriodFields(input: {
  source: "MANUAL" | "BANK_1C" | null;
  periodStart: string | null;
  periodEnd: string | null;
  operationsCount: number;
}): {
  source: "MANUAL" | "BANK_1C" | null;
  periodStart: string | null;
  periodEnd: string | null;
  periodStatus: "VERIFIED" | "UNKNOWN" | "PLACEHOLDER";
  deletable: boolean;
} {
  const verified =
    input.source === "BANK_1C" && input.periodStart != null && input.periodEnd != null;
  const placeholder =
    !verified &&
    input.source === "MANUAL" &&
    input.operationsCount === 0 &&
    input.periodStart == null &&
    input.periodEnd == null;
  return {
    source: input.source,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    periodStatus: verified ? "VERIFIED" : placeholder ? "PLACEHOLDER" : "UNKNOWN",
    deletable: placeholder,
  };
}

export function periodsOverlap(
  left: { periodStart: string; periodEnd: string },
  right: { periodStart: string; periodEnd: string },
): boolean {
  return left.periodStart <= right.periodEnd && right.periodStart <= left.periodEnd;
}

export interface VerifiedInterval {
  statementId: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
}

export interface AccountCoverageSummary {
  accountId: string;
  accountName: string;
  status: "UNKNOWN" | "VERIFIED";
  asOf: string;
  coveredRanges: { start: string; end: string }[];
  missingDates: string[];
  possibleGapDates: string[];
  overlappingDates: { date: string; statementIds: string[] }[];
  trailingFrom: string | null;
  trailingTo: string | null;
  /** Рабочие дни после последней выписки до явной даты среза. */
  trailingBusinessDates: string[];
}

function mergeRanges(days: string[]): { start: string; end: string }[] {
  if (days.length === 0) return [];
  const ranges: { start: string; end: string }[] = [];
  let start = days[0]!;
  let previous = days[0]!;
  for (const day of days.slice(1)) {
    if (day === addDays(previous, 1)) {
      previous = day;
      continue;
    }
    ranges.push({ start, end: previous });
    start = day;
    previous = day;
  }
  ranges.push({ start, end: previous });
  return ranges;
}

export function coverAccounts(input: {
  asOf: string;
  accounts: Array<{ id: string; name: string }>;
  intervals: VerifiedInterval[];
}): AccountCoverageSummary[] {
  if (!isRealCalendarDate(input.asOf)) {
    throw new Error("Дата среза покрытия не является календарной датой");
  }
  return input.accounts.map((account) => {
    const intervals = input.intervals.filter((interval) => interval.accountId === account.id);
    if (intervals.length === 0) {
      return {
        accountId: account.id,
        accountName: account.name,
        status: "UNKNOWN",
        asOf: input.asOf,
        coveredRanges: [],
        missingDates: [],
        possibleGapDates: [],
        overlappingDates: [],
        trailingFrom: null,
        trailingTo: null,
        trailingBusinessDates: [],
      };
    }
    const first = intervals.map((interval) => interval.periodStart).sort()[0]!;
    const last = intervals.map((interval) => interval.periodEnd).sort().at(-1)!;
    const covered: string[] = [];
    const missing: string[] = [];
    const possibleGapDates: string[] = [];
    const overlapping: { date: string; statementIds: string[] }[] = [];
    for (const day of eachInclusiveDay(first, last)) {
      const owners = intervals
        .filter((interval) => interval.periodStart <= day && day <= interval.periodEnd)
        .map((interval) => interval.statementId)
        .sort();
      if (owners.length > 1) overlapping.push({ date: day, statementIds: owners });
      else if (owners.length === 1) covered.push(day);
      else if (isPotentialBankReportingGap(day)) possibleGapDates.push(day);
      else missing.push(day);
    }
    const trailingDays =
      input.asOf > last ? eachInclusiveDay(addDays(last, 1), input.asOf) : [];
    for (const day of trailingDays) {
      if (isPotentialBankReportingGap(day)) possibleGapDates.push(day);
    }
    return {
      accountId: account.id,
      accountName: account.name,
      status: "VERIFIED",
      asOf: input.asOf,
      coveredRanges: mergeRanges(covered),
      missingDates: missing,
      possibleGapDates,
      overlappingDates: overlapping,
      trailingFrom: trailingDays[0] ?? null,
      trailingTo: trailingDays.at(-1) ?? null,
      trailingBusinessDates: trailingDays.filter((day) => !isPotentialBankReportingGap(day)),
    };
  });
}

export function statementContentIdentity(input: {
  accountNumber: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: string | null;
  closingBalance: string | null;
  importKeys: string[];
}): string {
  return [
    input.accountNumber,
    input.periodStart,
    input.periodEnd,
    input.openingBalance ?? "",
    input.closingBalance ?? "",
    ...[...input.importKeys].sort(),
  ].join("\n");
}

export interface TransferPairLeg {
  id: string;
  accountId: string;
  flowType: "INCOME" | "EXPENSE";
  amount: string;
  date: string;
  isTransfer: boolean;
  paired: boolean;
  statementId: string | null;
  importKey: string | null;
}

export type TransferPairDecision =
  | { action: "create-synthetic" }
  | { action: "link-existing"; candidateId: string }
  | { action: "refuse"; reason: string };

function importParts(importKey: string | null): [string, string, string, string, string] | null {
  if (!importKey) return null;
  const parts = importKey.split("|");
  if (parts.length !== 5) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!, parts[4]!];
}

function sameBankDocument(left: string | null, right: string | null): boolean {
  const a = importParts(left);
  const b = importParts(right);
  if (!a || !b || a[0] === "" || a[0] !== b[0]) return false;
  return a[3] === b[3] && a[4] === b[4];
}

export function decideTransferPair(input: {
  source: TransferPairLeg;
  otherAccountId: string;
  candidates: TransferPairLeg[];
}): TransferPairDecision {
  const opposite = input.source.flowType === "INCOME" ? "EXPENSE" : "INCOME";
  const sameShape = input.candidates.filter(
    (candidate) =>
      candidate.accountId === input.otherAccountId &&
      candidate.flowType === opposite &&
      candidate.amount === input.source.amount &&
      candidate.date === input.source.date,
  );
  const strict = sameShape.filter(
    (candidate) =>
      !candidate.paired &&
      isBankImportedOperation(candidate) &&
      sameBankDocument(input.source.importKey, candidate.importKey),
  );
  const importedOtherDay = input.candidates.filter(
    (candidate) =>
      candidate.accountId === input.otherAccountId &&
      candidate.flowType === opposite &&
      candidate.amount === input.source.amount &&
      candidate.date !== input.source.date &&
      isBankImportedOperation(candidate),
  );
  if (strict.length === 1) return { action: "link-existing", candidateId: strict[0]!.id };
  if (strict.length > 1 || sameShape.length > 0 || importedOtherDay.length > 0) {
    return {
      action: "refuse",
      reason: "Нельзя сопоставить банковские операции только по сумме",
    };
  }
  return { action: "create-synthetic" };
}
