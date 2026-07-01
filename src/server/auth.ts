"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { verifyPassword } from "@/lib/password";
import {
  SESSION_COOKIE,
  encryptSession,
  sessionCookieOptions,
} from "@/lib/session";
import { RateLimiter, retryAfterSeconds } from "@/lib/rate-limit";

export interface SignInState {
  error?: string;
}

// 5 неудачных попыток за 15 минут → блокировка на 15 минут.
// In-memory: корректно при одном инстансе (см. DEPLOY.md).
const loginLimiter = new RateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
});

/** IP клиента из заголовков обратного прокси (fallback — общий ключ). */
async function clientKey(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim();
  return ip || "unknown";
}

function blockedMessage(retryAfterMs: number): string {
  const min = Math.ceil(retryAfterSeconds(retryAfterMs) / 60);
  return `Слишком много попыток входа. Повторите через ${min} мин.`;
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

  const key = await clientKey();
  const gate = loginLimiter.check(key);
  if (gate.blocked) {
    return { error: blockedMessage(gate.retryAfterMs) };
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) {
    const failure = loginLimiter.recordFailure(key);
    if (failure.blocked) {
      return { error: blockedMessage(failure.retryAfterMs) };
    }
    return { error: "Неверный email или пароль" };
  }

  loginLimiter.reset(key);
  const token = await encryptSession({ userId: user.id, role: user.role });
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions);

  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
