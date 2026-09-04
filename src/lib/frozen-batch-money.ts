import { D } from "@/lib/cost";

export interface BatchMoneyFields {
  purchaseCost: number;
  priceSort1: number;
  priceSort2: number;
}

export interface FrozenBatchCostInputFields extends BatchMoneyFields {
  sectionWidthMm: number;
  sectionHeightMm: number;
  materialId: string;
}

function money(value: number): string {
  return D(value).toFixed(2);
}

function section(value: number): string {
  return D(value).toFixed(2);
}

/** true if a frozen batch's purchaseCost / sort prices would change. */
export function frozenBatchMoneyChanged(stored: BatchMoneyFields, next: BatchMoneyFields): boolean {
  return (
    money(stored.purchaseCost) !== money(next.purchaseCost) ||
    money(stored.priceSort1) !== money(next.priceSort1) ||
    money(stored.priceSort2) !== money(next.priceSort2)
  );
}

/** true if any BD-3 cost input would change on a frozen batch. */
export function frozenBatchCostInputsChanged(
  stored: FrozenBatchCostInputFields,
  next: FrozenBatchCostInputFields,
): boolean {
  return (
    frozenBatchMoneyChanged(stored, next) ||
    section(stored.sectionWidthMm) !== section(next.sectionWidthMm) ||
    section(stored.sectionHeightMm) !== section(next.sectionHeightMm) ||
    stored.materialId !== next.materialId
  );
}
