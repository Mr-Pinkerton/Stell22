// Тестовые данные для UI-прототипа (Часть A). Заменятся реальными в Части B.

import type {
  Batch,
  Detail,
  Employee,
  NomenclatureItem,
  Product,
  RailLot,
  StockSnapshot,
} from "@/types/domain";

export const employees: Employee[] = [
  {
    id: "emp-1",
    fullName: "Иванов Иван Иванович",
    birthDate: `${new Date().getFullYear() - 35}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`, // ДР сегодня — для демо поздравления
    pin: "1234",
    status: "ACTIVE",
    hourlyRate: 300,
    rateTorcovkaSort1: 5,
    rateTorcovkaSort2: 4,
    ratePrisadkaTorcev: 3,
    ratePrisadkaPloskt: 3,
    rateUpakovka: 20,
  },
  {
    id: "emp-2",
    fullName: "Петрова Анна Сергеевна",
    pin: "5678",
    status: "ACTIVE",
    hourlyRate: 280, // упаковщик на окладе (без сдельных расценок)
  },
];

export const batches: Batch[] = [
  {
    id: "batch-1",
    name: "Волочек 2419",
    sectionWidthMm: 20,
    sectionHeightMm: 40,
    purchaseCost: 150000,
    totalCost: 158000,
    priceSort1: 22000,
    priceSort2: 16000,
    status: "IN_WORK",
    purchaseDate: "2026-06-01",
  },
];

export const railLots: RailLot[] = [
  {
    id: "lot-1",
    batchId: "batch-1",
    lengthM: 2.4,
    railType: "POLKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0001",
    rows: 24,
    layers: 34,
    quantity: 50,
    remainingQuantity: 50,
  },
  {
    id: "lot-2",
    batchId: "batch-1",
    lengthM: 2.4,
    railType: "POLKA",
    sort: "SORT2",
    isPackage: true,
    code: "PKG-0002",
    rows: 24,
    layers: 34,
    quantity: 50,
    remainingQuantity: 38,
  },
  {
    id: "lot-3",
    batchId: "batch-1",
    lengthM: 3.0,
    railType: "KANAVKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0003",
    rows: 20,
    layers: 30,
    quantity: 40,
    remainingQuantity: 40,
  },
  {
    id: "lot-4",
    batchId: "batch-1",
    lengthM: 3.0,
    railType: "KANAVKA",
    sort: "SORT1",
    isPackage: false,
    quantity: 12,
    remainingQuantity: 12,
  },
];

export const nomenclatureItems: NomenclatureItem[] = [
  {
    id: "nom-1",
    name: "Саморез 4x40",
    type: "FASTENER",
    unitPrice: 1.5,
    status: "ACTIVE",
    minStock: 500,
  },
  {
    id: "nom-2",
    name: "Коробка стандарт",
    type: "PACKAGING",
    unitPrice: 35,
    status: "ACTIVE",
    minStock: 50,
  },
];

export const details: Detail[] = [
  {
    id: "det-1",
    name: "Полка 600",
    lengthM: 0.6,
    detailType: "POLKA",
    sort: "SORT1",
    prisadkaTorcevaya: true,
    prisadkaPloskost: false,
    status: "ACTIVE",
  },
  {
    id: "det-2",
    name: "Канавка 720",
    lengthM: 0.72,
    detailType: "KANAVKA",
    sort: "SORT2",
    prisadkaTorcevaya: true,
    prisadkaPloskost: true,
    status: "ACTIVE",
  },
  {
    id: "det-3",
    name: "Полка 800",
    lengthM: 0.8,
    detailType: "POLKA",
    sort: "SORT2",
    prisadkaTorcevaya: true,
    prisadkaPloskost: false,
    status: "ACTIVE",
  },
  {
    id: "det-4",
    name: "Канавка 600",
    lengthM: 0.6,
    detailType: "KANAVKA",
    sort: "SORT1",
    prisadkaTorcevaya: false,
    prisadkaPloskost: false,
    status: "ACTIVE",
  },
];

export const products: Product[] = [
  {
    id: "prod-1",
    name: "Полка настенная",
    sku: "ART-001",
    sort: "SORT1",
    salePrice: 1200,
    packagingId: "nom-2",
    status: "ACTIVE",
    details: [{ detailId: "det-1", quantity: 2 }],
    fastenerIds: [{ nomenclatureId: "nom-1", quantity: 8 }],
    extraIds: [],
  },
  {
    id: "prod-2",
    name: "Полка угловая",
    sku: "ART-002",
    sort: "SORT2",
    salePrice: 1500,
    packagingId: "nom-2",
    status: "ACTIVE",
    details: [
      { detailId: "det-3", quantity: 2 },
      { detailId: "det-2", quantity: 1 },
    ],
    fastenerIds: [{ nomenclatureId: "nom-1", quantity: 12 }],
    extraIds: [],
  },
];

/** Срез остатков для прототипа терминала. */
export const stockSnapshot: StockSnapshot = {
  detailsReady: {
    "det-1": 90,
    "det-2": 24,
    "det-3": 70,
    "det-4": 0,
  },
  nomenclature: {
    "nom-1": 800, // саморезы
    "nom-2": 40, // коробки
  },
  prisadkaPending: {
    "det-1": { torcev: 60, plosk: 0 },
    "det-2": { torcev: 40, plosk: 75 },
    "det-3": { torcev: 35, plosk: 0 },
    "det-4": { torcev: 0, plosk: 0 },
  },
};
