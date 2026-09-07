/** Синхронный клиентский замок на повторный тап submit (не идемпотентность сервера). */

export function beginExclusiveSubmit(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function endExclusiveSubmit(lock: { current: boolean }): void {
  lock.current = false;
}
