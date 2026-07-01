import { prisma } from "../src/server/db";
import { SETTING_PREFIX } from "../src/lib/api-credentials";

const BIT_LABELS: Record<number, string> = {
  1: "Контент",
  2: "Аналитика",
  3: "Цены и скидки",
  4: "Маркетплейс",
  5: "Статистика",
  6: "Продвижение",
  7: "Вопросы и отзывы",
  10: "Поставки",
  30: "Только чтение",
};

function decodeScopes(mask: number): string[] {
  const scopes: string[] = [];
  for (const [bit, label] of Object.entries(BIT_LABELS)) {
    if (mask & (1 << Number(bit))) scopes.push(label);
  }
  return scopes;
}

async function main() {
  const row = await prisma.setting.findUnique({
    where: { key: `${SETTING_PREFIX}wb.token` },
  });
  const token = typeof row?.value === "string" ? row.value.trim() : "";
  if (!token) {
    console.log("Токен не найден");
    process.exit(1);
  }

  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as {
    exp?: number;
    s?: number;
    sid?: string;
    t?: boolean;
  };

  const exp = payload.exp ? new Date(payload.exp * 1000).toLocaleString("ru-RU") : "?";
  const scopes = payload.s != null ? decodeScopes(payload.s) : [];
  console.log("Действует до:", exp);
  console.log("Тестовый контур:", payload.t ? "да" : "нет");
  console.log("Категории:", scopes.length ? scopes.join(", ") : "(не удалось разобрать)");
  console.log(
    "Для синхронизации нужны: Статистика, Аналитика —",
    scopes.includes("Статистика") && scopes.includes("Аналитика") ? "OK" : "НЕ ХВАТАЕТ",
  );

  await prisma.$disconnect();
}

main();
