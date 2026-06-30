import { ReportsView } from "@/components/reports/reports-view";
import { getCostReport } from "@/server/cost";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const cost = await getCostReport();
  return <ReportsView cost={cost} />;
}
