// Тестовые данные для UI-прототипа (Часть A). Заменятся реальными в Части B.

import type {
  Batch,
  Detail,
  Employee,
  NomenclatureItem,
  OperationType,
  Product,
  RailLot,
  Sort,
  StockSnapshot,
  TerminalEntry,
  RailType,
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
  {
    id: "batch-2",
    name: "Сосна 3020",
    sectionWidthMm: 30,
    sectionHeightMm: 20,
    purchaseCost: 98000,
    totalCost: 102000,
    priceSort1: 19500,
    priceSort2: 14200,
    status: "IN_WORK",
    purchaseDate: "2026-06-05",
  },
  {
    id: "batch-3",
    name: "Ель 1812",
    sectionWidthMm: 18,
    sectionHeightMm: 36,
    purchaseCost: 87000,
    totalCost: 91000,
    priceSort1: 21000,
    priceSort2: 15500,
    status: "IN_WORK",
    purchaseDate: "2026-06-08",
  },
  {
    id: "batch-4",
    name: "Бук 4025",
    sectionWidthMm: 25,
    sectionHeightMm: 50,
    purchaseCost: 210000,
    totalCost: 218000,
    priceSort1: 28000,
    priceSort2: 21000,
    status: "IN_WORK",
    purchaseDate: "2026-06-10",
  },
  {
    id: "batch-5",
    name: "Ольха 1520",
    sectionWidthMm: 15,
    sectionHeightMm: 20,
    purchaseCost: 65000,
    totalCost: 68000,
    priceSort1: 17500,
    priceSort2: 12800,
    status: "IN_WORK",
    purchaseDate: "2026-06-12",
  },
  {
    id: "batch-6",
    name: "Липа 2218",
    sectionWidthMm: 22,
    sectionHeightMm: 18,
    purchaseCost: 112000,
    totalCost: 116500,
    priceSort1: 20500,
    priceSort2: 14900,
    status: "IN_WORK",
    purchaseDate: "2026-06-15",
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
  {
    id: "lot-5",
    batchId: "batch-1",
    lengthM: 2.4,
    railType: "POLKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0004",
    rows: 24,
    layers: 34,
    quantity: 45,
    remainingQuantity: 45,
  },
  {
    id: "lot-6",
    batchId: "batch-1",
    lengthM: 2.4,
    railType: "POLKA",
    sort: "SORT2",
    isPackage: true,
    code: "PKG-0005",
    rows: 24,
    layers: 34,
    quantity: 50,
    remainingQuantity: 22,
  },
  {
    id: "lot-7",
    batchId: "batch-1",
    lengthM: 3.0,
    railType: "KANAVKA",
    sort: "SORT2",
    isPackage: true,
    code: "PKG-0006",
    rows: 20,
    layers: 30,
    quantity: 35,
    remainingQuantity: 35,
  },
  {
    id: "lot-8",
    batchId: "batch-2",
    lengthM: 2.7,
    railType: "POLKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0101",
    rows: 22,
    layers: 32,
    quantity: 48,
    remainingQuantity: 48,
  },
  {
    id: "lot-9",
    batchId: "batch-2",
    lengthM: 2.7,
    railType: "POLKA",
    sort: "SORT2",
    isPackage: true,
    code: "PKG-0102",
    rows: 22,
    layers: 32,
    quantity: 48,
    remainingQuantity: 30,
  },
  {
    id: "lot-10",
    batchId: "batch-2",
    lengthM: 3.2,
    railType: "KANAVKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0103",
    rows: 18,
    layers: 28,
    quantity: 36,
    remainingQuantity: 36,
  },
  {
    id: "lot-11",
    batchId: "batch-2",
    lengthM: 3.2,
    railType: "KANAVKA",
    sort: "SORT2",
    isPackage: true,
    code: "PKG-0104",
    rows: 18,
    layers: 28,
    quantity: 36,
    remainingQuantity: 18,
  },
  {
    id: "lot-12",
    batchId: "batch-2",
    lengthM: 2.7,
    railType: "POLKA",
    sort: "SORT1",
    isPackage: false,
    quantity: 15,
    remainingQuantity: 15,
  },
  {
    id: "lot-13",
    batchId: "batch-2",
    lengthM: 3.2,
    railType: "KANAVKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0105",
    rows: 18,
    layers: 28,
    quantity: 30,
    remainingQuantity: 30,
  },
  {
    id: "lot-14",
    batchId: "batch-3",
    lengthM: 2.5,
    railType: "POLKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0201",
    rows: 20,
    layers: 30,
    quantity: 42,
    remainingQuantity: 42,
  },
  {
    id: "lot-15",
    batchId: "batch-3",
    lengthM: 2.5,
    railType: "POLKA",
    sort: "SORT2",
    isPackage: true,
    code: "PKG-0202",
    quantity: 40,
    remainingQuantity: 40,
  },
  {
    id: "lot-16",
    batchId: "batch-3",
    lengthM: 2.8,
    railType: "KANAVKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0203",
    quantity: 38,
    remainingQuantity: 38,
  },
  {
    id: "lot-17",
    batchId: "batch-3",
    lengthM: 2.8,
    railType: "KANAVKA",
    sort: "SORT2",
    isPackage: true,
    code: "PKG-0204",
    quantity: 38,
    remainingQuantity: 25,
  },
  {
    id: "lot-18",
    batchId: "batch-3",
    lengthM: 2.5,
    railType: "POLKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0205",
    quantity: 44,
    remainingQuantity: 44,
  },
  {
    id: "lot-19",
    batchId: "batch-3",
    lengthM: 2.8,
    railType: "KANAVKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0206",
    quantity: 32,
    remainingQuantity: 32,
  },
  {
    id: "lot-20",
    batchId: "batch-4",
    lengthM: 3.0,
    railType: "POLKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0301",
    quantity: 50,
    remainingQuantity: 50,
  },
  {
    id: "lot-21",
    batchId: "batch-4",
    lengthM: 3.0,
    railType: "POLKA",
    sort: "SORT2",
    isPackage: true,
    code: "PKG-0302",
    quantity: 50,
    remainingQuantity: 41,
  },
  {
    id: "lot-22",
    batchId: "batch-5",
    lengthM: 2.2,
    railType: "POLKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0401",
    quantity: 55,
    remainingQuantity: 55,
  },
  {
    id: "lot-23",
    batchId: "batch-6",
    lengthM: 2.6,
    railType: "KANAVKA",
    sort: "SORT1",
    isPackage: true,
    code: "PKG-0501",
    quantity: 40,
    remainingQuantity: 40,
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

const DETAIL_TYPE_LABEL: Record<RailType, string> = {
  POLKA: "Полка",
  KANAVKA: "Канавка",
};

/** По 20 деталей на каждый сорт и тип рейки (для терминала торцовки). */
function buildDetails(): Detail[] {
  const seeds: Detail[] = [
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

  const seedsByKey = new Map(seeds.map((d) => [`${d.detailType}-${d.sort}`, d]));
  const result: Detail[] = [];
  let seq = 5;

  for (const detailType of ["POLKA", "KANAVKA"] as RailType[]) {
    for (const sort of ["SORT1", "SORT2"] as Sort[]) {
      const group: Detail[] = [];
      const seed = seedsByKey.get(`${detailType}-${sort}`);
      if (seed) group.push(seed);

      while (group.length < 20) {
        const n = group.length + 1;
        const lengthMm = 400 + n * 20;
        group.push({
          id: `det-${seq++}`,
          name: `${DETAIL_TYPE_LABEL[detailType]} ${lengthMm}`,
          lengthM: lengthMm / 1000,
          detailType,
          sort,
          prisadkaTorcevaya: n % 2 === 1,
          prisadkaPloskost: n % 3 === 0,
          status: "ACTIVE",
        });
      }
      result.push(...group);
    }
  }

  return result;
}

export const details: Detail[] = buildDetails();

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

/**
 * Журнал внесений терминала (моки). Генерируем ~5 недель относительно «сегодня»,
 * чтобы было что листать в режимах «Неделя» и «Месяц». Детерминированный ГПСЧ
 * (по индексу дня) — стабильные данные между перезагрузками.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Внесение в указанный день со смещением часа от начала рабочего дня. */
function entry(
  employeeId: string,
  type: OperationType,
  daysAgo: number,
  hour: number,
  quantity: number,
  rate: number,
): TerminalEntry {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  d.setHours(hour, 0, 0, 0);
  return {
    id: `${employeeId}-${type}-${daysAgo}-${hour}`,
    employeeId,
    type,
    occurredAt: d.toISOString(),
    quantity,
    amount: Math.round(quantity * rate * 100) / 100,
  };
}

function buildTerminalEntries(): TerminalEntry[] {
  const result: TerminalEntry[] = [];
  const emp1 = employees[0]; // сдельщик: торцовка + присадка + иногда часы
  const emp2 = employees[1]; // окладник-упаковщик: упаковка (0 ₽) + часы

  for (let daysAgo = 0; daysAgo <= 34; daysAgo++) {
    const date = new Date(Date.now() - daysAgo * DAY_MS);
    const weekday = date.getDay(); // 0=вс, 6=сб
    if (weekday === 0) continue; // воскресенье — выходной
    const rnd = mulberry32(20260600 + daysAgo);

    // emp-1
    if (rnd() > 0.12) {
      const torc = 80 + Math.floor(rnd() * 90);
      result.push(
        entry(emp1.id, "TORCOVKA", daysAgo, 8, torc, emp1.rateTorcovkaSort1 ?? 0),
      );
      if (rnd() > 0.35) {
        const pris = 40 + Math.floor(rnd() * 60);
        result.push(
          entry(emp1.id, "PRISADKA", daysAgo, 12, pris, emp1.ratePrisadkaTorcev ?? 0),
        );
      }
      if (rnd() > 0.8) {
        result.push(entry(emp1.id, "HOURS", daysAgo, 17, 2, emp1.hourlyRate ?? 0));
      }
    }

    // emp-2
    if (weekday !== 6 && rnd() > 0.15) {
      const hours = 7 + Math.floor(rnd() * 3);
      result.push(entry(emp2.id, "HOURS", daysAgo, 9, hours, emp2.hourlyRate ?? 0));
      const pack = 30 + Math.floor(rnd() * 40);
      result.push(entry(emp2.id, "UPAKOVKA", daysAgo, 14, pack, emp2.rateUpakovka ?? 0));
    }
  }

  return result;
}

export const terminalEntries: TerminalEntry[] = buildTerminalEntries();

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
