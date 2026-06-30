import { recalcBatchCosts } from "@/server/cost";

// Внутрипроцессный коалесцинг пересчётов себестоимости (лёгкая замена очереди
// до появления Redis/воркера). Цель — не запускать одинаковый тяжёлый пересчёт
// параллельно/повторно: конкурентные вызовы по одному ключу разделяют один
// прогон, а запросы, пришедшие во время прогона, инициируют ровно один
// «догоняющий» прогон после него. Вызывающий await-ит общий промис и получает
// уже свежие данные.

const ALL_KEY = "__all__";
const running = new Map<string, Promise<void>>();
const dirty = new Set<string>();

/**
 * Поставить пересчёт партии (или всех открытых, если batchId не задан) в
 * коалесцирующую очередь. Возвращает промис, завершающийся после прогона,
 * покрывающего данный запрос.
 */
export async function enqueueRecalcBatchCosts(batchId?: string): Promise<void> {
  const key = batchId ?? ALL_KEY;
  const existing = running.get(key);
  if (existing) {
    // Пересчёт уже идёт — пометим, что нужен догоняющий прогон, и подождём его.
    dirty.add(key);
    return existing;
  }

  const job = (async () => {
    try {
      do {
        dirty.delete(key);
        await recalcBatchCosts(batchId ? { batchId } : {});
      } while (dirty.has(key));
    } finally {
      running.delete(key);
    }
  })();
  running.set(key, job);
  return job;
}
