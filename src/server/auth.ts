"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { verifyPassword } from "@/lib/password";
import {
  SESSION_COOKIE,
  encryptSession,
  sessionCookieOptions,
} from "@/lib/session";

export interface SignInState {
  error?: string;
}

/**
 * Вход по email + паролю. Используется как action в useActionState.
 * Сообщение об ошибке одинаковое для «нет пользователя» и «неверный пароль»,
 * чтобы не раскрывать существование аккаунта.
 */
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Введите email и пароль" };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    return { error: "Неверный email или пароль" };
  }

  const token = await encryptSession({ userId: user.id, role: user.role });
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions);

  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
