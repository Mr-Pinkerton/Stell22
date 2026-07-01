-- AlterTable
ALTER TABLE "MpStock" DROP COLUMN "inWay",
DROP COLUMN "reserved";

-- AlterTable
ALTER TABLE "Supply" ADD COLUMN     "deductedQty" INTEGER NOT NULL DEFAULT 0;
