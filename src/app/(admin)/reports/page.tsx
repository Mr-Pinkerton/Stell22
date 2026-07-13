import { ReportsView } from "@/components/reports/reports-view";
import { getCostReport } from "@/server/cost";
import { getSalaryReport } from "@/server/payroll";
import { getPurchaseReport, getWasteReport } from "@/server/reports";
import { periodFromParams, weekRangeFromParams } from "@/lib/report-period";

export const dynamic = "force-dynamic";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Охват отчётов: календарный месяц по умолчанию, диапазон/всё время — из URL
  // (A11/A12). Дата производства = дата операции. ЗП дополнительно сужается
  // выбранной неделей (пт–чт) — только для истории выплаченного.
  const period = periodFromParams(sp);
  const salaryScope = weekRangeFromParams(sp) ?? period;
  const [cost, salary, purchases, waste] = await Promise.all([
    getCostReport(period),
    getSalaryReport(salaryScope),
    getPurchaseReport(period),
    getWasteReport(period),
  ]);
  return (
    <ReportsView
      cost={cost}
      salary={salary}
      purchases={purchases}
      waste={waste}
    />
  );
}
