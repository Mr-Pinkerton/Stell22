-- Package 1 correction: additive CHECKs + ProductCost.materialTotal.
-- Does NOT modify 20260907211500_cost_flow_foundation.
-- COST FLOW STILL NOT ACTIVE. No backfill, no DROP, no seed.

-- Target factual month wood is Decimal(18,6). Legacy ProductCost.material (14,2) stays unused by closeMonth.
ALTER TABLE "ProductCost" ADD COLUMN "materialTotal" DECIMAL(18,6);

-- ---------------------------------------------------------------------------
-- WAC pools: costVersion >= 0; v=0 ⇒ all money NULL; v>0 ⇒ NOT NULL, >=0,
-- totalValue = Σ components; qty=0 ⇒ all zeros (STOCK-002). Zero-cost qty>0 allowed.
-- Prisma cannot express CHECKs.
-- ---------------------------------------------------------------------------

ALTER TABLE "BlankStock"
  ADD CONSTRAINT "BlankStock_costVersion_nonneg"
    CHECK ("costVersion" >= 0),
  ADD CONSTRAINT "BlankStock_cost_flow_state" CHECK (
    (
      "costVersion" = 0
      AND "materialValue" IS NULL
      AND "laborValue" IS NULL
      AND "totalValue" IS NULL
    )
    OR (
      "costVersion" > 0
      AND "materialValue" IS NOT NULL
      AND "laborValue" IS NOT NULL
      AND "totalValue" IS NOT NULL
      AND "materialValue" >= 0
      AND "laborValue" >= 0
      AND "totalValue" = "materialValue" + "laborValue"
      AND (
        "quantity" <> 0
        OR (
          "materialValue" = 0
          AND "laborValue" = 0
          AND "totalValue" = 0
        )
      )
    )
  );

ALTER TABLE "DetailStock"
  ADD CONSTRAINT "DetailStock_costVersion_nonneg"
    CHECK ("costVersion" >= 0),
  ADD CONSTRAINT "DetailStock_cost_flow_state" CHECK (
    (
      "costVersion" = 0
      AND "materialValue" IS NULL
      AND "laborValue" IS NULL
      AND "totalValue" IS NULL
    )
    OR (
      "costVersion" > 0
      AND "materialValue" IS NOT NULL
      AND "laborValue" IS NOT NULL
      AND "totalValue" IS NOT NULL
      AND "materialValue" >= 0
      AND "laborValue" >= 0
      AND "totalValue" = "materialValue" + "laborValue"
      AND (
        "quantity" <> 0
        OR (
          "materialValue" = 0
          AND "laborValue" = 0
          AND "totalValue" = 0
        )
      )
    )
  );

ALTER TABLE "NomenclatureStock"
  ADD CONSTRAINT "NomenclatureStock_costVersion_nonneg"
    CHECK ("costVersion" >= 0),
  ADD CONSTRAINT "NomenclatureStock_cost_flow_state" CHECK (
    (
      "costVersion" = 0
      AND "nomenclatureValue" IS NULL
      AND "totalValue" IS NULL
    )
    OR (
      "costVersion" > 0
      AND "nomenclatureValue" IS NOT NULL
      AND "totalValue" IS NOT NULL
      AND "nomenclatureValue" >= 0
      AND "totalValue" = "nomenclatureValue"
      AND (
        "quantity" <> 0
        OR (
          "nomenclatureValue" = 0
          AND "totalValue" = 0
        )
      )
    )
  );

ALTER TABLE "ProductStock"
  ADD CONSTRAINT "ProductStock_costVersion_nonneg"
    CHECK ("costVersion" >= 0),
  ADD CONSTRAINT "ProductStock_cost_flow_state" CHECK (
    (
      "costVersion" = 0
      AND "materialValue" IS NULL
      AND "laborValue" IS NULL
      AND "nomenclatureValue" IS NULL
      AND "totalValue" IS NULL
    )
    OR (
      "costVersion" > 0
      AND "materialValue" IS NOT NULL
      AND "laborValue" IS NOT NULL
      AND "nomenclatureValue" IS NOT NULL
      AND "totalValue" IS NOT NULL
      AND "materialValue" >= 0
      AND "laborValue" >= 0
      AND "nomenclatureValue" >= 0
      AND "totalValue" = "materialValue" + "laborValue" + "nomenclatureValue"
      AND (
        "quantity" <> 0
        OR (
          "materialValue" = 0
          AND "laborValue" = 0
          AND "nomenclatureValue" = 0
          AND "totalValue" = 0
        )
      )
    )
  );

-- EVENT-001: signed components allowed; total must equal the sum.
ALTER TABLE "CostEvent"
  ADD CONSTRAINT "CostEvent_total_eq_components" CHECK (
    "totalValue" = "materialValue" + "laborValue" + "nomenclatureValue"
  );

-- One accounting month: start is month-truncated; end is exclusive next month.
-- TIMESTAMP without time zone (Prisma DateTime).
ALTER TABLE "CostPeriod"
  ADD CONSTRAINT "CostPeriod_periodStart_month_start" CHECK (
    "periodStart" = date_trunc('month', "periodStart")
  ),
  ADD CONSTRAINT "CostPeriod_periodEnd_exclusive_next_month" CHECK (
    "periodEnd" = "periodStart" + INTERVAL '1 month'
  );
