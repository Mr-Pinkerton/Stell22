-- PSR-P1: empty InventoryMovement SHADOW ledger.
-- Additive only: new enums + empty table + indexes + CHECKs.
-- No writers, no backfill, no INSERT/UPDATE/DELETE of business data.
-- No FK to masters/sources. No self-FK on reversalOfMovementId.
-- One explicit PostgreSQL transaction: Prisma 6 classic migration.sql
-- is not wrapped automatically. No CREATE INDEX CONCURRENTLY.

BEGIN;

-- CreateEnum
CREATE TYPE "InventoryMovementKind" AS ENUM ('OPENING_BALANCE', 'RECEIPT', 'CONSUMPTION', 'PRODUCTION_OUTPUT', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "InventoryStockDomain" AS ENUM ('RAIL_LOT', 'BLANK', 'DETAIL', 'NOMENCLATURE', 'PRODUCT');

-- CreateEnum
CREATE TYPE "InventoryMovementAuthority" AS ENUM ('SHADOW', 'AUTHORITATIVE');

-- CreateEnum
CREATE TYPE "InventoryMovementActorKind" AS ENUM ('USER', 'EMPLOYEE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "InventoryMovementCausationKind" AS ENUM ('PRODUCTION_OPERATION', 'PRODUCTION_OPERATION_MUTATION', 'INVENTORY', 'SIMPLE_PURCHASE', 'BATCH', 'RAIL_LOT', 'SUPPLY', 'MANUAL', 'SYSTEM');

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "kind" "InventoryMovementKind" NOT NULL,
    "stockDomain" "InventoryStockDomain" NOT NULL,
    "quantityDelta" INTEGER NOT NULL,
    "authority" "InventoryMovementAuthority" NOT NULL DEFAULT 'SHADOW',
    "epochId" TEXT,
    "causationKind" "InventoryMovementCausationKind" NOT NULL,
    "causationId" TEXT NOT NULL,
    "effectKey" TEXT NOT NULL,
    "causationSnapshot" JSONB,
    "actorKind" "InventoryMovementActorKind" NOT NULL,
    "userId" TEXT,
    "employeeId" TEXT,
    "systemActorKey" TEXT,
    "actorDisplaySnapshot" TEXT NOT NULL,
    "reason" TEXT,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversalOfMovementId" TEXT,
    "railLotId" TEXT,
    "materialId" TEXT,
    "lengthM" DECIMAL(12,4),
    "detailType" "RailType",
    "sort" "Sort",
    "detailId" TEXT,
    "torcevayaDone" BOOLEAN,
    "ploskostDone" BOOLEAN,
    "nomenclatureId" TEXT,
    "productId" TEXT,
    "targetSnapshot" JSONB NOT NULL,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryMovement_authority_stockDomain_epochId_recordedAt_idx" ON "InventoryMovement"("authority", "stockDomain", "epochId", "recordedAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_recordedAt_idx" ON "InventoryMovement"("recordedAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_effectiveAt_idx" ON "InventoryMovement"("effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_causationKind_causationId_effectKey_key" ON "InventoryMovement"("causationKind", "causationId", "effectKey");

-- Lookup partial indexes (audit/08.05 §5.1)
CREATE INDEX "InventoryMovement_railLotId_recordedAt_idx"
  ON "InventoryMovement" ("railLotId", "recordedAt")
  WHERE "railLotId" IS NOT NULL;

CREATE INDEX "InventoryMovement_blank_pool_recordedAt_idx"
  ON "InventoryMovement" ("materialId", "lengthM", "detailType", "sort", "recordedAt")
  WHERE "stockDomain" = 'BLANK';

CREATE INDEX "InventoryMovement_detail_pool_recordedAt_idx"
  ON "InventoryMovement" ("detailId", "torcevayaDone", "ploskostDone", "recordedAt")
  WHERE "stockDomain" = 'DETAIL';

CREATE INDEX "InventoryMovement_nomenclatureId_recordedAt_idx"
  ON "InventoryMovement" ("nomenclatureId", "recordedAt")
  WHERE "nomenclatureId" IS NOT NULL;

CREATE INDEX "InventoryMovement_productId_recordedAt_idx"
  ON "InventoryMovement" ("productId", "recordedAt")
  WHERE "productId" IS NOT NULL;

CREATE INDEX "InventoryMovement_userId_recordedAt_idx"
  ON "InventoryMovement" ("userId", "recordedAt")
  WHERE "userId" IS NOT NULL;

CREATE INDEX "InventoryMovement_employeeId_recordedAt_idx"
  ON "InventoryMovement" ("employeeId", "recordedAt")
  WHERE "employeeId" IS NOT NULL;

CREATE INDEX "InventoryMovement_reversalOfMovementId_recordedAt_idx"
  ON "InventoryMovement" ("reversalOfMovementId", "recordedAt")
  WHERE "reversalOfMovementId" IS NOT NULL;

-- AUTHORITATIVE OPENING_BALANCE uniqueness (audit/08.05 §5.2)
CREATE UNIQUE INDEX "InventoryMovement_opening_railLot_authoritative_key"
  ON "InventoryMovement" ("epochId", "railLotId")
  WHERE "authority" = 'AUTHORITATIVE'
    AND "kind" = 'OPENING_BALANCE'
    AND "stockDomain" = 'RAIL_LOT';

CREATE UNIQUE INDEX "InventoryMovement_opening_blank_authoritative_key"
  ON "InventoryMovement" ("epochId", "materialId", "lengthM", "detailType", "sort")
  WHERE "authority" = 'AUTHORITATIVE'
    AND "kind" = 'OPENING_BALANCE'
    AND "stockDomain" = 'BLANK';

CREATE UNIQUE INDEX "InventoryMovement_opening_detail_authoritative_key"
  ON "InventoryMovement" ("epochId", "detailId", "torcevayaDone", "ploskostDone")
  WHERE "authority" = 'AUTHORITATIVE'
    AND "kind" = 'OPENING_BALANCE'
    AND "stockDomain" = 'DETAIL';

CREATE UNIQUE INDEX "InventoryMovement_opening_nomenclature_authoritative_key"
  ON "InventoryMovement" ("epochId", "nomenclatureId")
  WHERE "authority" = 'AUTHORITATIVE'
    AND "kind" = 'OPENING_BALANCE'
    AND "stockDomain" = 'NOMENCLATURE';

CREATE UNIQUE INDEX "InventoryMovement_opening_product_authoritative_key"
  ON "InventoryMovement" ("epochId", "productId")
  WHERE "authority" = 'AUTHORITATIVE'
    AND "kind" = 'OPENING_BALANCE'
    AND "stockDomain" = 'PRODUCT';

-- CHECKs (audit/08.05 §6)
ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_quantityDelta_nonzero"
  CHECK ("quantityDelta" <> 0);

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_kind_sign"
  CHECK (
    ("kind" = 'OPENING_BALANCE' AND "quantityDelta" > 0)
    OR ("kind" = 'RECEIPT' AND "quantityDelta" > 0)
    OR ("kind" = 'PRODUCTION_OUTPUT' AND "quantityDelta" > 0)
    OR ("kind" = 'CONSUMPTION' AND "quantityDelta" < 0)
    OR ("kind" = 'ADJUSTMENT' AND "quantityDelta" <> 0)
    OR ("kind" = 'REVERSAL' AND "quantityDelta" <> 0)
  );

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_actor_shape"
  CHECK (
    (
      "actorKind" = 'USER'
      AND "userId" IS NOT NULL AND btrim("userId") <> ''
      AND "employeeId" IS NULL
      AND "systemActorKey" IS NULL
    )
    OR (
      "actorKind" = 'EMPLOYEE'
      AND "employeeId" IS NOT NULL AND btrim("employeeId") <> ''
      AND "userId" IS NULL
      AND "systemActorKey" IS NULL
    )
    OR (
      "actorKind" = 'SYSTEM'
      AND "systemActorKey" IS NOT NULL AND btrim("systemActorKey") <> ''
      AND "userId" IS NULL
      AND "employeeId" IS NULL
    )
  );

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_authority_epoch"
  CHECK (
    ("epochId" IS NULL OR btrim("epochId") <> '')
    AND (
      "authority" <> 'AUTHORITATIVE'
      OR "epochId" IS NOT NULL
    )
  );

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_stock_target_shape"
  CHECK (
    (
      "stockDomain" = 'RAIL_LOT'
      AND "railLotId" IS NOT NULL AND btrim("railLotId") <> ''
      AND "materialId" IS NULL AND "lengthM" IS NULL AND "detailType" IS NULL AND "sort" IS NULL
      AND "detailId" IS NULL AND "torcevayaDone" IS NULL AND "ploskostDone" IS NULL
      AND "nomenclatureId" IS NULL AND "productId" IS NULL
    )
    OR (
      "stockDomain" = 'BLANK'
      AND "materialId" IS NOT NULL AND btrim("materialId") <> ''
      AND "lengthM" IS NOT NULL AND "lengthM" > 0
      AND "detailType" IS NOT NULL
      AND "sort" IS NOT NULL
      AND "railLotId" IS NULL
      AND "detailId" IS NULL AND "torcevayaDone" IS NULL AND "ploskostDone" IS NULL
      AND "nomenclatureId" IS NULL AND "productId" IS NULL
    )
    OR (
      "stockDomain" = 'DETAIL'
      AND "detailId" IS NOT NULL AND btrim("detailId") <> ''
      AND "torcevayaDone" IS NOT NULL
      AND "ploskostDone" IS NOT NULL
      AND "railLotId" IS NULL
      AND "materialId" IS NULL AND "lengthM" IS NULL AND "detailType" IS NULL AND "sort" IS NULL
      AND "nomenclatureId" IS NULL AND "productId" IS NULL
    )
    OR (
      "stockDomain" = 'NOMENCLATURE'
      AND "nomenclatureId" IS NOT NULL AND btrim("nomenclatureId") <> ''
      AND "railLotId" IS NULL
      AND "materialId" IS NULL AND "lengthM" IS NULL AND "detailType" IS NULL AND "sort" IS NULL
      AND "detailId" IS NULL AND "torcevayaDone" IS NULL AND "ploskostDone" IS NULL
      AND "productId" IS NULL
    )
    OR (
      "stockDomain" = 'PRODUCT'
      AND "productId" IS NOT NULL AND btrim("productId") <> ''
      AND "railLotId" IS NULL
      AND "materialId" IS NULL AND "lengthM" IS NULL AND "detailType" IS NULL AND "sort" IS NULL
      AND "detailId" IS NULL AND "torcevayaDone" IS NULL AND "ploskostDone" IS NULL
      AND "nomenclatureId" IS NULL
    )
  );

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_targetSnapshot_object"
  CHECK ("targetSnapshot" IS NOT NULL AND jsonb_typeof("targetSnapshot") = 'object');

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_causationSnapshot_object"
  CHECK (
    "causationSnapshot" IS NULL
    OR jsonb_typeof("causationSnapshot") = 'object'
  );

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_supply_causation_snapshot"
  CHECK (
    "causationKind" <> 'SUPPLY'
    OR (
      "causationSnapshot" IS NOT NULL
      AND jsonb_typeof("causationSnapshot") = 'object'
    )
  );

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_nonblank_required"
  CHECK (
    btrim("causationId") <> ''
    AND btrim("effectKey") <> ''
    AND btrim("actorDisplaySnapshot") <> ''
    AND ("reason" IS NULL OR btrim("reason") <> '')
  );

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_identity_length"
  CHECK (
    char_length(btrim("causationId")) BETWEEN 1 AND 200
    AND char_length(btrim("effectKey")) BETWEEN 1 AND 200
    AND (
      "epochId" IS NULL
      OR char_length(btrim("epochId")) BETWEEN 1 AND 200
    )
  );

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_reversal_shape"
  CHECK (
    (
      "kind" = 'REVERSAL'
      AND "reversalOfMovementId" IS NOT NULL
      AND btrim("reversalOfMovementId") <> ''
      AND "reversalOfMovementId" <> "id"
    )
    OR (
      "kind" <> 'REVERSAL'
      AND "reversalOfMovementId" IS NULL
    )
  );

ALTER TABLE "InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_manual_reason"
  CHECK (
    "causationKind" <> 'MANUAL'
    OR (
      "reason" IS NOT NULL
      AND btrim("reason") <> ''
    )
  );

COMMIT;
