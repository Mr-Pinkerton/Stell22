import { prisma } from "@/server/db";

// Prisma требует Node.js-рантайм (не Edge); ответ не кэшируем.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Health-check для супервизора/LB. Проверяет живость процесса и коннект к БД.
 * 200 — всё ок; 503 — БД недоступна.
 */
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", db: "up", time: new Date().toISOString() });
  } catch {
    return Response.json(
      { status: "error", db: "down", time: new Date().toISOString() },
      { status: 503 },
    );
  }
}
