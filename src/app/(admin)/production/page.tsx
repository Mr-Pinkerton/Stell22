import { ProductionView } from "@/components/production/production-view";
import { getProductionEntries } from "@/server/production";

// Данные из БД — рендер на запрос.
export const dynamic = "force-dynamic";

export default async function ProductionPage() {
  const entries = await getProductionEntries();
  return <ProductionView initialEntries={entries} />;
}
