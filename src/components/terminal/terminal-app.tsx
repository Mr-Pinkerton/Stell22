"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { dataProvider } from "@/lib/data-provider";
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

export function TerminalApp() {
  const [data, setData] = useState<TerminalData | null>(null);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [screen, setScreen] = useState<TerminalScreen>("home");

  useEffect(() => {
    let alive = true;
    Promise.all([
      dataProvider.getEmployees(),
      dataProvider.getBatches(),
      dataProvider.getRailLots(),
      dataProvider.getDetails(),
      dataProvider.getProducts(),
      dataProvider.getNomenclature(),
      dataProvider.getStock(),
    ]).then(([employees, batches, railLots, details, products, nomenclature, stock]) => {
      if (alive) setData({ employees, batches, railLots, details, products, nomenclature, stock });
    });
    return () => {
      alive = false;
    };
  }, []);

  const logout = useCallback(() => {
    setEmployee(null);
    setScreen("home");
    setLoginOpen(false);
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

  if (!data) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center">
        <span className="text-muted-foreground text-sm">Загрузка терминала…</span>
      </div>
    );
  }

  const inOperation = employee != null && screen !== "home";

  return (
    <div className="bg-background flex min-h-screen flex-col touch-manipulation">
      <TerminalHeader
        employee={employee}
        title={loginOpen && !employee ? "Вход в терминал" : TITLES[screen]}
        onBack={inOperation ? () => setScreen("home") : null}
        onLoginClick={() => setLoginOpen(true)}
        onLogout={logout}
      />

      {!employee ? (
        loginOpen ? (
          <LoginScreen
            employees={data.employees}
            onSuccess={(e) => {
              setEmployee(e);
              setLoginOpen(false);
              setScreen("home");
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <p className="text-muted-foreground text-center text-sm">
              Войдите, чтобы начать работу с терминалом
            </p>
          </div>
        )
      ) : screen === "home" ? (
        <HomeScreen employees={data.employees} employee={employee} onSelect={setScreen} />
      ) : screen === "torcovka" ? (
        <TorcovkaScreen data={data} onDone={() => setScreen("home")} />
      ) : screen === "prisadka" ? (
        <PrisadkaScreen data={data} onDone={() => setScreen("home")} />
      ) : screen === "upakovka" ? (
        <UpakovkaScreen data={data} onDone={() => setScreen("home")} />
      ) : (
        <HoursScreen employee={employee} onDone={() => setScreen("home")} />
      )}
      <TerminalToaster />
    </div>
  );
}
