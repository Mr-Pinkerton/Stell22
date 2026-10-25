import { D } from "@/lib/cost";
import type { RailType, Sort } from "@/types/domain";

export const STALE_PACKAGE_EDIT =
  "Состав партии уже изменился. Обновите страницу и повторите правку.";
export const PACKAGE_EDIT_REASON_REQUIRED = "Укажите причину исправления";
export const PACKAGE_QUANTITY_BELOW_CONSUMED =
  "Нельзя уменьшить количество ниже уже израсходованного. Израсходованные рейки остаются в учёте.";
export const PACKAGE_IDENTITY_AFTER_USE =
  "Нельзя менять длину, тип или сорт пакета: по нему уже есть расход или операции терминала.";
export const PACKAGE_STRUCTURE_WHILE_FROZEN =
  "Нельзя менять состав пакетов у замороженной партии: себестоимость заморожена.";
export const PACKAGE_REALLOCATE_BLOCKED =
  "Нельзя добавить, удалить или пересчитать другие пакеты: стоимость сырья уже ушла в производство. У начатого пакета можно изменить только остаток (не ниже расхода) и ряды/слои.";
export const PACKAGE_DELETE_BLOCKED =
  "Нельзя удалить пакет: по нему уже есть расход или история операций.";
export const PACKAGE_UNKNOWN = "Пакет не принадлежит этой партии.";
export const PACKAGE_BALANCE_BROKEN =
  "Остаток пакета больше исходного количества. Правка заблокирована.";

export type PackageLotSnapshot = {
  id: string;
  lengthM: string;
  railType: RailType;
  sort: Sort;
  isPackage: boolean;
  quantity: number;
  remainingQuantity: number;
  rows: number | null;
  layers: number | null;
  /** Any terminal operation, including annulled, still references the lot. */
  operationCount: number;
  /** Operations still in active accounting. */
  activeOperationCount: number;
};

export type PackageLotDraft = {
  id?: string | null;
  mode: "package" | "piece";
  lengthM: number;
  railType: RailType;
  sort: Sort;
  quantity: number;
  rows?: number | null;
  layers?: number | null;
};

export type PackageLotUpdate = {
  id: string;
  lengthM: string;
  railType: RailType;
  sort: Sort;
  isPackage: boolean;
  quantity: number;
  remainingQuantity: number;
  rows: number | null;
  layers: number | null;
  /** Consumed rails keep their monetary opening. Remaining count changes around them. */
  preserveMoney: boolean;
};

export type PackageEditPlan = {
  updates: PackageLotUpdate[];
  deletes: string[];
  creates: PackageLotDraft[];
  reallocate: boolean;
};

export function canonicalPackageLength(value: number | string): string {
  const dec = D(value);
  if (!dec.isFinite() || dec.lte(0)) {
    throw new Error("Укажите длину рейки больше нуля");
  }
  return dec.toFixed(4);
}

export function canonicalPackageEditReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error(PACKAGE_EDIT_REASON_REQUIRED);
  if (trimmed.length > 500) throw new Error("Причина слишком длинная");
  return trimmed;
}

export function packageSetFingerprint(
  lots: Array<
    Pick<PackageLotSnapshot, "id" | "quantity" | "remainingQuantity" | "lengthM" | "railType" | "sort">
  >,
): string {
  return lots
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((lot) =>
      [
        lot.id,
        lot.quantity,
        lot.remainingQuantity,
        canonicalPackageLength(lot.lengthM),
        lot.railType,
        lot.sort,
      ].join(":"),
    )
    .join("|");
}

function optionalPositiveInt(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Ряды и слои должны быть целыми числами больше нуля");
  }
  return value;
}

function assertPositiveQty(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("Количество реек должно быть целым числом больше нуля");
  }
}

function isNewDraftId(id: string | null | undefined): boolean {
  const trimmed = id?.trim() ?? "";
  return trimmed.length === 0 || trimmed.startsWith("draft-");
}

