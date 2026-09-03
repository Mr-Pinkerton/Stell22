import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db";
import type { NotificationTone } from "@/server/notifications";

type Db = PrismaClient | Prisma.TransactionClient;

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
