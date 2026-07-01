// Инициализация Sentry для серверного (Node.js) рантайма.
// Активна только если задан SENTRY_DSN — иначе полностью выключена.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    // Не отправляем тела запросов/PII по умолчанию.
    sendDefaultPii: false,
  });
}
