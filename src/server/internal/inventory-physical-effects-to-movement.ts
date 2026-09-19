import type { MovementEffect } from "@/server/internal/inventory-movement-identity";
import type { InventoryPhysicalEffect } from "@/server/internal/inventory-physical-effects";

/**
 * Narrow InventoryPhysicalEffect[] → MovementEffect[] mapping.
 * Sole Inventory SHADOW derivation source. Zero-delta rows stay in the
 * mapped list; the common gateway omits quantityDelta=0 inserts.
 * Does not emit RAIL_LOT. Does not net multi-effects of one InventoryLine.
 */
export function inventoryPhysicalEffectsToMovementEffects(
  effects: readonly InventoryPhysicalEffect[],
): MovementEffect[] {
  return effects.map((effect) => ({
    role: "adjust",
    kind: "ADJUSTMENT",
    quantityDelta: effect.quantityDelta,
    target:
      effect.stockDomain === "BLANK"
        ? {
            stockDomain: "BLANK",
            materialId: effect.physicalTarget.materialId,
            lengthM: effect.physicalTarget.lengthM,
            detailType: effect.physicalTarget.detailType,
            sort: effect.physicalTarget.sort,
          }
        : effect.stockDomain === "DETAIL"
          ? {
              stockDomain: "DETAIL",
              detailId: effect.physicalTarget.detailId,
              torcevayaDone: effect.physicalTarget.torcevayaDone,
              ploskostDone: effect.physicalTarget.ploskostDone,
            }
          : effect.stockDomain === "PRODUCT"
            ? { stockDomain: "PRODUCT", productId: effect.physicalTarget.productId }
            : {
                stockDomain: "NOMENCLATURE",
                nomenclatureId: effect.physicalTarget.nomenclatureId,
              },
  }));
}
