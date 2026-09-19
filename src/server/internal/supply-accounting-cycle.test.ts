import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeSupplyDeduction } from "@/lib/supply-stock";
import {
  evaluateOzonSupplyCancellation,
  hasNewSupplyAccountingDelta,
  isOzonCancelledInThisSync,
  nextSupplyAccountingLifecycle,
  SUPPLY_CAUSATION_KIND,
  supplyConsumeCausalIdentity,
  supplyRestoreCausalIdentity,
} from "./supply-accounting-cycle";

describe("R-04 supply accounting lifecycle", () => {
  it("does not start a cycle when target is already accounted (I1 / I9)", () => {
    expect(hasNewSupplyAccountingDelta(10, 10, 0)).toBe(false);
    expect(hasNewSupplyAccountingDelta(10, 0, 10)).toBe(false);
    expect(hasNewSupplyAccountingDelta(10, 3, 7)).toBe(false);
    expect(
      nextSupplyAccountingLifecycle({
        targetQty: 10,
        deductedQty: 0,
        shortfallQty: 10,
        stockAccountingGeneration: 1,
        stockAccountingOpen: true,
      }),
    ).toEqual({ generation: 1, open: true, accountingDelta: false });
  });

  it("opens generation 1 from cutover 0/false on first accounting delta including full shortfall", () => {
    expect(
      nextSupplyAccountingLifecycle({
        targetQty: 10,
        deductedQty: 0,
        shortfallQty: 0,
        stockAccountingGeneration: 0,
        stockAccountingOpen: false,
      }),
    ).toEqual({ generation: 1, open: true, accountingDelta: true });
    const accounted = computeSupplyDeduction({
      targetQty: 10,
      alreadyDeducted: 0,
      alreadyShort: 0,
      available: 0,
    });
    expect(accounted).toEqual({ toRemove: 0, shortfall: 10, newDeducted: 0, newShort: 10 });
  });

  it("keeps generation on retry of an open cycle (I6 / quantity increase stays gen 1)", () => {
    expect(
      nextSupplyAccountingLifecycle({
        targetQty: 12,
        deductedQty: 10,
        shortfallQty: 0,
        stockAccountingGeneration: 1,
        stockAccountingOpen: true,
      }),
    ).toEqual({ generation: 1, open: true, accountingDelta: true });
  });

  it("increments generation when a closed cycle is SHIPPED again (I5)", () => {
    expect(
      nextSupplyAccountingLifecycle({
        targetQty: 10,
        deductedQty: 0,
        shortfallQty: 0,
        stockAccountingGeneration: 1,
        stockAccountingOpen: false,
      }),
    ).toEqual({ generation: 2, open: true, accountingDelta: true });
  });

  it("preserves one-shot shortfall: same-cycle retry with more stock is not a new delta", () => {
    expect(
      computeSupplyDeduction({
        targetQty: 10,
        alreadyDeducted: 3,
        alreadyShort: 7,
        available: 100,
      }),
    ).toEqual({ toRemove: 0, shortfall: 0, newDeducted: 3, newShort: 7 });
    expect(hasNewSupplyAccountingDelta(10, 3, 7)).toBe(false);
  });
});

describe("R-04 Ozon cancellation decision", () => {
  it("no-ops when no open cycle (I2 duplicate cancel)", () => {
    expect(evaluateOzonSupplyCancellation({ stockAccountingOpen: false, deductedQty: 0 })).toEqual({
      action: "noop",
    });
    expect(evaluateOzonSupplyCancellation({ stockAccountingOpen: false, deductedQty: 5 })).toEqual({
      action: "noop",
    });
  });

  it("closes an open full-shortfall cycle with restore 0 (I3 / I4)", () => {
    expect(evaluateOzonSupplyCancellation({ stockAccountingOpen: true, deductedQty: 0 })).toEqual({
      action: "close",
      restoreQty: 0,
    });
  });

  it("closes an open cycle restoring only deductedQty", () => {
    expect(evaluateOzonSupplyCancellation({ stockAccountingOpen: true, deductedQty: 3 })).toEqual({
      action: "close",
      restoreQty: 3,
    });
  });
});

describe("R-04 same-sync conflict: cancellation wins", () => {
  it("excludes Ozon cancelled external IDs from deduction", () => {
    const cancelled = new Set(["800001", "800002"]);
    expect(isOzonCancelledInThisSync("OZON", "800001", cancelled)).toBe(true);
    expect(isOzonCancelledInThisSync("OZON", "800099", cancelled)).toBe(false);
    expect(isOzonCancelledInThisSync("WB", "800001", cancelled)).toBe(false);
  });
});

describe("R-04 future SUPPLY causal identity (no writer, no effectKey freeze)", () => {
  it("pins consume/restore facts under causationKind SUPPLY and Supply.id (I8 / I10)", () => {
    const consume = supplyConsumeCausalIdentity({
      supplyId: "supply-row-1",
      stockAccountingGeneration: 2,
      accountedQtyAfter: 10,
    });
    expect(consume).toEqual({
      causationKind: SUPPLY_CAUSATION_KIND,
      causationId: "supply-row-1",
      stockAccountingGeneration: 2,
      accountedQtyAfter: 10,
      direction: "CONSUME",
    });
    const restore = supplyRestoreCausalIdentity({
      supplyId: "supply-row-1",
      stockAccountingGeneration: 2,
    });
    expect(restore.direction).toBe("RESTORE");
    expect(restore.causationId).toBe("supply-row-1");
    expect(restore.stockAccountingGeneration).toBe(2);
    expect(JSON.stringify(consume)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe("R-04 marketplace-sync wiring", () => {
  it("locks Ozon cancel rows by identity and excludes cancelled IDs from deduct", () => {
    const syncSrc = fs.readFileSync(
      path.join(process.cwd(), "src/server/internal/marketplace-sync.ts"),
      "utf8",
    );
    const deductSrc = fs.readFileSync(
      path.join(process.cwd(), "src/server/internal/supply-deduct.ts"),
      "utf8",
    );
    expect(syncSrc).toContain("runSupplySyncAccounting");
    expect(deductSrc).toContain("findOzonSupplyKeysByExternalIds");
    expect(deductSrc).toContain("isOzonCancelledInThisSync");
    expect(deductSrc).toContain("applyOzonSupplyCancellation");
    expect(syncSrc).not.toMatch(/deductedQty:\s*\{\s*gt:\s*0\s*\}/);
    expect(deductSrc).not.toMatch(/deductedQty:\s*\{\s*gt:\s*0\s*\}/);
    expect(deductSrc).toMatch(/if \(isOzonCancelledInThisSync[\s\S]*continue/);
    expect(syncSrc).toMatch(/if \(result\.closed\)/);
    expect(syncSrc).not.toMatch(/result\.closed && result\.restored > 0/);
    expect(syncSrc).toMatch(/restored: result\.restored/);
    expect(syncSrc).toMatch(/generation: result\.generation/);
  });
});
