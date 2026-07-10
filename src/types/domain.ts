// Доменные типы (зеркало prisma/schema.prisma).
// Используются в UI и моках. В коде расчётов деньги/измерения считаем через
// Decimal; здесь — числа для отображения в прототипе.

export type UserRole = "ADMIN";
export type EmployeeStatus = "ACTIVE" | "ARCHIVED";
export type RailType = "POLKA" | "KANAVKA";
export type Sort = "SORT1" | "SORT2";
export type BatchStatus = "IN_WORK" | "ARCHIVED";
export type NomenclatureType = "FASTENER" | "PACKAGING" | "OTHER";
export type ProductStatus = "ACTIVE" | "ARCHIVED";
export type OperationType = "TORCOVKA" | "PRISADKA" | "UPAKOVKA" | "HOURS";
export type FlowType = "INCOME" | "EXPENSE";
export type DealStatus = "OPEN" | "ARCHIVED";
export type InventoryStatus = "DRAFT" | "CONDUCTED" | "CLOSED";
export type GoalStatus = "ACTIVE" | "ARCHIVED";
export type CostStatus = "PRELIMINARY" | "FINAL";

export interface Employee {
  id: string;
  fullName: string;
  birthDate?: string | null;
  pin: string;
  status: EmployeeStatus;
  hourlyRate?: number | null;
  rateTorcovkaSort1?: number | null;
  rateTorcovkaSort2?: number | null;
  ratePrisadkaTorcev?: number | null;
  ratePrisadkaPloskt?: number | null;
  rateUpakovka?: number | null;
}

export interface Batch {
  id: string;
  name: string;
  sectionWidthMm: number;
  sectionHeightMm: number;
  purchaseCost: number; // истина "Стоимость партии"
  totalCost: number; // с доставкой
  priceSort1: number; // ₽/м3
  priceSort2: number; // ₽/м3
  status: BatchStatus;
  purchaseDate: string;
  note?: string | null;
}

export interface RailLot {
  id: string;
  batchId: string;
  lengthM: number;
  railType: RailType;
  sort: Sort;
  isPackage: boolean;
  code?: string | null;
  rows?: number | null;
  layers?: number | null;
  quantity: number;
  remainingQuantity: number;
}

export interface NomenclatureItem {
  id: string;
  name: string;
  type: NomenclatureType;
  unitPrice: number;
  status: ProductStatus;
  minStock?: number | null;
}

export interface Detail {
  id: string;
  name: string;
  /** Уникальный номер детали (длина + присадки). Используется при упаковке. */
  detailNumber: number;
  lengthM: number;
  detailType: RailType;
  sort: Sort;
  prisadkaTorcevaya: boolean;
  prisadkaPloskost: boolean;
  status: ProductStatus;
}

export interface ProductDetail {
  detailId: string;
  quantity: number;
}

export interface Product {
  id: string;
  name: string;
  /** Артикул Ozon (offer_id). */
  skuOzon: string;
  /** Артикул Wildberries (supplierArticle). */
  skuWb: string;
  sort: Sort;
  packagingId?: string | null;
  status: ProductStatus;
  details: ProductDetail[];
  fastenerIds: { nomenclatureId: string; quantity: number }[];
  extraIds: string[];
}

/**
 * Одно внесение работника в терминале (снапшот операции для журнала).
 * `quantity` — в натуральных единицах операции (детали/присадки/изделия/часы),
 * `amount` — заработок ₽ за это внесение по расценкам работника (для отображения
 * — number, как и остальные суммы в прототипе; в Части B — Decimal в БД).
 */
export interface TerminalEntry {
  id: string;
  employeeId: string;
  type: OperationType;
  occurredAt: string; // ISO datetime (UTC)
  quantity: number;
  amount: number;
}

/**
 * Срез остатков склада для прототипа терминала (моки).
 * В Части B заменяется реальным снимком из БД.
 */
export interface StockSnapshot {
  /** Ключ заготовки `${lengthM}|${detailType}|${sort}` → кол-во заготовок. */
  blanks: Record<string, number>;
  /** detailId → кол-во ГОТОВЫХ деталей (все требуемые присадки выполнены). */
  detailsReady: Record<string, number>;
  /** nomenclatureId → остаток (крепёж/упаковка/разное). */
  nomenclature: Record<string, number>;
  /** detailId → сколько пригодных к каждому типу присадки (заготовки + частичные). */
  prisadkaPending: Record<string, { torcev: number; plosk: number }>;
}
