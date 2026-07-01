"use server";

import { prisma } from "@/server/db";
import type { LogLevel, SystemLogRow } from "@/mocks/settings-fixtures";
import type { SystemLogLevel } from "@/lib/system-log";

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
  Supply: "Маркетплейсы",
  Setting: "Настройки",
  Goal: "Цели",
  Payment: "Зарплата",
};

function auditLevel(entity: string, newValues: unknown): LogLevel {
  const nv = (newValues ?? {}) as Record<string, unknown>;
  if (entity === "Supply" && nv.event === "gp_shortfall") return "WARN";
  return "INFO";
}

function describe(entity: string, entityId: string, newValues: unknown, oldValues: unknown): string {
  const label = ENTITY_LABEL[entity] ?? entity;
  const nv = (newValues ?? {}) as Record<string, unknown>;
  const ov = (oldValues ?? {}) as Record<string, unknown>;

  if (!newValues && oldValues) return `${label}: удаление (${entityId})`;

  if (entity === "ProductionOperation" && typeof nv.type === "string") {
    return `${label}: операция «${nv.type}»`;
  }
  if (entity === "CashFlow" && entityId === "reapply") {
    return `${label}: авторазнесение операций (${String(nv.reappliedCount ?? 0)})`;
  }
  if (entity === "MpStock" && entityId === "sync") {
    return `${label}: синхронизация (продажи ${String(nv.salesAdded ?? 0)}, поставки ${String(nv.suppliesAdded ?? 0)}, остатки ${String(nv.stockUpdated ?? 0)}, списано с производства ${String(nv.deductedFromProduction ?? 0)})`;
  }
  if (entity === "Supply" && nv.event === "gp_shortfall") {
    return `${label}: потеря ГП по поставке (${String(nv.sku ?? "")}, ${String(nv.shortfall ?? 0)} шт — нехватка на складе)`;
  }
  if (entity === "Setting" && entityId === "apiCredentials") {
    const fields = Array.isArray(nv.updatedFields) ? nv.updatedFields.join(", ") : "";
    return `${label}: обновлены API-ключи (${fields})`;
  }
  if (typeof nv.status === "string") {
    const from = typeof ov.status === "string" ? `${ov.status} → ` : "";
    return `${label}: статус ${from}${nv.status}`;
  }
  if (typeof nv.name === "string") return `${label}: «${nv.name}»`;

  return oldValues ? `${label}: изменение (${entityId})` : `${label}: создание (${entityId})`;
}

function mapAuditLog(l: {
  id: string;
  entity: string;
  entityId: string;
  newValues: unknown;
  oldValues: unknown;
  changedAt: Date;
}): SystemLogRow {
  return {
    id: l.id,
    at: l.changedAt.toISOString(),
    level: auditLevel(l.entity, l.newValues),
    source: ENTITY_LABEL[l.entity] ?? l.entity,
    message: describe(l.entity, l.entityId, l.newValues, l.oldValues),
    kind: "audit",
  };
}

function mapSystemLog(l: {
  id: string;
  level: SystemLogLevel;
  source: string;
  message: string;
  details: unknown;
  createdAt: Date;
}): SystemLogRow {
  const details =
    l.details && typeof l.details === "object" && !Array.isArray(l.details)
      ? (l.details as Record<string, unknown>)
      : null;
  return {
    id: l.id,
    at: l.createdAt.toISOString(),
    level: l.level,
    source: l.source,
    message: l.message,
    details,
    kind: "system",
  };
}

/** Операционный журнал (ошибки API, синхронизации). */
export async function getSystemLogs(limit = 100): Promise<SystemLogRow[]> {
  const logs = await prisma.systemLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return logs.map(mapSystemLog);
}

/** Журнал изменений (аудит бизнес-операций). */
export async function getChangeLogs(limit = 100): Promise<SystemLogRow[]> {
  const logs = await prisma.changeLog.findMany({
    orderBy: { changedAt: "desc" },
    take: limit,
  });
  return logs.map(mapAuditLog);
}

/**
 * Объединённая лента для Настройки → Логи: операционные события + аудит,
 * по убыванию времени.
 */
export async function getSettingsLogs(limit = 150): Promise<SystemLogRow[]> {
  const [system, audit] = await Promise.all([getSystemLogs(limit), getChangeLogs(limit)]);
  return [...system, ...audit]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}
