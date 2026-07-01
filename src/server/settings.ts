"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { requireAdmin } from "@/server/session";
import { writeChangeLog } from "@/server/change-log";
import { verifyPassword } from "@/lib/password";
import {
  API_CREDENTIAL_KEYS,
  SETTING_PREFIX,
  type ApiCredentialValues,
} from "@/lib/api-credentials";

export type VerifyApiCredentialsPasswordResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Повторная проверка пароля текущего администратора перед просмотром API-ключей.
 * Используется тот же пароль, что и при входе в систему.
 */
export async function verifyApiCredentialsPassword(
  password: string,
): Promise<VerifyApiCredentialsPasswordResult> {
  const admin = await requireAdmin();
  if (!password) {
    return { ok: false, error: "Введите пароль" };
  }

  const user = await prisma.user.findUnique({
    where: { id: admin.id },
    select: { passwordHash: true },
  });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, error: "Неверный пароль" };
  }

  return { ok: true };
}

/**
 * Значения API-ключей из БД без проверки сессии (для серверной синхронизации).
 */
export async function loadStoredApiCredentials(): Promise<ApiCredentialValues> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: SETTING_PREFIX } },
  });
  const stored = new Map(rows.map((r) => [r.key.slice(SETTING_PREFIX.length), r.value]));
  const out: ApiCredentialValues = {};
  for (const key of API_CREDENTIAL_KEYS) {
    const v = stored.get(key);
    out[key] = typeof v === "string" ? v : "";
  }
  return out;
}

/**
 * Значения API-ключей из key-value модели Setting. Возвращает { key: value }
 * для всех известных полей (отсутствующие — пустая строка). Только для админа.
 */
export async function getApiCredentials(): Promise<ApiCredentialValues> {
  await requireAdmin();
  return loadStoredApiCredentials();
}

/**
 * Сохраняет API-ключи (upsert по каждому известному полю). Неизвестные ключи
 * игнорируются. Значения в аудит НЕ пишем (секреты) — только факт обновления.
 */
export async function saveApiCredentials(values: ApiCredentialValues): Promise<{ ok: true }> {
  const admin = await requireAdmin();

  const updatedFields: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const key of API_CREDENTIAL_KEYS) {
      if (!(key in values)) continue;
      const value = String(values[key] ?? "").trim();
      await tx.setting.upsert({
        where: { key: `${SETTING_PREFIX}${key}` },
        create: { key: `${SETTING_PREFIX}${key}`, value },
        update: { value },
      });
      updatedFields.push(key);
    }
    await writeChangeLog(
      {
        entity: "Setting",
        entityId: "apiCredentials",
        userId: admin.id,
        newValues: { updatedFields },
      },
      tx,
    );
  });

  revalidatePath("/settings");
  return { ok: true };
}
