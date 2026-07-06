import {
  details,
  nomenclatureItems,
  products,
  stockSnapshot,
} from "@/mocks/fixtures";
import { productStock } from "@/mocks/warehouse-fixtures";
import { formatProductSku } from "@/lib/format";
import type { NomenclatureType, StockSnapshot } from "@/types/domain";

export interface ProductionStockRow {
  id: string;
  name: string;
  quantity: number;
  subtitle?: string;
  minStock?: number;
  sku?: string;
}

export interface DetailStockRow extends ProductionStockRow {
  ready: number;
  pendingPrisadka: number;
}

export function inventoryDeviation(accountedQty: number, actualQty: number): number {
  return actualQty - accountedQty;
}

/** Сумма отклонения (материал + ЗП — в прототипе unitCost × отклонение). */
export function inventoryDeviationSum(deviation: number, unitCost: number): number {
  return Math.round(deviation * unitCost * 100) / 100;
}

export function buildProductStockRows(
  stock: Record<string, number> = productStock,
): ProductionStockRow[] {
  return products
    .filter((p) => p.status === "ACTIVE")
    .map((p) => ({
      id: p.id,
      name: p.name,
      sku: formatProductSku(p.skuOzon, p.skuWb),
      quantity: stock[p.id] ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

export function buildDetailStockRows(
  snapshot: StockSnapshot = stockSnapshot,
): DetailStockRow[] {
  const ids = new Set([
    ...Object.keys(snapshot.detailsReady),
    ...Object.keys(snapshot.prisadkaPending),
  ]);

  const rows: DetailStockRow[] = [];

  for (const id of ids) {
    const detail = details.find((d) => d.id === id);
    if (!detail || detail.status !== "ACTIVE") continue;

    const ready = snapshot.detailsReady[id] ?? 0;
    const pending = snapshot.prisadkaPending[id];
    const pendingPrisadka = (pending?.torcev ?? 0) + (pending?.plosk ?? 0);

    rows.push({
      id,
      name: detail.name,
      quantity: ready + pendingPrisadka,
      ready,
      pendingPrisadka,
      subtitle:
        pendingPrisadka > 0
          ? `готово ${ready}, на присадке ${pendingPrisadka}`
          : undefined,
    });
  }

  return rows.sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

export function buildNomenclatureStockRows(
  type: NomenclatureType,
  snapshot: StockSnapshot = stockSnapshot,
): ProductionStockRow[] {
  return nomenclatureItems
    .filter((n) => n.type === type && n.status === "ACTIVE")
    .map((n) => ({
      id: n.id,
      name: n.name,
      quantity: snapshot.nomenclature[n.id] ?? 0,
      minStock: n.minStock ?? undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
