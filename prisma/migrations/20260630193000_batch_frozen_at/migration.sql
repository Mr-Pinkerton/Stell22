-- Разделяем «выработана» (closedAt) и «себестоимость заморожена» (frozenAt).
ALTER TABLE "Batch" ADD COLUMN "frozenAt" TIMESTAMP(3);

-- Ранее закрытые партии (closedAt) были заморожены по старой логике
-- (снапшот FINAL) — сохраняем их статус заморозки.
UPDATE "Batch" SET "frozenAt" = "closedAt" WHERE "closedAt" IS NOT NULL;
