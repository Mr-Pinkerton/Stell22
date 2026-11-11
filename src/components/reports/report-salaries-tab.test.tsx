/** @vitest-environment happy-dom */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SalaryDayLine, SalaryReportRow } from "@/mocks/report-fixtures";
import { ReportSalariesTab } from "@/components/reports/report-salaries-tab";

vi.mock("@/server/payroll", () => ({
  markEmployeePaid: vi.fn(),
}));

const WEEK_NOTE =
  "Неделя фильтрует историю выплат. К выплате показан весь неоплаченный остаток.";

function day(offset: number): string {
  const date = new Date(Date.UTC(2026, 0, 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function row(): SalaryReportRow {
  const days: SalaryDayLine[] = Array.from({ length: 32 }, (_, index) => ({
    date: day(index),
    hours: 1,
    torcovka: 0,
    prisadka: 0,
    upakovka: 0,
    total: 50,
  })).sort((a, b) => b.date.localeCompare(a.date));
  return {
    id: "unpaid:emp-1",
    employeeName: "Иванов",
    amountDue: 1600,
    produced: 0,
    avgPerUnit: 0,
    total: 1600,
    paid: false,
    paidAt: null,
    days,
  };
}

describe("ReportSalariesTab", () => {
  it("показывает все 32 дня и поясняет, что неделя не режет долг", async () => {
    const user = userEvent.setup();
    render(<ReportSalariesTab initialRows={[row()]} />);

    expect(screen.getByText(WEEK_NOTE)).toBeTruthy();

    await user.click(screen.getByText("Иванов"));
    expect(screen.getByText("01.01.2026")).toBeTruthy();
    expect(screen.getByText("01.02.2026")).toBeTruthy();
  });
});
