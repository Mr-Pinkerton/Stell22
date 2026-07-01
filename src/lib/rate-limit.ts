/**
 * In-memory rate-limiter для защиты /login от перебора.
 * Работает корректно только при одном инстансе приложения (см. DEPLOY.md).
 * Для горизонтального масштабирования вынести состояние в Redis.
 */

export interface RateLimiterOptions {
  /** Порог неудачных попыток в окне, после которого включается блокировка. */
  maxAttempts: number;
  /** Окно подсчёта попыток, мс. */
  windowMs: number;
  /** Длительность блокировки после превышения порога, мс. */
  lockoutMs: number;
  /** Источник времени (для тестов). */
  now?: () => number;
}

export interface RateLimitCheck {
  blocked: boolean;
  /** Сколько мс до разблокировки (0, если не заблокирован). */
  retryAfterMs: number;
}

interface Entry {
  count: number;
  windowStart: number;
  lockedUntil?: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;

  constructor(opts: RateLimiterOptions) {
    this.maxAttempts = opts.maxAttempts;
    this.windowMs = opts.windowMs;
    this.lockoutMs = opts.lockoutMs;
    this.now = opts.now ?? Date.now;
  }

  /** Проверить, не заблокирован ли ключ. Вызывать до проверки пароля. */
  check(key: string): RateLimitCheck {
    const entry = this.entries.get(key);
    if (!entry) return { blocked: false, retryAfterMs: 0 };

    const now = this.now();
    if (entry.lockedUntil !== undefined) {
      if (entry.lockedUntil > now) {
        return { blocked: true, retryAfterMs: entry.lockedUntil - now };
      }
      // Блокировка истекла — сбрасываем состояние.
      this.entries.delete(key);
    }
    return { blocked: false, retryAfterMs: 0 };
  }

  /** Зафиксировать неудачную попытку. Возвращает состояние после учёта. */
  recordFailure(key: string): RateLimitCheck {
    const now = this.now();
    let entry = this.entries.get(key);

    if (!entry || now - entry.windowStart > this.windowMs) {
      entry = { count: 0, windowStart: now };
    }

    entry.count += 1;
    if (entry.count >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
    }
    this.entries.set(key, entry);

    if (entry.lockedUntil !== undefined && entry.lockedUntil > now) {
      return { blocked: true, retryAfterMs: entry.lockedUntil - now };
    }
    return { blocked: false, retryAfterMs: 0 };
  }

  /** Успешный вход — снять счётчик для ключа. */
  reset(key: string): void {
    this.entries.delete(key);
  }
}

/** Округление мс до секунд вверх — для сообщения пользователю. */
export function retryAfterSeconds(ms: number): number {
  return Math.ceil(ms / 1000);
}
