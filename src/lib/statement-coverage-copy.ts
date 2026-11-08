import type { AccountCoverageSummary } from "@/lib/bank-statement-integrity";
import { formatIsoDate } from "@/lib/format";

/** Несколько проверенных выписок на одну дату. Это не вывод о дублях операций. */
export function severalStatementsLabel(dates: readonly string[]): string {
  const formatted = dates.map((day) => formatIsoDate(day));
  if (formatted.length <= 1) return `За ${formatted[0] ?? ""} загружено несколько выписок`;
  return `За даты ${formatted.join(", ")} загружено по несколько выписок`;
}

export function missingBusinessDaysLabel(dates: readonly string[]): string {
  return `Нет выписок за рабочие дни: ${dates.map((day) => formatIsoDate(day)).join(", ")}`;
}

export function trailingBusinessDaysLabel(dates: readonly string[]): string {
  return `После последней выписки нет данных за рабочие дни: ${dates.map((day) => formatIsoDate(day)).join(", ")}`;
}

export function accountIssuePhrases(row: AccountCoverageSummary): string[] {
  const phrases: string[] = [];
  if (row.overlappingDates.length > 0) {
    phrases.push(severalStatementsLabel(row.overlappingDates.map((day) => day.date)));
  }
  if (row.missingDates.length > 0) phrases.push(missingBusinessDaysLabel(row.missingDates));
  if (row.trailingBusinessDates.length > 0) {
    phrases.push(trailingBusinessDaysLabel(row.trailingBusinessDates));
  }
  return phrases;
}

function accountsDative(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "счёту";
  return "счетам";
}

export type CoverageNotice = {
  tone: "warning" | "neutral";
  headline: "Есть замечания" | null;
  summary: string;
};

export function coverageNotice(rows: readonly AccountCoverageSummary[]): CoverageNotice {
  const affected = rows.filter((row) => accountIssuePhrases(row).length > 0);
  if (affected.length === 1) {
    const row = affected[0]!;
    return {
      tone: "warning",
      headline: "Есть замечания",
      summary: `${row.accountName}: ${accountIssuePhrases(row).join(". ")}.`,
    };
  }
  if (affected.length > 1) {
    const kinds: string[] = [];
    if (affected.some((row) => row.overlappingDates.length > 0)) {
      kinds.push("за одни даты загружено несколько выписок");
    }
    if (affected.some((row) => row.missingDates.length > 0)) {
      kinds.push("нет выписок за рабочие дни");
    }
    if (affected.some((row) => row.trailingBusinessDates.length > 0)) {
      kinds.push("после последних выписок нет данных за рабочие дни");
    }
    const joined = kinds.join("; ");
    const detail = joined ? ` ${joined.charAt(0).toUpperCase()}${joined.slice(1)}.` : "";
    return {
      tone: "warning",
      headline: "Есть замечания",
      summary: `Замечания по ${affected.length} ${accountsDative(affected.length)}.${detail}`,
    };
  }
  if (rows.every((row) => row.status === "UNKNOWN")) {
    return {
      tone: "neutral",
      headline: null,
      summary: "Нет подтверждённых периодов выписок",
    };
  }
  return {
    tone: "neutral",
    headline: null,
    summary: "Замечаний по проверенным периодам нет",
  };
}
