// Идемпотентно задаёт пароль администратора в текущей БД без сброса данных.
// Использование: npx tsx scripts/set-admin-password.ts [пароль]
// Пароль по умолчанию — SEED_ADMIN_PASSWORD или "admin123".

import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";

const prisma = new PrismaClient();

async function main() {
  const password = process.argv[2] ?? process.env.SEED_ADMIN_PASSWORD ?? "admin123";
  const passwordHash = await hashPassword(password);

  await prisma.user.upsert({
    where: { email: "admin@stell22.local" },
    update: { passwordHash },
    create: {
      id: "user-admin",
      email: "admin@stell22.local",
      passwordHash,
      name: "Администратор",
      role: "ADMIN",
    },
  });

  console.log("Пароль администратора обновлён (admin@stell22.local).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
