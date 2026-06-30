-- AlterTable
ALTER TABLE "AutoRule" ADD COLUMN     "descriptionKeywords" TEXT,
ADD COLUMN     "logicOperator" TEXT NOT NULL DEFAULT 'AND';
