-- Verified 1C statement period. Historical rows stay NULL.
-- No default, no backfill, no rewrite of existing bank operations.

CREATE TYPE "StatementSource" AS ENUM ('MANUAL', 'BANK_1C');

ALTER TABLE "Statement" ADD COLUMN "periodStart" TIMESTAMP(3),
ADD COLUMN "periodEnd" TIMESTAMP(3),
ADD COLUMN "source" "StatementSource",
ADD COLUMN "contentKey" TEXT;

CREATE UNIQUE INDEX "Statement_accountId_contentKey_key"
  ON "Statement"("accountId", "contentKey");

ALTER TABLE "Statement" ADD CONSTRAINT "Statement_verified_period_check" CHECK (
  "source" IS DISTINCT FROM 'BANK_1C'
  OR (
    "periodStart" IS NOT NULL
    AND "periodEnd" IS NOT NULL
    AND "periodStart" <= "periodEnd"
  )
);
