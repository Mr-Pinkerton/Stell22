import { WarehouseView } from "@/components/warehouse/warehouse-view";
import { getWarehouseStock, getInventoryDocs } from "@/server/warehouse";
import { getMpStock } from "@/server/marketplace";

// Данные из БД — рендер на запрос.
export const dynamic = "force-dynamic";

export default async function WarehousePage() {
  const [stock, docs, mpStock] = await Promise.all([
    getWarehouseStock(),
    getInventoryDocs(),
    getMpStock(),
  ]);
  return <WarehouseView stock={stock} initialDocs={docs} mpStock={mpStock} />;
}
