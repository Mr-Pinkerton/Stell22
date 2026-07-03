// Идемпотентно задаёт email и пароль администратора в текущей БД без сброса
// данных. Админ определяется фиксированным id "user-admin", поэтому смена
// email обновляет ту же запись (а не плодит второго админа).
//
// Использование:
//   npx tsx scripts/set-admin-password.ts <пароль>
//   npx tsx scripts/set-admin-password.ts <email> <пароль>
//
// Пароль по умолчанию — SEED_ADMIN_PASSWORD или "admin123".
// Email по умолчанию — ADMIN_EMAIL или "admin@stell22.local".

import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient();

const DEFAULT_EMAIL = process.env.ADMIN_EMAIL ?? "admin@stell22.local";

/** Разбор аргументов: (email, пароль) либо только (пароль). */
function parseArgs(): { email: string; password: string } {
  const args = process.argv.slice(2);
  const looksLikeEmail = (s: string) => /.+@.+\..+/.test(s);

  if (args.length >= 2) {
    return { email: args[0].trim(), password: args[1] };
  }
  if (args.length === 1 && looksLikeEmail(args[0])) {
    // Передали только email — пароль из env или дефолт.
    return { email: args[0].trim(), password: process.env.SEED_ADMIN_PASSWORD ?? "admin123" };
  }
  return {
    email: DEFAULT_EMAIL,
    password: args[0] ?? process.env.SEED_ADMIN_PASSWORD ?? "admin123",
  };
}

async function main() {
  const { email, password } = parseArgs();
  const passwordHash = await hashPassword(password);

  // Если email занят другим пользователем (не нашим админом) — не затираем.
  const clash = await prisma.user.findFirst({
    where: { email, id: { not: "user-admin" } },
    select: { id: true },
  });
  if (clash) {
    throw new Error(`Email ${email} уже занят другим пользователем (id=${clash.id}).`);
  }

  await prisma.user.upsert({
    where: { id: "user-admin" },
    update: { email, passwordHash },
    create: {
      id: "user-admin",
      email,
      passwordHash,
      name: "Администратор",
      role: "ADMIN",
    },
  });

  console.log(`Администратор обновлён: ${email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
