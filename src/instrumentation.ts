// Регистрация серверных/edge-конфигураций Sentry и хук ошибок запросов.
// Инициализация внутри конфигов активируется только при заданном SENTRY_DSN.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
