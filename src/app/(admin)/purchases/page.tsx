import { PurchasesView } from "@/components/purchases/purchases-view";
import { getPurchasesData } from "@/server/purchases";

// Данные из БД — рендер на запрос.
export const dynamic = "force-dynamic";

export default async function PurchasesPage() {
  const data = await getPurchasesData();
  return <PurchasesView initialRows={data.rows} items={data.items} />;
}