/**
 * Full desired package set. Does not write stock.
 * Untouched lots can change identity; the caller reallocates money only when
 * nothing in the batch is consumed. A started lot keeps consumed quantity and
 * its monetary opening; remaining is `newQuantity - consumed`.
 */
export function planBatchPackageEdit(input: {
  frozen: boolean;
  costFlowActive: boolean;
  lots: PackageLotSnapshot[];
  drafts: PackageLotDraft[];
}): PackageEditPlan {
  const anyConsumed = input.lots.some((lot) => lot.remainingQuantity < lot.quantity);
  const byId = new Map(input.lots.map((lot) => [lot.id, lot]));
  const seen = new Set<string>();
  const updates: PackageLotUpdate[] = [];
  const creates: PackageLotDraft[] = [];
  let geometryChanged = false;

  for (const draft of input.drafts) {
    assertPositiveQty(draft.quantity);
    const lengthM = canonicalPackageLength(draft.lengthM);
    const rows = optionalPositiveInt(draft.rows);
    const layers = optionalPositiveInt(draft.layers);
    if (isNewDraftId(draft.id)) {
      if (input.frozen) throw new Error(PACKAGE_STRUCTURE_WHILE_FROZEN);
      if (input.costFlowActive && anyConsumed) throw new Error(PACKAGE_REALLOCATE_BLOCKED);
      creates.push({
        ...draft,
        id: null,
        lengthM: Number(lengthM),
        rows,
        layers,
      });
      geometryChanged = true;
      continue;
    }
    const id = draft.id!.trim();
    if (seen.has(id)) throw new Error(PACKAGE_UNKNOWN);
    seen.add(id);
    const lot = byId.get(id);
    if (!lot) throw new Error(PACKAGE_UNKNOWN);
    const consumed = lot.quantity - lot.remainingQuantity;
    if (consumed < 0) throw new Error(PACKAGE_BALANCE_BROKEN);
    if (draft.quantity < consumed) throw new Error(PACKAGE_QUANTITY_BELOW_CONSUMED);

    const identityChanged =
      canonicalPackageLength(lot.lengthM) !== lengthM ||
      lot.railType !== draft.railType ||
      lot.sort !== draft.sort ||
      lot.isPackage !== (draft.mode === "package");
    const quantityChanged = draft.quantity !== lot.quantity;
    if (identityChanged && (consumed > 0 || lot.operationCount > 0)) {
      throw new Error(PACKAGE_IDENTITY_AFTER_USE);
    }
    if ((identityChanged || quantityChanged) && input.frozen) {
      throw new Error(PACKAGE_STRUCTURE_WHILE_FROZEN);
    }
    if ((identityChanged || quantityChanged) && input.costFlowActive && anyConsumed) {
      if (identityChanged || consumed === 0) throw new Error(PACKAGE_REALLOCATE_BLOCKED);
    }
    if (identityChanged || quantityChanged) geometryChanged = true;
    updates.push({
      id,
      lengthM,
      railType: draft.railType,
      sort: draft.sort,
      isPackage: draft.mode === "package",
      quantity: draft.quantity,
      remainingQuantity: draft.quantity - consumed,
      rows,
      layers,
      preserveMoney: consumed > 0,
    });
  }

  const deletes: string[] = [];
  for (const lot of input.lots) {
    if (seen.has(lot.id)) continue;
    const consumed = lot.quantity - lot.remainingQuantity;
    if (consumed > 0 || lot.operationCount > 0) throw new Error(PACKAGE_DELETE_BLOCKED);
    if (input.frozen) throw new Error(PACKAGE_STRUCTURE_WHILE_FROZEN);
    if (input.costFlowActive && anyConsumed) throw new Error(PACKAGE_REALLOCATE_BLOCKED);
    deletes.push(lot.id);
    geometryChanged = true;
  }

  return {
    updates,
    deletes,
    creates,
    reallocate: geometryChanged && input.costFlowActive && !anyConsumed,
  };
}
