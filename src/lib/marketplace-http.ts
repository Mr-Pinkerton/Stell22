/** Общий HTTP-слой для вызовов API маркетпейсов (таймаут, ошибки). */

export class MarketplaceApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "MarketplaceApiError";
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new MarketplaceApiError(
        `HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`,
        res.status,
        text,
      );
    }
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof MarketplaceApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new MarketplaceApiError(`Таймаут запроса (${timeoutMs} мс)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Результат fetch с предупреждениями (лимиты, частичные данные). */
export interface MpFetchResult<T> {
  data: T;
  warnings: string[];
}
