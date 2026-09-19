import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { PreparedUpakovkaApply } from "@/server/internal/inventory-integrity";
import { planUpakovkaPhysicalLockSet } from "@/server/internal/upakovka-lock-plan";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function prepared(
  productId: string,
  overrides: Partial<PreparedUpakovkaApply> = {},
): PreparedUpakovkaApply {
  return {
    productId,
    details: [
      {
        detailId: "det-blank",
        quantity: 2,
        materialId: "mat-z",
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
      {
        detailId: "det-ready",
        quantity: 1,
        materialId: "mat-z",
        lengthM: new Prisma.Decimal("0.8000"),
        detailType: "KANAVKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    ],
    fasteners: [{ nomenclatureId: "nom-b", quantity: 4 }],
    packagingId: "nom-pack",
    extras: [{ nomenclatureId: "nom-a" }],
    ...overrides,
  };
}

describe("planUpakovkaPhysicalLockSet", () => {
  it("is independent of incoming product pick order", () => {
    const a = { pick: { productId: "prod-b", quantity: 1 }, prepared: prepared("prod-b") };
    const b = {
      pick: { productId: "prod-a", quantity: 2 },
      prepared: prepared("prod-a", {
        fasteners: [{ nomenclatureId: "nom-a", quantity: 1 }],
        packagingId: "nom-pack",
        extras: [{ nomenclatureId: "nom-c" }],
        details: [
          {
            detailId: "det-other",
            quantity: 1,
            materialId: "mat-y",
            lengthM: new Prisma.Decimal("1.2000"),
            detailType: "POLKA",
            sort: "SORT2",
            prisadkaTorcevaya: false,
            prisadkaPloskost: false,
          },
        ],
      }),
    };
    const forward = planUpakovkaPhysicalLockSet([a, b]);
    const reversed = planUpakovkaPhysicalLockSet([b, a]);
    expect(reversed).toEqual(forward);
    expect(forward.productIds).toEqual(["prod-a", "prod-b"]);
    expect(forward.detailIds).toEqual(["det-blank", "det-other", "det-ready"]);
    expect(forward.nomenclatureIds).toEqual(["nom-a", "nom-b", "nom-c", "nom-pack"]);
    expect(forward.blankSpecs.map((spec) => spec.materialId)).toEqual(["mat-y", "mat-z"]);
  });

  it("does not use lockBlankSpecs on the ACTIVE path", () => {
    const src = readFileSync(path.join(root, "src/server/internal/upakovka-lock-plan.ts"), "utf8");
    expect(src).toContain("lockExistingActiveBlankPools");
    expect(src).toContain("ensureAndLockActiveProductPools");
    expect(src).toContain("lockExistingActiveNomPools");
    expect(src).toContain("if (options.costFlowActive)");
    const activeStart = src.indexOf("if (options.costFlowActive)");
    const activeReturn = src.indexOf("return;", activeStart);
    const activeBlock = src.slice(activeStart, activeReturn);
    expect(activeBlock).toContain("lockExistingActiveBlankPools");
    expect(activeBlock).not.toContain("lockBlankSpecs");
    expect(activeBlock).not.toContain("lockNomenclatureIds");
    expect(activeBlock).not.toContain("lockProductIds");
  });
});
