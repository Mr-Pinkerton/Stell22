import { SalesView } from "@/components/sales/sales-view";
import { getSalesData } from "@/server/marketplace";
import { salesPeriodFromParams } from "@/lib/sales-period";

export const dynamic = "force-dynamic";

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const period = salesPeriodFromParams(sp);
  const data = await getSalesData(period);
  return <SalesView data={data} />;
}
