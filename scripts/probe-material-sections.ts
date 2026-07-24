// READ-ONLY проба перед миграцией «сечение → часть материала».
// Показывает по каждому материалу набор сечений его партий. Конфликт = у одного
// материала партии РАЗНЫХ сечений: такой материал нельзя автоматически привязать
// к одному сечению — потребуется ручное расщепление. Ничего не меняет.
//
// Запуск:  tsx scripts/probe-material-sections.ts
import { prisma } from "../src/server/db";

async function main() {
  const materials = await prisma.material.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, status: true },
  });

  const batches = await prisma.batch.findMany({
    select: { materialId: true, sectionWidthMm: true, sectionHeightMm: true },
  });

  const byMaterial = new Map<string, Map<string, number>>();
  for (const b of batches) {
    const key = `${Number(b.sectionWidthMm)}×${Number(b.sectionHeightMm)}`;
    const m = byMaterial.get(b.materialId) ?? new Map<string, number>();
    m.set(key, (m.get(key) ?? 0) + 1);
    byMaterial.set(b.materialId, m);
  }

  let conflicts = 0;
  let noBatches = 0;

  console.log("=== Сечения по материалам ===");
  for (const mat of materials) {
    const sections = byMaterial.get(mat.id);
    if (!sections || sections.size === 0) {
      noBatches += 1;
      console.log(`  [нет партий] ${mat.name} (${mat.status})`);
      continue;
    }
    const parts = [...sections.entries()].map(([s, n]) => `${s} (${n} партий)`);
    if (sections.size > 1) {
      conflicts += 1;
      console.log(`  ⚠ КОНФЛИКТ  ${mat.name}: ${parts.join(", ")}`);
    } else {
      console.log(`  ok          ${mat.name}: ${parts[0]}`);
    }
  }

  console.log("\n=== Итог ===");
  console.log(`  Материалов: ${materials.length}`);
  console.log(`  Без партий (сечение задать вручную): ${noBatches}`);
  console.log(`  КОНФЛИКТОВ (несколько сечений у одного материала): ${conflicts}`);
  if (conflicts === 0) {
    console.log("  → Миграция безопасна: у каждого материала одно сечение.");
  } else {
    console.log("  → Перед миграцией эти материалы нужно расщепить вручную.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
