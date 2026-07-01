import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import type { SystemLogInput } from "@/lib/system-log";

/**
 * Запись в операционный журнал (SystemLog). Для синхронизаций, ошибок API и т.п.
 * Смотреть: Настройки → Логи.
 */
export async function writeSystemLog(input: SystemLogInput): Promise<void> {
  await prisma.systemLog.create({
    data: {
      level: input.level,
      source: input.source,
      message: input.message,
      details: (input.details ?? undefined) as Prisma.InputJsonValue | undefined,
      userId: input.userId ?? null,
    },
  });
}
