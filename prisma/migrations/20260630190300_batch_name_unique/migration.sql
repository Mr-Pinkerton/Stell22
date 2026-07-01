-- Переименовать дубликаты имён (оставляем самую раннюю партию без суффикса).
WITH ranked AS (
  SELECT
    id,
    name,
    ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(name)) ORDER BY "createdAt" ASC, id ASC) AS rn
  FROM "Batch"
)
UPDATE "Batch" AS b
SET name = r.name || ' (' || r.rn || ')'
FROM ranked r
WHERE b.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX "Batch_name_key" ON "Batch"("name");
