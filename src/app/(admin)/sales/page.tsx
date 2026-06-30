import { SalesView } from "@/components/sales/sales-view";
import { getSalesData } from "@/server/marketplace";

export const dynamic = "force-dynamic";

export default async function SalesPage() {
  const data = await getSalesData();
  return <SalesView data={data} />;
}
