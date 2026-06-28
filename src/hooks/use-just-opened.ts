import { useState } from "react";

/**
 * Возвращает `true` ровно в том рендере, когда `open` сменился с false на true.
 * Замена `useEffect`-сброса формы при открытии диалога (без set-state-in-effect):
 *
 * ```ts
 * if (useJustOpened(open)) {
 *   setName("");
 *   // ...сброс полей
 * }
 * ```
 *
 * setState внутри `if` выполняется в фазе рендера — это санкционированный React
 * паттерн «корректировка стейта при смене пропа», не вызывает каскадных эффектов.
 */
export function useJustOpened(open: boolean): boolean {
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    return open;
  }
  return false;
}
