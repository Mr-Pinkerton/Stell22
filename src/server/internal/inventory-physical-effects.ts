// PSR-P2 R-06: derived physical effect plan for Inventory conduct.
// Pure/internal. Not a DB model. Not InventoryMovement. Not a retained event table.
// Future dual-write may use Inventory.id + this physical target grain; effectKey
// string is NOT frozen here.

import { isNoPrisadkaDetail, isReady } from "@/lib/detail-stock";
import type { RailType, Sort } from "@/types/domain";

export const DUPLICATE_INVENTORY_PHYSICAL_TARGET = "DUPLICATE_INVENTORY_PHYSICAL_TARGET";
export const UNKNOWN_INVENTORY_REF_TYPE = "UNKNOWN_INVENTORY_REF_TYPE";
export const BLANK_STOCK_NOT_FOUND = "Заготовка не найдена";
export const DETAIL_NOT_FOUND = "Деталь не найдена";

export type BlankPhysicalTarget = {
  materialId: string;
  lengthM: number;
  detailType: RailType;
  sort: Sort;
};

export type DetailPhysicalTarget = {
  detailId: string;
  torcevayaDone: boolean;
  ploskostDone: boolean;
};

export type ProductPhysicalTarget = { productId: string };
export type NomenclaturePhysicalTarget = { nomenclatureId: string };

export type InventoryPhysicalEffect =
  | {
      inventoryLineId: string;
      stockDomain: "BLANK";
      physicalTarget: BlankPhysicalTarget;
      beforeQty: number;
      afterQty: number;
      quantityDelta: number;
    }
  | {
      inventoryLineId: string;
      stockDomain: "DETAIL";
      physicalTarget: DetailPhysicalTarget;
      beforeQty: number;
      afterQty: number;
      quantityDelta: number;
    }
  | {
      inventoryLineId: string;
      stockDomain: "PRODUCT";
      physicalTarget: ProductPhysicalTarget;
      beforeQty: number;
      afterQty: number;
      quantityDelta: number;
    }
  | {
      inventoryLineId: string;
      stockDomain: "NOMENCLATURE";
      physicalTarget: NomenclaturePhysicalTarget;
      beforeQty: number;
      afterQty: number;
      quantityDelta: number;
    };

export type InventoryPlanLine = {
  id: string;
  refType: string;
  refId: string;
  accountedQty: number;
  actualQty: number;
};

export type BlankPoolState = BlankPhysicalTarget & {
  id: string;
  quantity: number;
};

export type DetailCatalogState = {
  id: string;
  prisadkaTorcevaya: boolean;
  prisadkaPloskost: boolean;
};

export type DetailBucketState = {
  torcevayaDone: boolean;
  ploskostDone: boolean;
  quantity: number;
};

export type InventoryPhysicalPlanInput = {
  lines: InventoryPlanLine[];
  blanksById: Map<string, BlankPoolState>;
  detailsById: Map<string, DetailCatalogState>;
  detailBucketsByDetailId: Map<string, DetailBucketState[]>;
  productQtyById: Map<string, number>;
  nomenclatureQtyById: Map<string, number>;
};

export function blankPhysicalTargetKey(target: BlankPhysicalTarget): string {
  return `BLANK:${target.materialId}|${target.lengthM.toFixed(4)}|${target.detailType}|${target.sort}`;
}

export function detailPhysicalTargetKey(target: DetailPhysicalTarget): string {
  return `DETAIL:${target.detailId}|${target.torcevayaDone}|${target.ploskostDone}`;
}

export function physicalTargetKey(effect: InventoryPhysicalEffect): string {
  if (effect.stockDomain === "BLANK") return blankPhysicalTargetKey(effect.physicalTarget);
  if (effect.stockDomain === "DETAIL") return detailPhysicalTargetKey(effect.physicalTarget);
  if (effect.stockDomain === "PRODUCT") return `PRODUCT:${effect.physicalTarget.productId}`;
  return `NOMENCLATURE:${effect.physicalTarget.nomenclatureId}`;
}

export function assertUniquePhysicalTargets(effects: InventoryPhysicalEffect[]): void {
  const seen = new Set<string>();
  for (const effect of effects) {
    const key = physicalTargetKey(effect);
    if (seen.has(key)) throw new Error(DUPLICATE_INVENTORY_PHYSICAL_TARGET);
    seen.add(key);
  }
}

