import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db";

// Транзакционный клиент Prisma (внутри $transaction) или обычный.
type Db = PrismaClient | Prisma.TransactionClient;

export interface ChangeLogInput {
  /** Имя сущности, например "Employee", "Batch". */
  entity: string;
  entityId: string;
  /** id администратора (User), если известен. */
  userId?: string | null;
  /** Состояние до изменения (для create — null). JSON-совместимый объект. */
  oldValues?: unknown;
  /** Состояние после изменения (для delete — null). JSON-совместимый объект. */
  newValues?: unknown;
}

/**
 * Запись в журнал изменений (аудит). Переиспользуемая обёртка: вызывать при
 * любом изменении производственной/финансовой записи. Можно передать
 * транзакционный клиент `db`, чтобы запись лога была атомарна с самой операцией.
 */
export async function writeChangeLog(input: ChangeLogInput, db: Db = prisma): Promise<void> {
  await db.changeLog.create({
    data: {
      entity: input.entity,
      entityId: input.entityId,
      userId: input.userId ?? null,
      oldValues: (input.oldValues ?? undefined) as Prisma.InputJsonValue | undefined,
      newValues: (input.newValues ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
