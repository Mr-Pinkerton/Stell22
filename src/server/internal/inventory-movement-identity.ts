import { createHash } from "node:crypto";
import type { InventoryMovementKind, InventoryStockDomain } from "@prisma/client";
import { canonicalLengthFixed4 } from "@/server/internal/blank-length";
import type { RailType, Sort } from "@/types/domain";

export const MOVEMENT_EFFECT_ROLES = [
  "receipt",
  "consume",
  "output",
  "adjust",
  "writeoff",
  "restore",
] as const;

export type MovementEffectRole = (typeof MOVEMENT_EFFECT_ROLES)[number];

export type MovementTarget =
  | { stockDomain: "RAIL_LOT"; railLotId: string }
  | {
      stockDomain: "BLANK";
      materialId: string;
      lengthM: number | string | { toString(): string };
      detailType: RailType;
      sort: Sort;
    }
  | {
      stockDomain: "DETAIL";
      detailId: string;
      torcevayaDone: boolean;
      ploskostDone: boolean;
    }
  | { stockDomain: "NOMENCLATURE"; nomenclatureId: string }
  | { stockDomain: "PRODUCT"; productId: string };

export type MovementEffect = {
  role: MovementEffectRole;
  kind: InventoryMovementKind;
  quantityDelta: number;
  target: MovementTarget;
  qualifier?: string;
};

export type CanonicalMovementTarget = {
  stockDomain: InventoryStockDomain;
  targetKeyV1: string;
  targetHashV1: string;
  targetSnapshot: Record<string, unknown>;
  railLotId: string | null;
  materialId: string | null;
  lengthMFixed4: string | null;
  detailType: RailType | null;
  sort: Sort | null;
  detailId: string | null;
  torcevayaDone: boolean | null;
  ploskostDone: boolean | null;
  nomenclatureId: string | null;
  productId: string | null;
};

function compactJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export function targetKeyV1(target: MovementTarget): string {
  switch (target.stockDomain) {
    case "RAIL_LOT":
      return compactJson({ v: 1, d: "RAIL_LOT", railLotId: target.railLotId });
    case "BLANK":
      return compactJson({
        v: 1,
        d: "BLANK",
        materialId: target.materialId,
        lengthM: canonicalLengthFixed4(target.lengthM),
        detailType: target.detailType,
        sort: target.sort,
      });
    case "DETAIL":
      return compactJson({
        v: 1,
        d: "DETAIL",
        detailId: target.detailId,
        torcevayaDone: target.torcevayaDone,
        ploskostDone: target.ploskostDone,
      });
    case "NOMENCLATURE":
      return compactJson({
        v: 1,
        d: "NOMENCLATURE",
        nomenclatureId: target.nomenclatureId,
      });
    case "PRODUCT":
      return compactJson({ v: 1, d: "PRODUCT", productId: target.productId });
  }
}

export function targetHashV1(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function canonicalizeMovementTarget(target: MovementTarget): CanonicalMovementTarget {
  const key = targetKeyV1(target);
  const hash = targetHashV1(key);
  if (target.stockDomain === "RAIL_LOT") {
    return {
      stockDomain: "RAIL_LOT",
      targetKeyV1: key,
      targetHashV1: hash,
      targetSnapshot: { v: 1, d: "RAIL_LOT", railLotId: target.railLotId },
      railLotId: target.railLotId,
      materialId: null,
      lengthMFixed4: null,
      detailType: null,
      sort: null,
      detailId: null,
      torcevayaDone: null,
      ploskostDone: null,
      nomenclatureId: null,
      productId: null,
    };
  }
  if (target.stockDomain === "BLANK") {
    const lengthMFixed4 = canonicalLengthFixed4(target.lengthM);
    return {
      stockDomain: "BLANK",
      targetKeyV1: key,
      targetHashV1: hash,
      targetSnapshot: {
        v: 1,
        d: "BLANK",
        materialId: target.materialId,
        lengthM: lengthMFixed4,
        detailType: target.detailType,
        sort: target.sort,
      },
      railLotId: null,
      materialId: target.materialId,
      lengthMFixed4,
      detailType: target.detailType,
      sort: target.sort,
      detailId: null,
      torcevayaDone: null,
      ploskostDone: null,
      nomenclatureId: null,
      productId: null,
    };
  }
  if (target.stockDomain === "DETAIL") {
    return {
      stockDomain: "DETAIL",
      targetKeyV1: key,
      targetHashV1: hash,
      targetSnapshot: {
        v: 1,
        d: "DETAIL",
        detailId: target.detailId,
        torcevayaDone: target.torcevayaDone,
        ploskostDone: target.ploskostDone,
      },
      railLotId: null,
      materialId: null,
      lengthMFixed4: null,
      detailType: null,
      sort: null,
      detailId: target.detailId,
      torcevayaDone: target.torcevayaDone,
      ploskostDone: target.ploskostDone,
      nomenclatureId: null,
      productId: null,
    };
  }
  if (target.stockDomain === "NOMENCLATURE") {
    return {
      stockDomain: "NOMENCLATURE",
      targetKeyV1: key,
      targetHashV1: hash,
      targetSnapshot: { v: 1, d: "NOMENCLATURE", nomenclatureId: target.nomenclatureId },
      railLotId: null,
      materialId: null,
      lengthMFixed4: null,
      detailType: null,
      sort: null,
      detailId: null,
      torcevayaDone: null,
      ploskostDone: null,
      nomenclatureId: target.nomenclatureId,
      productId: null,
    };
  }
  return {
    stockDomain: "PRODUCT",
    targetKeyV1: key,
    targetHashV1: hash,
    targetSnapshot: { v: 1, d: "PRODUCT", productId: target.productId },
    railLotId: null,
    materialId: null,
    lengthMFixed4: null,
    detailType: null,
    sort: null,
    detailId: null,
    torcevayaDone: null,
    ploskostDone: null,
    nomenclatureId: null,
    productId: target.productId,
  };
}

export function effectKeyV1(
  role: MovementEffectRole,
  targetHash: string,
  qualifier?: string,
): string {
  const base = `imfx1:${role}:${targetHash}`;
  if (qualifier === undefined || qualifier === "") return base;
  return `${base}:${qualifier}`;
}

export function compareEffectKey(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isMovementEffectRole(value: string): value is MovementEffectRole {
  return (MOVEMENT_EFFECT_ROLES as readonly string[]).includes(value);
}
