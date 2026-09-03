"use client";

import { useRef, useState } from "react";
import { toast } from "@/components/terminal/toast";
import { terminalLoginByPin } from "@/server/terminal";
import { KEYPAD_PANEL } from "@/components/terminal/keypad-panel";
import { NumericKeypad } from "@/components/terminal/numeric-keypad";
import type { Employee } from "@/types/domain";

const PIN_LENGTH = 4;

interface LoginScreenProps {
  onSuccess: (employee: Employee) => void;
}

/**
 * Вход в терминал: сразу ввод PIN, без выбора ФИО — сотрудника определяет
 * сервер по коду (`terminalLoginByPin`). Список работников для входа не нужен.
 */
export function LoginScreen({ onSuccess }: LoginScreenProps) {
  const [pin, setPin] = useState("");
  // Блокируем повторную отправку, пока идёт проверка (двойной тап по 4-й цифре).
  const checking = useRef(false);

  const submit = (next: string) => {
    setPin(next);
    if (next.length !== PIN_LENGTH || checking.current) return;

    checking.current = true;
    void (async () => {
      try {
        const employee = await terminalLoginByPin(next);
        const parts = employee.fullName.split(" ");
        const firstName = parts[1] ?? parts[0];
        toast.success(`Здравствуйте, ${firstName}!`);
        onSuccess(employee);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Неверный PIN");
        setPin("");
      } finally {
        checking.current = false;
      }
    })();
  };

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <div className={KEYPAD_PANEL}>
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Введите PIN-код</h1>
          <p className="text-muted-foreground text-base">Терминал узнает вас по коду</p>
        </div>

        <div className="flex justify-center gap-4">
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span
              key={i}
              className={"size-5 rounded-full " + (i < pin.length ? "bg-brand" : "bg-muted")}
            />
          ))}
        </div>

        {/* allowLeadingZeros: PIN «0123» — валидный код. */}
        <NumericKeypad value={pin} onChange={submit} maxLength={PIN_LENGTH} allowLeadingZeros />
      </div>
    </main>
  );
}
