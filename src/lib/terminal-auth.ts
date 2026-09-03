// Опознание сотрудника по PIN при входе в терминал. Работник не выбирает себя
// из списка — терминал определяет его по введённому коду (A14: проверка только
// на сервере, PIN клиенту не отдаётся).
//
// Чистая функция — решение вынесено из server-action, чтобы разбор случаев
// «никто / один / несколько» тестировался без БД и cookie.

import { isValidPin } from "@/lib/employee-pin";

export interface PinCandidate {
  id: string;
  pin: string;
  status: string; // "ACTIVE" | "ARCHIVED" | ...
}

export type PinLookup =
  /** Ровно один активный сотрудник с этим PIN — пускаем. */
  | { kind: "ok"; employeeId: string }
  /** Никто не подошёл (нет такого PIN / неверный формат / только архивные). */
  | { kind: "none" }
  /** Нарушен инвариант уникальности: PIN у нескольких активных — не пускаем. */
  | { kind: "collision"; employeeIds: string[] };

/**
 * Кого пускать по введённому PIN. `candidates` — записи, найденные в БД по этому
 * PIN (запрашивать максимум 2: одной хватает для входа, вторая доказывает
 * коллизию). Статус и формат перепроверяются здесь же, чтобы функция была
 * самодостаточной и не зависела от правильности внешнего запроса.
 */
export function resolvePinLookup(pin: string, candidates: PinCandidate[]): PinLookup {
  if (!isValidPin(pin)) return { kind: "none" };

  const matched = candidates.filter((c) => c.status === "ACTIVE" && c.pin === pin);
  if (matched.length === 0) return { kind: "none" };
  if (matched.length > 1) return { kind: "collision", employeeIds: matched.map((c) => c.id) };
  return { kind: "ok", employeeId: matched[0]!.id };
}
