import { ReportsView } from "@/components/reports/reports-view";
import { getCostReport } from "@/server/cost";
import { getSalaryReport } from "@/server/payroll";
import { getPurchaseReport, getWasteReport } from "@/server/reports";
import { periodFromParams } from "@/lib/report-period";

export const dynamic = "force-dynamic";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Охват отчёта себестоимости: календарный месяц по умолчанию, диапазон/всё
  // время — из URL (A11/A12). Дата производства = дата операции.
  const period = periodFromParams(sp);
  const [cost, salary, purchases, waste] = await Promise.all([
    getCostReport(period),
    getSalaryReport(),
    getPurchaseReport(),
    getWasteReport(),
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
