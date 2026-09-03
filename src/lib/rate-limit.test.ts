import { describe, expect, it } from "vitest";
import { RateLimiter, retryAfterSeconds } from "./rate-limit";

function fixedClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("RateLimiter", () => {
  it("не блокирует до достижения порога", () => {
    const clock = fixedClock();
    const rl = new RateLimiter({ maxAttempts: 3, windowMs: 10_000, lockoutMs: 60_000, now: clock.now });

    expect(rl.check("ip").blocked).toBe(false);
    expect(rl.recordFailure("ip").blocked).toBe(false);
    expect(rl.recordFailure("ip").blocked).toBe(false);
    expect(rl.check("ip").blocked).toBe(false);
  });

  it("блокирует по достижении порога на время lockout", () => {
    const clock = fixedClock();
    const rl = new RateLimiter({ maxAttempts: 3, windowMs: 10_000, lockoutMs: 60_000, now: clock.now });

    rl.recordFailure("ip");
    rl.recordFailure("ip");
    const third = rl.recordFailure("ip");

    expect(third.blocked).toBe(true);
    expect(third.retryAfterMs).toBe(60_000);
    expect(rl.check("ip").blocked).toBe(true);
  });

  it("разблокирует после истечения lockout", () => {
    const clock = fixedClock();
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 10_000, lockoutMs: 60_000, now: clock.now });

    rl.recordFailure("ip");
    rl.recordFailure("ip");
    expect(rl.check("ip").blocked).toBe(true);

    clock.advance(60_001);
    expect(rl.check("ip").blocked).toBe(false);
  });

  it("после истечения lockout старые failures не дают мгновенную повторную блокировку (паттерн терминала: check → recordFailure)", () => {
    // Параметры PIN-терминала: 10 попыток / 5 мин / блок 1 мин.
    const clock = fixedClock();
    const rl = new RateLimiter({
      maxAttempts: 10,
      windowMs: 5 * 60 * 1000,
      lockoutMs: 60 * 1000,
      now: clock.now,
    });

    for (let i = 0; i < 10; i++) rl.recordFailure("terminal");
    expect(rl.check("terminal").blocked).toBe(true);

    // Блокировка истекла — следующая попытка входа сначала вызывает check().
    clock.advance(60_001);
    expect(rl.check("terminal").blocked).toBe(false);

    // Одна неудача после разблокировки — счётчик с нуля, не мгновенный re-lock.
    const afterUnlock = rl.recordFailure("terminal");
    expect(afterUnlock.blocked).toBe(false);

    // Ещё 8 неудач — всё ещё ниже порога 10.
    for (let i = 0; i < 8; i++) {
      expect(rl.recordFailure("terminal").blocked).toBe(false);
    }
    expect(rl.check("terminal").blocked).toBe(false);

    // 10-я неудача после разблокировки снова блокирует на 1 мин.
    expect(rl.recordFailure("terminal").blocked).toBe(true);
  });

  it("сбрасывает счётчик, если окно истекло без блокировки", () => {
    const clock = fixedClock();
    const rl = new RateLimiter({ maxAttempts: 3, windowMs: 10_000, lockoutMs: 60_000, now: clock.now });

    rl.recordFailure("ip");
    rl.recordFailure("ip");
    clock.advance(10_001);
    // Новое окно — снова с нуля, до порога не доходит.
    expect(rl.recordFailure("ip").blocked).toBe(false);
    expect(rl.recordFailure("ip").blocked).toBe(false);
    expect(rl.check("ip").blocked).toBe(false);
  });

  it("reset снимает блокировку (успешный вход)", () => {
    const clock = fixedClock();
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 10_000, lockoutMs: 60_000, now: clock.now });

    rl.recordFailure("ip");
    rl.recordFailure("ip");
    expect(rl.check("ip").blocked).toBe(true);

    rl.reset("ip");
    expect(rl.check("ip").blocked).toBe(false);
  });

  it("ключи независимы", () => {
    const clock = fixedClock();
    const rl = new RateLimiter({ maxAttempts: 2, windowMs: 10_000, lockoutMs: 60_000, now: clock.now });

    rl.recordFailure("a");
    rl.recordFailure("a");
    expect(rl.check("a").blocked).toBe(true);
    expect(rl.check("b").blocked).toBe(false);
  });
});

describe("retryAfterSeconds", () => {
  it("округляет вверх до секунд", () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1000)).toBe(1);
    expect(retryAfterSeconds(1001)).toBe(2);
    expect(retryAfterSeconds(59_000)).toBe(59);
  });
});
