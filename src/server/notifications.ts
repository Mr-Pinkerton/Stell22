"use server";

import type { Prisma, PrismaClient } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { getDashboardData } from "@/server/dashboard";
import { buildDashboardAlerts, type DashboardAlert } from "@/lib/dashboard-metrics";

// Транзакционный клиент Prisma (внутри $transaction) или обычный.
type Db = PrismaClient | Prisma.TransactionClient;

export type NotificationTone = "ERROR" | "SUCCESS" | "INFO";

export interface NotificationRow {
  id: string;
  title: string;
  message: string;
  tone: NotificationTone;
  href: string | null;
  isRead: boolean;
  createdAt: string;
}

const toneByAlertTone: Record<DashboardAlert["tone"], NotificationTone> = {
  red: "ERROR",
  amber: "INFO",
  violet: "INFO",
  blue: "INFO",
};

/**
 * Разовое событие (партия закрыта, ЗП выплачена и т.п.) — создаётся один раз
 * в момент действия. Дедупликация по `key`: повторный вызов с тем же key
 * ничего не делает (напр. если действие идемпотентно повторяется в рамках
 * одной транзакции).
 */
export async function notifyEvent(
  input: {
    key: string;
    title: string;
    message: string;
    tone: NotificationTone;
    href?: string;
    severity?: number;
  },
  db: Db = prisma,
): Promise<void> {
  await db.notification.upsert({
    where: { key: input.key },
    update: {},
    create: {
      key: input.key,
      title: input.title,
      message: input.message,
      tone: input.tone,
      href: input.href ?? null,
      severity: input.severity ?? 0,
      isSystem: false,
      isRead: false,
    },
  });
}

/**
 * Пересчёт «системных» уведомлений (текущее состояние) из тех же условий,
 * что и алерты на дашборде. Отсутствующие условия — удаляются, новые/текущие —
 * upsert (без сброса isRead при повторном срабатывании, чтобы не будить
 * прочитанное уведомление на каждое обновление панели).
 */
async function syncSystemNotifications(): Promise<void> {
  const source = await getDashboardData();
  const alerts = buildDashboardAlerts(source);
  const keys = alerts.map((a) => `system:${a.id}`);

  await prisma.$transaction([
    ...alerts.map((a) =>
      prisma.notification.upsert({
        where: { key: `system:${a.id}` },
        update: {
          title: a.title,
          message: a.description,
          href: a.href,
          severity: a.severity,
          tone: toneByAlertTone[a.tone],
        },
        create: {
          key: `system:${a.id}`,
          title: a.title,
          message: a.description,
          href: a.href,
          severity: a.severity,
          tone: toneByAlertTone[a.tone],
          isSystem: true,
          isRead: false,
        },
      }),
    ),
    prisma.notification.deleteMany({
      where: keys.length > 0 ? { isSystem: true, key: { notIn: keys } } : { isSystem: true },
    }),
  ]);
}

function serialize(row: {
  id: string;
  title: string;
  message: string;
  tone: NotificationTone;
  href: string | null;
  isRead: boolean;
  createdAt: Date;
}): NotificationRow {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    tone: row.tone,
    href: row.href,
    isRead: row.isRead,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getNotifications(limit = 30): Promise<NotificationRow[]> {
  await syncSystemNotifications();
  const rows = await prisma.notification.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(serialize);
}

export async function markNotificationRead(id: string): Promise<void> {
  await prisma.notification.update({ where: { id }, data: { isRead: true } });
  revalidatePath("/", "layout");
}

export async function markAllNotificationsRead(): Promise<void> {
  await prisma.notification.updateMany({ where: { isRead: false }, data: { isRead: true } });
  revalidatePath("/", "layout");
}
