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
import {
  defaultAppSettings,
  type AppSettings,
  type MinStockKind,
  type MinStockRow,
} from "@/mocks/settings-fixtures";

// Общие параметры приложения хранятся одним JSON-значением в key-value Setting.
const APP_SETTINGS_KEY = "app:settings";

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

/**
 * Общие параметры приложения из БД (A20). Раньше жили только в моке —
 * порог отхода теперь реально читается движком дашборда/уведомлений.
 * Отсутствует/битое значение → дефолт.
 */
export async function getAppSettings(): Promise<AppSettings> {
  const row = await prisma.setting.findUnique({ where: { key: APP_SETTINGS_KEY } });
  const raw = row?.value;
  const wasteRaw =
    raw && typeof raw === "object" && !Array.isArray(raw) && "wasteThresholdPct" in raw
      ? Number((raw as Record<string, unknown>).wasteThresholdPct)
      : NaN;
  return {
    wasteThresholdPct:
      Number.isFinite(wasteRaw) && wasteRaw > 0 ? wasteRaw : defaultAppSettings.wasteThresholdPct,
  };
}

/** Сохранение общих параметров (A20). Только админ. */
export async function saveAppSettings(input: AppSettings): Promise<{ ok: true }> {
  const admin = await requireAdmin();
  const waste = Number(input.wasteThresholdPct);
  if (!Number.isFinite(waste) || waste <= 0) {
    throw new Error("Некорректный порог отхода");
  }
  const value = { wasteThresholdPct: waste };
  await prisma.setting.upsert({
    where: { key: APP_SETTINGS_KEY },
    create: { key: APP_SETTINGS_KEY, value },
    update: { value },
  });
  await writeChangeLog({
    entity: "Setting",
    entityId: APP_SETTINGS_KEY,
    userId: admin.id,
    newValues: value,
  });

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Мин. остатки для сигнала на дашборде (A20). Раньше редактор в настройках был
 * на моке — реальные поля `minStock` живут per-entity в Product/Detail/
 * NomenclatureItem. Собираем активные позиции всех трёх типов в единый список.
 */
export async function getMinStockRows(): Promise<MinStockRow[]> {
  await requireAdmin();
  const [products, details, nomenclature] = await Promise.all([
    prisma.product.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, minStock: true },
      orderBy: { name: "asc" },
    }),
    prisma.detail.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, minStock: true },
      orderBy: { name: "asc" },
    }),
    prisma.nomenclatureItem.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true, minStock: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const rows: MinStockRow[] = [
    ...products.map((p) => ({ id: p.id, kind: "PRODUCT" as MinStockKind, name: p.name, minStock: p.minStock ?? 0 })),
    ...details.map((d) => ({ id: d.id, kind: "DETAIL" as MinStockKind, name: d.name, minStock: d.minStock ?? 0 })),
    ...nomenclature.map((n) => ({ id: n.id, kind: "NOMENCLATURE" as MinStockKind, name: n.name, minStock: n.minStock ?? 0 })),
  ];
  return rows;
}

/**
 * Сохранение мин. остатков (A20). Пишет в реальное поле minStock нужной таблицы
 * по kind. 0/пусто → null (сигнал выключен). Только админ, атомарно.
 */
export async function saveMinStock(
  rows: { kind: MinStockKind; id: string; minStock: number }[],
): Promise<{ ok: true }> {
  const admin = await requireAdmin();
  await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      const n = Number(r.minStock);
      const minStock = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      if (r.kind === "PRODUCT") {
        await tx.product.update({ where: { id: r.id }, data: { minStock } });
      } else if (r.kind === "DETAIL") {
        await tx.detail.update({ where: { id: r.id }, data: { minStock } });
      } else {
        await tx.nomenclatureItem.update({ where: { id: r.id }, data: { minStock } });
      }
    }
    await writeChangeLog(
      { entity: "MinStock", entityId: "bulk", userId: admin.id, newValues: { count: rows.length } },
      tx,
    );
  });

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { ok: true };
}
