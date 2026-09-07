import type { NomenclatureType } from "@/types/domain";
import type { TerminalProduct } from "@/components/terminal/types";

export type UpakovkaShortageKind = "detail" | "fastener" | "packaging" | "extra";

export interface UpakovkaShortage {
  name: string;
  kind: UpakovkaShortageKind;
  required: number;
  available: number;
  shortage: number;
}

export interface UpakovkaAvailability {
  canAssemble: number;
  shortages: UpakovkaShortage[];
}

export interface UpakovkaStockView {
  detailsReady: Record<string, number>;
  nomenclature: Record<string, number>;
}

export interface UpakovkaNameLookup {
  details: Record<string, string>;
  nomenclature: Record<string, { name: string; type: NomenclatureType }>;
}

/**
 * Display kind for an aggregated nomenclatureId. Quantity uses the summed
 * demand only; this mapping does not affect canAssemble.
 * FASTENER → fastener, PACKAGING → packaging, otherwise extra.
 */
function nomenclatureKindFromType(type: NomenclatureType | undefined): UpakovkaShortageKind {
  if (type === "FASTENER") return "fastener";
  if (type === "PACKAGING") return "packaging";
  return "extra";
}

interface DemandLine {
  name: string;
  kind: UpakovkaShortageKind;
  required: number;
  available: number;
}

function addDemand(
  byKey: Map<string, DemandLine>,
  key: string,
  qty: number,
  name: string,
  kind: UpakovkaShortageKind,
  available: number,
) {
  if (qty <= 0) return;
  const existing = byKey.get(key);
  if (existing) {
    existing.required += qty;
    return;
  }
  byKey.set(key, { name, kind, required: qty, available });
}

/**
 * Feasibility for one product: floor(stock / SUM of BOM qty on that physical
 * key). Sequential applyUpakovkaPrepared decrements of the same id are that sum.
 */
export function upakovkaAvailability(
  product: Pick<TerminalProduct, "details" | "fastenerIds" | "packagingId" | "extraIds">,
  stock: UpakovkaStockView,
  names: UpakovkaNameLookup,
): UpakovkaAvailability {
  const details = new Map<string, DemandLine>();
  const nomenclature = new Map<string, DemandLine>();

  for (const d of product.details) {
    addDemand(
      details,
      d.detailId,
      d.quantity,
      names.details[d.detailId] ?? d.detailId,
      "detail",
      stock.detailsReady[d.detailId] ?? 0,
    );
  }
  for (const f of product.fastenerIds) {
    const nom = names.nomenclature[f.nomenclatureId];
    addDemand(
      nomenclature,
      f.nomenclatureId,
      f.quantity,
      nom?.name ?? f.nomenclatureId,
      nomenclatureKindFromType(nom?.type),
      stock.nomenclature[f.nomenclatureId] ?? 0,
    );
  }
  if (product.packagingId) {
    const nom = names.nomenclature[product.packagingId];
    addDemand(
      nomenclature,
      product.packagingId,
      1,
      nom?.name ?? product.packagingId,
      nomenclatureKindFromType(nom?.type),
      stock.nomenclature[product.packagingId] ?? 0,
    );
  }
  for (const nomenclatureId of product.extraIds) {
    const nom = names.nomenclature[nomenclatureId];
    addDemand(
      nomenclature,
      nomenclatureId,
      1,
      nom?.name ?? nomenclatureId,
      nomenclatureKindFromType(nom?.type),
      stock.nomenclature[nomenclatureId] ?? 0,
    );
  }

  const lines = [...details.values(), ...nomenclature.values()];
  const limits = lines.map((line) => Math.floor(line.available / line.required));
  const canAssemble = limits.length ? Math.max(0, Math.min(...limits)) : 0;
  const shortages: UpakovkaShortage[] =
    canAssemble > 0
      ? []
      : lines
          .filter((line) => line.available < line.required)
          .map((line) => ({
            ...line,
            shortage: line.required - line.available,
          }));

  return { canAssemble, shortages };
}
