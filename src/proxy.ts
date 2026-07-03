import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, decryptSession } from "@/lib/session";

// Оптимистичная защита маршрутов: проверяем только подпись cookie-сессии
// (без БД). Основной гейт — requireAdmin() в layout группы (admin) и проверки
// в мутациях; здесь лишь быстрый редирект неаутентифицированных.
const PUBLIC_PATHS = ["/login", "/terminal"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await decryptSession(token);

  if (!session && !isPublic) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (session && pathname === "/login") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Исключаем API, статику, оптимизацию картинок и метафайлы.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg|sitemap.xml|robots.txt).*)"],
};
