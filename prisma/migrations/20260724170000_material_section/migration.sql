-- Сечение становится частью идентичности материала (Хвоя 40×20 ≠ Хвоя 25×50).
-- Причина: остатки заготовок/деталей и цена за м³ несопоставимы между сечениями;
-- раньше один материал мог иметь партии разных сечений → блендинг и путаница.

-- 1) Новые поля сечения на материале (nullable на время бэкфилла).
ALTER TABLE "Material" ADD COLUMN "sectionWidthMm"  DECIMAL(8,2);
ALTER TABLE "Material" ADD COLUMN "sectionHeightMm" DECIMAL(8,2);

-- 2) Бэкфилл: материалам с ЕДИНСТВЕННЫМ сечением среди их партий проставляем его.
--    Материалы с несколькими сечениями (конфликт) и без партий остаются NULL —
--    сечение задаётся вручную/расщеплением (см. scripts/probe-material-sections.ts).
UPDATE "Material" m
SET "sectionWidthMm" = s."w", "sectionHeightMm" = s."h"
FROM (
  SELECT "materialId",
         MIN("sectionWidthMm")  AS "w",
         MIN("sectionHeightMm") AS "h"
  FROM "Batch"
  GROUP BY "materialId"
  HAVING COUNT(DISTINCT ("sectionWidthMm", "sectionHeightMm")) = 1
) s
WHERE m."id" = s."materialId";

-- 3) Уникальность материала теперь по (название + сечение), а не только по названию.
DROP INDEX "Material_name_key";
CREATE UNIQUE INDEX "Material_name_sectionWidthMm_sectionHeightMm_key"
  ON "Material"("name", "sectionWidthMm", "sectionHeightMm");
