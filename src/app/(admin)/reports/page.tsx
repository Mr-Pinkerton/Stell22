import { ReportsView } from "@/components/reports/reports-view";
import { getCostReport } from "@/server/cost";
import { getSalaryReport } from "@/server/payroll";
import { getPurchaseReport, getWasteReport } from "@/server/reports";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const [cost, salary, purchases, waste] = await Promise.all([
    getCostReport(),
    getSalaryReport(),
    getPurchaseReport(),
    getWasteReport(),
  ]);
  return <ReportsView cost={cost} salary={salary} purchases={purchases} waste={waste} />;
}
