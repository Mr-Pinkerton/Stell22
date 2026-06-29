import { WarehouseView } from "@/components/warehouse/warehouse-view";
import { getWarehouseStock, getInventoryDocs } from "@/server/warehouse";

// Данные из БД — рендер на запрос.
export const dynamic = "force-dynamic";

export default async function WarehousePage() {
  const [stock, docs] = await Promise.all([getWarehouseStock(), getInventoryDocs()]);
  return <WarehouseView stock={stock} initialDocs={docs} />;
}
