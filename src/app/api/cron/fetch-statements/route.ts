import { createHash, timingSafeEqual } from "node:crypto";
import { readMailConfig, runMailIntakeAndLog } from "@/server/statement-mail";

// IMAP + Prisma требуют Node.js-рантайм (не Edge); ответ не кэшируем.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Приём выписок с почты может идти дольше стандартного лимита.
export const maxDuration = 300;

/**
 * Сравнение секрета за постоянное время (защита от timing-атак). Хэшируем оба
 * значения в фиксированную длину, чтобы не утекала и длина токена.
 */
function secretsEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Приём банковских выписок с почты по расписанию. Вызывается host-cron через
 * curl (см. DEPLOY-STATUS.md). Защищён секретом CRON_SECRET — без него эндпойнт
 * отключён (503), чтобы наружу нельзя было запустить приём.
 *
 *   curl -fsS -m 300 -X POST \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     https://stell22.ru/api/cron/fetch-statements
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return Response.json({ error: "CRON_SECRET не задан — эндпойнт отключён" }, { status: 503 });
  }

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!provided || !secretsEqual(provided, secret)) {
    return Response.json({ error: "Неавторизовано" }, { status: 401 });
  }

  if (!readMailConfig()) {
    return Response.json({ ok: true, disabled: true, reason: "MAIL_* не заданы" });
  }

  const result = await runMailIntakeAndLog();
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
