import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import {
  SESSION_COOKIE,
  TERMINAL_COOKIE,
  decryptSession,
  decryptTerminalSession,
} from "@/lib/session";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

/**
 * Текущий пользователь из cookie-сессии или null. Мемоизируется на один
 * рендер (React cache), чтобы layout/страницы/шапка не били в БД повторно.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await decryptSession(token);
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, name: true, email: true, role: true },
  });
  return user;
});

/**
 * Гейт для админских маршрутов: возвращает пользователя или редиректит на
 * /login. Вызывать в layout группы (admin) и, для надёжности, в мутациях.
 *
 * A22 (на будущее): сейчас большинство server actions полагаются только на гейт
 * в layout группы (admin) и НЕ вызывают requireAdmin() сами. Пока ролей всего две
 * (ADMIN / сотрудник терминала) и весь (admin)-контур доступен только админу —
 * это терпимо. Когда появятся дополнительные роли/ограниченный доступ, обернуть
 * мутации (finance/production/nomenclature/…) вызовом requireAdmin() поштучно,
 * как уже сделано в settings.ts. Не делаем сейчас, чтобы не плодить шум.
 */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") {
    redirect("/login");
  }
  return user;
}

export interface TerminalEmployee {
  id: string;
  fullName: string;
}

/**
 * Гейт для операций терминала (A14): требует валидную терминальную cookie-сессию
 * и ACTIVE-сотрудника. Если передан `expectedEmployeeId`, он обязан совпасть с
 * сессией (клиент не может действовать «за другого»). Бросает — не редиректит,
 * т.к. вызывается из мутаций (server actions), не из рендера страниц.
 */
export async function requireTerminalEmployee(
  expectedEmployeeId?: string,
): Promise<TerminalEmployee> {
  const token = (await cookies()).get(TERMINAL_COOKIE)?.value;
  const session = await decryptTerminalSession(token);
  if (!session) throw new Error("Нет активной сессии терминала. Войдите по PIN.");

  const employee = await prisma.employee.findUnique({
    where: { id: session.employeeId },
    select: { id: true, fullName: true, status: true },
  });
  if (!employee || employee.status !== "ACTIVE") {
    throw new Error("Сессия терминала недействительна. Войдите заново.");
  }
  if (expectedEmployeeId && expectedEmployeeId !== employee.id) {
    throw new Error("Несовпадение сотрудника сессии.");
  }
  return { id: employee.id, fullName: employee.fullName };
}
