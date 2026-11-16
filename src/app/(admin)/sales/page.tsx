import { SalesView } from "@/components/sales/sales-view";
import { marketplaceSyncProductionFreeze } from "@/lib/marketplace-sync-production-freeze";
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
  const freeze = marketplaceSyncProductionFreeze();
  return (
    <SalesView data={data} syncFrozenMessage={freeze.frozen ? freeze.message : null} />
  );
}
