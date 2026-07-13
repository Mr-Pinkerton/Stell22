// Ключ идемпотентности запроса терминала (A21). crypto.randomUUID доступен
// только в secure context (https/localhost), а терминал может открываться по
// http в локальной сети — поэтому есть фолбэк.
export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
