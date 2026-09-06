-- DI-015: snapshot Employee rates onto ProductionOperation at submit.
-- ACCESS EXCLUSIVE + zero-row recheck (TOCTOU vs preflight).
-- Six nullable Decimal rate columns + required rateSnapshotVersion (no DEFAULT).
-- No UPDATE / DELETE / backfill / DEFAULT 0.
-- Prisma 6 classic PostgreSQL migration.sql is not wrapped automatically.

BEGIN;

LOCK TABLE "ProductionOperation" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  op_count bigint;
BEGIN
  SELECT COUNT(*)
  INTO op_count
  FROM "ProductionOperation";

  IF op_count > 0 THEN
    RAISE EXCEPTION
      'DI-015: ProductionOperation contains % rows; rate snapshots cannot be reconstructed automatically',
      op_count;
  END IF;
END $$;

ALTER TABLE "ProductionOperation"
  ADD COLUMN "hourlyRateSnapshot" numeric(14,2),
  ADD COLUMN "rateTorcovkaSort1Snapshot" numeric(14,2),
  ADD COLUMN "rateTorcovkaSort2Snapshot" numeric(14,2),
  ADD COLUMN "ratePrisadkaTorcevSnapshot" numeric(14,2),
  ADD COLUMN "ratePrisadkaPlosktSnapshot" numeric(14,2),
  ADD COLUMN "rateUpakovkaSnapshot" numeric(14,2),
  ADD COLUMN "rateSnapshotVersion" integer NOT NULL;

COMMIT;
