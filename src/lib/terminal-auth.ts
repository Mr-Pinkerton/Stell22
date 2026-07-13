// Проверка PIN сотрудника для входа в терминал (A14). Чистая функция —
// сравнение вынесено из server-action, чтобы тестировать без БД/cookie.

export interface PinCandidate {
  pin: string;
  status: string; // "ACTIVE" | "ARCHIVED" | ...
}

/**
 * PIN подходит, только если сотрудник ACTIVE и введён ровно его 4-значный PIN.
 * Пустой/короткий PIN и архивные сотрудники — всегда отказ.
 */
export function verifyEmployeePin(employee: PinCandidate | null, pin: string): boolean {
  if (!employee) return false;
  if (employee.status !== "ACTIVE") return false;
  if (!/^\d{4}$/.test(pin)) return false;
  return employee.pin === pin;
}
