-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "balanceAsOf" TIMESTAMP(3),
ADD COLUMN     "balanceMismatch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Statement" ADD COLUMN     "mismatch" BOOLEAN NOT NULL DEFAULT false;