function effect(
  base: Omit<InventoryPhysicalEffect, "quantityDelta">,
): InventoryPhysicalEffect {
  return { ...base, quantityDelta: base.afterQty - base.beforeQty } as InventoryPhysicalEffect;
}

/**
 * Deterministic physical projection plan for one Inventory document.
 * Same locked pre-state + same lines → same effects, independent of line order.
 * Zero-delta ready/pool effects stay in the plan; future movements omit them.
 */
export function planInventoryPhysicalEffects(
  input: InventoryPhysicalPlanInput,
): InventoryPhysicalEffect[] {
  const effects: InventoryPhysicalEffect[] = [];
  for (const line of input.lines) {
    if (line.refType === "PRODUCT") {
      effects.push(
        effect({
          inventoryLineId: line.id,
          stockDomain: "PRODUCT",
          physicalTarget: { productId: line.refId },
          beforeQty: input.productQtyById.get(line.refId) ?? 0,
          afterQty: line.actualQty,
        }),
      );
      continue;
    }
    if (line.refType === "NOMENCLATURE") {
      effects.push(
        effect({
          inventoryLineId: line.id,
          stockDomain: "NOMENCLATURE",
          physicalTarget: { nomenclatureId: line.refId },
          beforeQty: input.nomenclatureQtyById.get(line.refId) ?? 0,
          afterQty: line.actualQty,
        }),
      );
      continue;
    }
    if (line.refType === "BLANK") {
      const blank = input.blanksById.get(line.refId);
      if (!blank) throw new Error(BLANK_STOCK_NOT_FOUND);
      effects.push(
        effect({
          inventoryLineId: line.id,
          stockDomain: "BLANK",
          physicalTarget: {
            materialId: blank.materialId,
            lengthM: blank.lengthM,
            detailType: blank.detailType,
            sort: blank.sort,
          },
          beforeQty: blank.quantity,
          afterQty: line.actualQty,
        }),
      );
      continue;
    }
    if (line.refType === "DETAIL") {
      const detail = input.detailsById.get(line.refId);
      if (!detail) throw new Error(DETAIL_NOT_FOUND);
      if (isNoPrisadkaDetail(detail)) {
        throw new Error("LEGACY_INVENTORY_DRAFT_RECREATE");
      }
      const buckets = input.detailBucketsByDetailId.get(line.refId) ?? [];
      const canon: DetailPhysicalTarget = {
        detailId: line.refId,
        torcevayaDone: detail.prisadkaTorcevaya,
        ploskostDone: detail.prisadkaPloskost,
      };
      const qtyOf = (t: boolean, p: boolean) =>
        buckets.find((b) => b.torcevayaDone === t && b.ploskostDone === p)?.quantity ?? 0;
      effects.push(
        effect({
          inventoryLineId: line.id,
          stockDomain: "DETAIL",
          physicalTarget: canon,
          beforeQty: qtyOf(canon.torcevayaDone, canon.ploskostDone),
          afterQty: line.actualQty,
        }),
      );
      const seen = new Set([`${canon.torcevayaDone}|${canon.ploskostDone}`]);
      const others = buckets
        .filter((b) => isReady(detail, b.torcevayaDone, b.ploskostDone))
        .map((b) => ({
          ...b,
          key: `${b.torcevayaDone}|${b.ploskostDone}`,
        }))
        .filter((b) => {
          if (seen.has(b.key)) return false;
          seen.add(b.key);
          return true;
        })
        .sort((a, b) => a.key.localeCompare(b.key));
      for (const b of others) {
        effects.push(
          effect({
            inventoryLineId: line.id,
            stockDomain: "DETAIL",
            physicalTarget: {
              detailId: line.refId,
              torcevayaDone: b.torcevayaDone,
              ploskostDone: b.ploskostDone,
            },
            beforeQty: b.quantity,
            afterQty: 0,
          }),
        );
      }
      continue;
    }
    throw new Error(UNKNOWN_INVENTORY_REF_TYPE);
  }
  assertUniquePhysicalTargets(effects);
  return effects;
}
