-- Провенанс списания со склада для точной обратной разноски при правке/
-- удалении операций ПРИСАДКА и УПАКОВКА (cost-integrity).
ALTER TABLE "OperationDetailLine" ADD COLUMN "sourceTorcevayaDone" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OperationDetailLine" ADD COLUMN "sourcePloskostDone" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "OperationNomenclatureLine" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "nomenclatureId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "OperationNomenclatureLine_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OperationNomenclatureLine" ADD CONSTRAINT "OperationNomenclatureLine_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "ProductionOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
