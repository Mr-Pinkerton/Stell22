// Ключ идемпотентности запроса терминала (A21). crypto.randomUUID доступен
// только в secure context (https/localhost), а терминал может открываться по
// http в локальной сети — поэтому есть фолбэк.
export const CLIENT_REQUEST_ID_MAX_LENGTH = 128;
export const CLIENT_REQUEST_ID_REQUIRED = "Не указан ключ попытки операции";
export const CLIENT_REQUEST_ID_TOO_LONG = "Слишком длинный ключ попытки операции";

export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function requireClientRequestId(value: unknown): string {
  if (typeof value !== "string") throw new Error(CLIENT_REQUEST_ID_REQUIRED);
  const id = value.trim();
  if (!id) throw new Error(CLIENT_REQUEST_ID_REQUIRED);
  if (id.length > CLIENT_REQUEST_ID_MAX_LENGTH) {
    throw new Error(CLIENT_REQUEST_ID_TOO_LONG);
  }
  return id;
}
