import { D } from "@/lib/cost";

export interface BatchMoneyFields {
  purchaseCost: number;
  priceSort1: number;
  priceSort2: number;
}

function money(value: number): string {
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
