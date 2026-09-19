import type { MovementEffect } from "@/server/internal/inventory-movement-identity";
import type { InventoryPhysicalEffect } from "@/server/internal/inventory-physical-effects";

function assertNever(value: never): never {
  throw new Error(`Unsupported Inventory physical stock domain: ${JSON.stringify(value)}`);
}

function physicalEffectToMovementEffect(effect: InventoryPhysicalEffect): MovementEffect {
  switch (effect.stockDomain) {
    case "BLANK":
      return {
        role: "adjust",
        kind: "ADJUSTMENT",
        quantityDelta: effect.quantityDelta,
        target: {
          stockDomain: "BLANK",
          materialId: effect.physicalTarget.materialId,
          lengthM: effect.physicalTarget.lengthM,
          detailType: effect.physicalTarget.detailType,
          sort: effect.physicalTarget.sort,
        },
      };
    case "DETAIL":
      return {
        role: "adjust",
        kind: "ADJUSTMENT",
        quantityDelta: effect.quantityDelta,
        target: {
          stockDomain: "DETAIL",
          detailId: effect.physicalTarget.detailId,
          torcevayaDone: effect.physicalTarget.torcevayaDone,
          ploskostDone: effect.physicalTarget.ploskostDone,
        },
      };
    case "PRODUCT":
      return {
        role: "adjust",
        kind: "ADJUSTMENT",
        quantityDelta: effect.quantityDelta,
        target: { stockDomain: "PRODUCT", productId: effect.physicalTarget.productId },
      };
    case "NOMENCLATURE":
      return {
        role: "adjust",
        kind: "ADJUSTMENT",
        quantityDelta: effect.quantityDelta,
        target: {
          stockDomain: "NOMENCLATURE",
          nomenclatureId: effect.physicalTarget.nomenclatureId,
        },
      };
    default:
      return assertNever(effect);
  }
}

/**
 * Narrow InventoryPhysicalEffect[] → MovementEffect[] mapping.
 * Sole Inventory SHADOW derivation source. Zero-delta rows stay in the
 * mapped list; the common gateway omits quantityDelta=0 inserts.
 * Does not emit RAIL_LOT. Does not net multi-effects of one InventoryLine.
 */
export function inventoryPhysicalEffectsToMovementEffects(
  effects: readonly InventoryPhysicalEffect[],
): MovementEffect[] {
  return effects.map(physicalEffectToMovementEffect);
}
