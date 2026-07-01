"use server";

import { prisma } from "@/server/db";
import type { SystemLogRow } from "@/mocks/settings-fixtures";

// Человекочитаемые подписи сущностей журнала изменений.
const ENTITY_LABEL: Record<string, string> = {
  Employee: "Сотрудники",
  Detail: "Номенклатура",
  NomenclatureItem: "Номенклатура",
  Product: "Изделия",
  Batch: "Закупки",
  SimplePurchase: "Закупки",
  ProductionOperation: "Производство",
  BatchCost: "Себестоимость",
  CashFlow: "Финансы (ДДС)",
  Counterparty: "Контрагенты",
  Article: "Статьи",
  AutoRule: "Автоправила",
  Deal: "Сделки",
  Statement: "Выписки",
  Account: "Счета",
  Inventory: "Инвентаризация",
  InventoryLine: "Инвентаризация",
  MpStock: "Маркетплейсы",
  Goal: "Цели",
  Payment: "Зарплата",
};

function describe(entity: string, entityId: string, newValues: unknown, oldValues: unknown): string {
  const label = ENTITY_LABEL[entity] ?? entity;
  const nv = (newValues ?? {}) as Record<string, unknown>;
  const ov = (oldValues ?? {}) as Record<string, unknown>;

  // Удаление: нет newValues, есть oldValues.
  if (!newValues && oldValues) return `${label}: удаление (${entityId})`;

  // Частые осмысленные случаи.
  if (entity === "ProductionOperation" && typeof nv.type === "string") {
    return `${label}: операция «${nv.type}»`;
  }
  if (entity === "CashFlow" && entityId === "reapply") {
    return `${label}: авторазнесение операций (${String(nv.reappliedCount ?? 0)})`;
  }
  if (entity === "MpStock" && entityId === "sync") {
    return `${label}: синхронизация (продажи ${String(nv.salesAdded ?? 0)}, поставки ${String(nv.suppliesAdded ?? 0)}, остатки ${String(nv.stockUpdated ?? 0)})`;
  }
  if (typeof nv.status === "string") {
    const from = typeof ov.status === "string" ? `${ov.status} → ` : "";
    return `${label}: статус ${from}${nv.status}`;
  }
  if (typeof nv.name === "string") return `${label}: «${nv.name}»`;

  return oldValues ? `${label}: изменение (${entityId})` : `${label}: создание (${entityId})`;
}

/** Журнал изменений из БД (ChangeLog) → строки для вкладки «Логи». */
export async function getChangeLogs(limit = 100): Promise<SystemLogRow[]> {
  const logs = await prisma.changeLog.findMany({
    orderBy: { changedAt: "desc" },
    take: limit,
  });
  return logs.map((l) => ({
    id: l.id,
    at: l.changedAt.toISOString(),
    level: "INFO" as const,
    source: ENTITY_LABEL[l.entity] ?? l.entity,
    message: describe(l.entity, l.entityId, l.newValues, l.oldValues),
  }));
}
