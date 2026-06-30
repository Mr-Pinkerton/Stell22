import { ReportsView } from "@/components/reports/reports-view";
import { getCostReport } from "@/server/cost";
import { getSalaryReport } from "@/server/payroll";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const [cost, salary] = await Promise.all([getCostReport(), getSalaryReport()]);
  return <ReportsView cost={cost} salary={salary} />;
}
