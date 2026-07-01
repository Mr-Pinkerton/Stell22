import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { SESSION_COOKIE, decryptSession } from "@/lib/session";

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
 */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") {
    redirect("/login");
  }
  return user;
}
