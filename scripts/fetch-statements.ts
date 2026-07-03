/**
 * Приём банковских выписок из почтового ящика (IMAP) — запуск вручную/локально.
 *
 *   npx tsx scripts/fetch-statements.ts
 *
 * В ПРОДЕ приём идёт через cron-эндпойнт /api/cron/fetch-statements (см.
 * DEPLOY-STATUS.md): он работает на собранном образе и не требует src/tsx.
 * Этот скрипт удобен для локальной проверки из репозитория.
 *
 * Конфиг — через переменные окружения (см. .env.deploy.example):
 *   MAIL_IMAP_HOST, MAIL_IMAP_PORT, MAIL_IMAP_USER, MAIL_IMAP_PASSWORD,
 *   MAIL_IMAP_SECURE, MAIL_ALLOWED_SENDERS, MAIL_MARK_SEEN, MAIL_IMAP_MAILBOX.
 *
 * Если обязательные MAIL_* не заданы — приём отключён (скрипт молча выходит с 0).
 */
import { readMailConfig, runMailIntakeAndLog } from "../src/server/statement-mail";

async function main() {
  if (!readMailConfig()) {
    console.log("MAIL_* не заданы — приём выписок с почты отключён.");
    process.exit(0);
  }

  const res = await runMailIntakeAndLog();
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
