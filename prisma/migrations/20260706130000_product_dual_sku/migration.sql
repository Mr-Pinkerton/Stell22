-- Раздельные артикулы маркетплейсов у изделия (Ozon и WB различаются).
ALTER TABLE "Product" ADD COLUMN "skuOzon" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN "skuWb" TEXT NOT NULL DEFAULT '';

-- Бэкфилл из прежнего единого артикула (значения совпадут — далее правятся вручную).
UPDATE "Product" SET "skuOzon" = "sku", "skuWb" = "sku";

ALTER TABLE "Product" ALTER COLUMN "skuOzon" DROP DEFAULT;
ALTER TABLE "Product" ALTER COLUMN "skuWb" DROP DEFAULT;

ALTER TABLE "Product" DROP COLUMN "sku";
