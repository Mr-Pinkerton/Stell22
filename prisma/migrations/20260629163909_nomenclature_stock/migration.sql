-- CreateTable
CREATE TABLE "NomenclatureStock" (
    "id" TEXT NOT NULL,
    "nomenclatureId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NomenclatureStock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NomenclatureStock_nomenclatureId_key" ON "NomenclatureStock"("nomenclatureId");

-- AddForeignKey
ALTER TABLE "NomenclatureStock" ADD CONSTRAINT "NomenclatureStock_nomenclatureId_fkey" FOREIGN KEY ("nomenclatureId") REFERENCES "NomenclatureItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
