import type {
  Batch,
  Detail,
  Material,
  Product,
  RailLot,
  StockSnapshot,
} from "@/types/domain";

export type TerminalScreen = "home" | "torcovka" | "prisadka" | "upakovka" | "hours";

export interface TerminalIdentity {
  id: string;
  fullName: string;
}

export interface TerminalEmployee extends TerminalIdentity {
  /** Нужна только для post-auth preview на экране ввода часов. */
  hourlyRate: number | null;
}

export type TerminalBirthday = TerminalIdentity;
export type TerminalMaterial = Pick<
  Material,
  "id" | "name" | "sectionWidthMm" | "sectionHeightMm"
>;
export type TerminalBatch = Pick<
  Batch,
  "id" | "name" | "materialId" | "sectionWidthMm" | "sectionHeightMm" | "status"
>;
export type TerminalRailLot = Pick<
  RailLot,
  | "id"
  | "batchId"
  | "lengthM"
  | "railType"
  | "sort"
  | "isPackage"
  | "code"
  | "remainingQuantity"
>;
export type TerminalDetail = Pick<
  Detail,
  | "id"
  | "name"
  | "materialId"
  | "detailNumber"
  | "lengthM"
  | "detailType"
  | "sort"
  | "prisadkaTorcevaya"
  | "prisadkaPloskost"
  | "status"
>;
export type TerminalProduct = Pick<
  Product,
  | "id"
  | "name"
  | "materialId"
  | "skuOzon"
  | "skuWb"
  | "packagingId"
  | "status"
  | "details"
  | "fastenerIds"
  | "extraIds"
>;
export type TerminalStock = Pick<
  StockSnapshot,
  "prisadkaPending" | "detailsReady" | "nomenclature"
>;

export interface TerminalData {
  currentEmployee: TerminalEmployee;
  birthdaysToday: TerminalBirthday[];
  materials: TerminalMaterial[];
  batches: TerminalBatch[];
  railLots: TerminalRailLot[];
  details: TerminalDetail[];
  products: TerminalProduct[];
  stock: TerminalStock;
}
