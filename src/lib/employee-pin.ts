// Правила PIN сотрудника. Вход в терминал выполняется ТОЛЬКО по PIN (работник
// не выбирает себя из списка), поэтому PIN — единственный идентификатор:
// у активного сотрудника он обязателен, строго 4 цифры и уникален среди
// активных. Уникальность держим валидацией на сервере (не constraint в БД),
// см. решение A3 в задаче «вход по PIN».
//
// Чистые функции — чтобы правила тестировались без БД и переиспользовались
// и в админке (сохранение сотрудника), и в терминале (вход).

const PIN_PATTERN = /^\d{4}$/;

/** Формат PIN: ровно 4 цифры. Ведущий ноль допустим («0123»). */
export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

export type PinValidationError = "required" | "format" | "duplicate";

/** Активный сотрудник как владелец PIN (для проверки уникальности). */
export interface PinOwner {
  id: string;
  pin: string;
}

/**
 * Проверка PIN для сотрудника, который будет ACTIVE (создание, правка
 * активного, возврат из архива). `activeEmployees` — все активные сотрудники;
 * сам проверяемый исключается по `selfId`, чтобы правка без смены PIN не
 * ловила саму себя. Для ARCHIVED правила не применяются: архивный сотрудник
 * в терминал не входит, но при возврате в ACTIVE проверка будет повторена.
 */
export function validateActivePin(input: {
  pin: string;
  selfId?: string | null;
  activeEmployees: PinOwner[];
}): PinValidationError | null {
  const pin = input.pin.trim();
  if (!pin) return "required";
  if (!isValidPin(pin)) return "format";

  const taken = input.activeEmployees.some((e) => e.id !== input.selfId && e.pin === pin);
  return taken ? "duplicate" : null;
}

/** Текст ошибки для админки (сотрудник виден только администратору). */
export function pinErrorMessage(error: PinValidationError): string {
  switch (error) {
    case "required":
      return "Укажите PIN-код: он нужен для входа в терминал";
    case "format":
      return "PIN-код — ровно 4 цифры";
    case "duplicate":
      return "Этот PIN-код уже занят другим активным сотрудником";
  }
}
