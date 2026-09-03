"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getTerminalData, terminalLogout } from "@/server/terminal";
import type { Employee } from "@/types/domain";
import type { TerminalData, TerminalScreen } from "@/components/terminal/types";
import { TerminalHeader } from "@/components/terminal/terminal-header";
import { LoginScreen } from "@/components/terminal/login-screen";
import { HomeScreen } from "@/components/terminal/home-screen";
import { TorcovkaScreen } from "@/components/terminal/torcovka-screen";
import { PrisadkaScreen } from "@/components/terminal/prisadka-screen";
import { UpakovkaScreen } from "@/components/terminal/upakovka-screen";
import { HoursScreen } from "@/components/terminal/hours-screen";
import { TerminalToaster } from "@/components/terminal/terminal-toaster";

const IDLE_MS = 30_000; // автовыход по бездействию

const TITLES: Record<TerminalScreen, string> = {
  home: "Терминал производства",
  torcovka: "Торцовка",
  prisadka: "Присадка",
  upakovka: "Упаковка",
  hours: "Рабочие часы",
};

export function TerminalApp({ initialData }: { initialData: TerminalData }) {
  const [data, setData] = useState<TerminalData>(initialData);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [screen, setScreen] = useState<TerminalScreen>("home");

  // Перечитать данные после операции (изменились остатки/склад).
  const refresh = useCallback(async () => {
    setData(await getTerminalData());
  }, []);

  const handleOperationDone = useCallback(async () => {
    await refresh();
    setScreen("home");
  }, [refresh]);

  const logout = useCallback(() => {
    setEmployee(null);
    setScreen("home");
    void terminalLogout(); // A14: снять серверную сессию терминала
  }, []);

  // Автовыход по бездействию: сбрасываем таймер на любую активность.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!employee) return;
    const reset = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(logout, IDLE_MS);
    };
    const events = ["pointerdown", "keydown", "pointermove"] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [employee, logout]);

  const inOperation = employee != null && screen !== "home";

  return (
    <div className="bg-background flex min-h-screen flex-col touch-manipulation">
      <TerminalHeader
        employee={employee}
        title={!employee ? "Вход в терминал" : TITLES[screen]}
        onBack={inOperation ? () => setScreen("home") : null}
        onLogout={logout}
      />

      {!employee ? (
        // Терминал сразу встречает вводом PIN — отдельного шага «Войти» нет.
        <LoginScreen
          onSuccess={(e) => {
            setEmployee(e);
            setScreen("home");
          }}
        />
      ) : screen === "home" ? (
        <HomeScreen employees={data.employees} employee={employee} onSelect={setScreen} />
      ) : screen === "torcovka" ? (
        <TorcovkaScreen data={data} employee={employee} onDone={handleOperationDone} />
      ) : screen === "prisadka" ? (
        <PrisadkaScreen data={data} employee={employee} onDone={handleOperationDone} />
      ) : screen === "upakovka" ? (
        <UpakovkaScreen data={data} employee={employee} onDone={handleOperationDone} />
      ) : (
        <HoursScreen employee={employee} onDone={handleOperationDone} />
      )}
      <TerminalToaster />
    </div>
  );
}
