import { NomenclatureView } from "@/components/nomenclature/nomenclature-view";
import { getNomenclatureData } from "@/server/nomenclature";

// Данные из БД — рендер на запрос.
export const dynamic = "force-dynamic";

export default async function NomenclaturePage() {
  const data = await getNomenclatureData();
  return (
    <NomenclatureView
      initialDetails={data.details}
      initialProducts={data.products}
      initialItems={data.items}
      initialMaterials={data.materials}
    />
  );
}
