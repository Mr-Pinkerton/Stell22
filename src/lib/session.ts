import { SignJWT, jwtVerify } from "jose";

// Сессия без состояния: подписанный JWT в httpOnly-cookie. Секрет — из env.
export const SESSION_COOKIE = "stell22_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7; // 7 дней

export interface SessionPayload {
  userId: string;
  role: string;
}

function encodedKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET не задан в окружении (.env)");
  }
  return new TextEncoder().encode(secret);
}

export async function encryptSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ userId: payload.userId, role: payload.role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(encodedKey());
}

export async function decryptSession(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, encodedKey(), { algorithms: ["HS256"] });
    if (typeof payload.userId !== "string" || typeof payload.role !== "string") return null;
    return { userId: payload.userId, role: payload.role };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_MAX_AGE_SEC,
};

// --------------------------- Терминал (киоск) ------------------------------
// Отдельная сессия для терминала производства: вход по PIN сотрудника ставит
// подписанную cookie, а серверные операции (submit*/reverse*) проверяют её
// (A14). Живёт короче — одна смена, автовыход по бездействию на клиенте.
export const TERMINAL_COOKIE = "stell22_terminal";
export const TERMINAL_MAX_AGE_SEC = 60 * 60 * 12; // 12 часов (смена)

export interface TerminalSessionPayload {
  employeeId: string;
}

export async function encryptTerminalSession(
  payload: TerminalSessionPayload,
): Promise<string> {
  return new SignJWT({ employeeId: payload.employeeId, kind: "terminal" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TERMINAL_MAX_AGE_SEC}s`)
    .sign(encodedKey());
}

export async function decryptTerminalSession(
  token: string | undefined,
): Promise<TerminalSessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, encodedKey(), { algorithms: ["HS256"] });
    if (payload.kind !== "terminal" || typeof payload.employeeId !== "string") return null;
    return { employeeId: payload.employeeId };
  } catch {
    return null;
  }
}

export const terminalCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: TERMINAL_MAX_AGE_SEC,
};
