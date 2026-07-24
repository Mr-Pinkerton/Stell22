import type {
  Batch,
  Detail,
  Employee,
  Material,
  NomenclatureItem,
  Product,
  RailLot,
  StockSnapshot,
} from "@/types/domain";

export type TerminalScreen = "home" | "torcovka" | "prisadka" | "upakovka" | "hours";

export interface TerminalData {
  employees: Employee[];
  materials: Material[];
  batches: Batch[];
  railLots: RailLot[];
  details: Detail[];
  products: Product[];
  nomenclature: NomenclatureItem[];
  stock: StockSnapshot;
}
