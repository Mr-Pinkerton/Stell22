import { WarehouseView } from "@/components/warehouse/warehouse-view";
import { getWarehouseStock, getInventoryDocs } from "@/server/warehouse";
import { getMpStock, getSupplies } from "@/server/marketplace";

// Данные из БД — рендер на запрос.
export const dynamic = "force-dynamic";

export default async function WarehousePage() {
  const [stock, docs, mpStock, supplies] = await Promise.all([
    getWarehouseStock(),
    getInventoryDocs(),
    getMpStock(),
    getSupplies(),
  ]);
  return (
    <WarehouseView stock={stock} initialDocs={docs} mpStock={mpStock} supplies={supplies} />
  );
}
