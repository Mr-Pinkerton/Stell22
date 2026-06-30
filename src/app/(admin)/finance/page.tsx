import { FinanceView } from "@/components/finance/finance-view";
import { getFinanceData } from "@/server/finance";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const data = await getFinanceData();
  return <FinanceView data={data} />;
}
