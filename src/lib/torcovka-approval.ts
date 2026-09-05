import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { TIME_ZONE } from "@/lib/format";

export const TORCOVKA_APPROVAL_TTL_MS = 10 * 60 * 1000;
export const TORCOVKA_APPROVAL_MAX_ATTEMPTS = 5;

export const TORCOVKA_WRONG_CODE_MESSAGE = "Неверный код подтверждения";
export const TORCOVKA_APPROVAL_OWNER_MISMATCH =
  "Операция принадлежит другому работнику";
export const TORCOVKA_CODE_ROTATED_MESSAGE =
  "Старый код больше не действует. Запросите новый код у администратора.";
export const TORCOVKA_APPROVAL_CONSUMED_ORPHAN =
  "Нарушение целостности: подтверждение использовано, операция не найдена";

export function generateApprovalCode(): string {
  return String(randomInt(0, 10000)).padStart(4, "0");
}

export function parseApprovalCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.trim();
  if (!/^\d{4}$/.test(d)) return null;
  return d;
}

export function hashApprovalCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(code, "utf8").digest("hex");
}

export function approvalCodeMatches(code: string, codeHash: string, secret: string): boolean {
  try {
    const a = Buffer.from(hashApprovalCode(code, secret), "hex");
    const b = Buffer.from(codeHash, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Rotate until HMAC differs from the previous approval-row hash (SoT). */
export function generateUnusedApprovalCode(existingHash: string, secret: string): string {
  let code: string;
  do {
    code = generateApprovalCode();
  } while (approvalCodeMatches(code, existingHash, secret));
  return code;
}

export function approvalHmacSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET не задан в окружении (.env)");
  }
  return secret;
}

export function torcovkaApprovalNotificationKey(
  clientRequestId: string,
  generation: number,
): string {
  return `event:torcovka-approval:${clientRequestId}:${generation}`;
}

export function formatApprovalExpiryClock(expiresAt: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(expiresAt);
}

export function formatTorcovkaApprovalMessage(input: {
  employeeName: string;
  batchName: string;
  lotLabel: string;
  railsTaken: number;
  takenM: string;
  producedM: string;
  wasteM: string;
  wastePct: string;
  code: string;
  expiresAt: Date;
}): string {
  const until = formatApprovalExpiryClock(input.expiresAt);
  return [
    `Сотрудник: ${input.employeeName}`,
    `Партия: ${input.batchName}`,
    `Пакет: ${input.lotLabel}`,
    `Взято реек: ${input.railsTaken}`,
    `Вход: ${input.takenM} м`,
    `Выход: ${input.producedM} м`,
    `Отход: ${input.wasteM} м (${input.wastePct}%)`,
    `Код подтверждения: ${input.code}`,
    `Действует до ${until}`,
  ].join("\n");
}
