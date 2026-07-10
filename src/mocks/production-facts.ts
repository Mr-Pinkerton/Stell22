// Производственные факты для прототипа Этапа 9 — сколько заготовок (по длине и
// сорту) произведено из каждой партии. В Части B эти данные придут с терминала
// (OperationDetailLine торцовки), здесь — статичный мок для оживления отчёта
// «Себестоимость» движком расчёта.

import type { Sort } from "@/types/domain";

export interface ProducedLine {
  batchId: string;
  lengthM: number;
  sort: Sort;
  quantity: number;
}

/**
 * Заготовки покрывают оба сорта и длины, входящие в состав изделий.
 * Объёмы — сотни штук, чтобы себестоимость была реалистичной (вся стоимость
 * партии раскладывается на произведённое).
 */
export const producedLines: ProducedLine[] = [
  // batch-1 «Волочек 2419» — в работе (PRELIMINARY)
  { batchId: "batch-1", lengthM: 0.6, sort: "SORT1", quantity: 450 }, // полка/канавка 600, S1
  { batchId: "batch-1", lengthM: 0.8, sort: "SORT2", quantity: 80 }, // полка 800, S2
  { batchId: "batch-1", lengthM: 0.72, sort: "SORT2", quantity: 40 }, // канавка 720, S2

  // batch-2 «Сосна 3020»
  { batchId: "batch-2", lengthM: 0.6, sort: "SORT1", quantity: 200 },
  { batchId: "batch-2", lengthM: 0.72, sort: "SORT2", quantity: 120 },

  // batch-3 «Ель 1812»
  { batchId: "batch-3", lengthM: 0.8, sort: "SORT2", quantity: 160 },
  { batchId: "batch-3", lengthM: 0.6, sort: "SORT1", quantity: 90 },

  // batch-4 «Бук 4025»
  { batchId: "batch-4", lengthM: 0.6, sort: "SORT1", quantity: 100 },
  { batchId: "batch-4", lengthM: 0.8, sort: "SORT2", quantity: 60 },

  // batch-7 «Ива 2024» — в архиве (FINAL, заморожено)
  { batchId: "batch-7", lengthM: 0.6, sort: "SORT1", quantity: 50 },
  { batchId: "batch-7", lengthM: 0.72, sort: "SORT2", quantity: 30 },
];

/** Произведено готовых изделий за период (упаковка) — для распределения накладных. */
export const producedProductQty: Record<string, number> = {
  "prod-1": 140,
  "prod-2": 90,
};
