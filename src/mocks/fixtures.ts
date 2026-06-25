// Тестовые данные для UI-прототипа (Часть A). Заменятся реальными в Части B.

import type { Batch, Detail, Employee, NomenclatureItem, Product, RailLot } from "@/types/domain";

export const employees: Employee[] = [
  {
    id: "emp-1",
    fullName: "Иванов Иван Иванович",
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
];
