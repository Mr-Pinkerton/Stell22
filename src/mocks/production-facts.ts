// Производственные факты для прототипа Этапа 9 — какие детали и сколько
// произведено из каждой партии. В Части B эти данные придут с терминала
// (OperationDetailLine), здесь — статичный мок для оживления отчёта
// «Себестоимость» движком расчёта.

export interface ProducedLine {
  batchId: string;
  detailId: string;
  quantity: number;
}

/**
 * Детали выбраны так, чтобы покрыть оба сорта и состав изделий
 * (det-1/det-3/det-2 входят в prod-1/prod-2). Объёмы — сотни деталей,
 * чтобы себестоимость на деталь была реалистичной (вся стоимость партии
 * раскладывается на произведённое).
 */
export const producedLines: ProducedLine[] = [
  // batch-1 «Волочек 2419» — в работе (PRELIMINARY)
  { batchId: "batch-1", detailId: "det-1", quantity: 300 }, // Полка 600, S1
  { batchId: "batch-1", detailId: "det-4", quantity: 150 }, // Канавка 600, S1
  { batchId: "batch-1", detailId: "det-3", quantity: 80 }, // Полка 800, S2
  { batchId: "batch-1", detailId: "det-2", quantity: 40 }, // Канавка 720, S2

  // batch-2 «Сосна 3020»
  { batchId: "batch-2", detailId: "det-1", quantity: 200 },
  { batchId: "batch-2", detailId: "det-2", quantity: 120 },

  // batch-3 «Ель 1812»
  { batchId: "batch-3", detailId: "det-3", quantity: 160 },
  { batchId: "batch-3", detailId: "det-4", quantity: 90 },

  // batch-4 «Бук 4025»
  { batchId: "batch-4", detailId: "det-1", quantity: 100 },
  { batchId: "batch-4", detailId: "det-3", quantity: 60 },

  // batch-7 «Ива 2024» — в архиве (FINAL, заморожено)
  { batchId: "batch-7", detailId: "det-1", quantity: 50 },
  { batchId: "batch-7", detailId: "det-2", quantity: 30 },
];

/** Произведено готовых изделий за период (упаковка) — для распределения накладных. */
export const producedProductQty: Record<string, number> = {
  "prod-1": 140,
  "prod-2": 90,
};
