"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getTerminalData, terminalLogout } from "@/server/terminal";
import type {
  TerminalData,
  TerminalEmployee,
  TerminalScreen,
} from "@/components/terminal/types";
import { TerminalHeader } from "@/components/terminal/terminal-header";
import { LoginScreen } from "@/components/terminal/login-screen";
import { HomeScreen } from "@/components/terminal/home-screen";
import { TorcovkaScreen } from "@/components/terminal/torcovka-screen";
import { PrisadkaScreen } from "@/components/terminal/prisadka-screen";
import { UpakovkaScreen } from "@/components/terminal/upakovka-screen";
import { HoursScreen } from "@/components/terminal/hours-screen";
import { TerminalToaster } from "@/components/terminal/terminal-toaster";
import { TerminalDraftResumeDialog } from "@/components/terminal/terminal-draft-resume-dialog";
import {
  clearDraft,
  readDraft,
  type DraftParseFailReason,
  type TerminalDraftOperation,
  type TerminalDraftV1,
} from "@/lib/terminal-draft-storage";

const IDLE_MS = 5 * 60 * 1000; // автовыход после 5 минут бездействия

const TITLES: Record<TerminalScreen, string> = {
  home: "Терминал производства",
  torcovka: "Торцовка",
  prisadka: "Присадка",
  upakovka: "Упаковка",
  hours: "Рабочие часы",
};

const SCREEN_BY_OPERATION: Record<TerminalDraftOperation, Exclude<TerminalScreen, "home">> = {
  TORCOVKA: "torcovka",
  PRISADKA: "prisadka",
  UPAKOVKA: "upakovka",
  HOURS: "hours",
};

function browserStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function TerminalApp() {
  const [data, setData] = useState<TerminalData | null>(null);
  const [employee, setEmployee] = useState<TerminalEmployee | null>(null);
  const [screen, setScreen] = useState<TerminalScreen>("home");
  const [loading, setLoading] = useState(false);
  const [resumeDraft, setResumeDraft] = useState<TerminalDraftV1 | null>(null);
  const [resumeError, setResumeError] = useState<DraftParseFailReason | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [pendingScreen, setPendingScreen] = useState<TerminalScreen | null>(null);
  const sessionGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = sessionGeneration.current;
    const next = await getTerminalData();
    if (generation !== sessionGeneration.current) return;
    setData(next);
    setEmployee(next.currentEmployee);
  }, []);

  const handleOperationDone = useCallback(async () => {
    await refresh();
    setScreen("home");
  }, [refresh]);

  const logout = useCallback(() => {
    sessionGeneration.current += 1;
    setEmployee(null);
    setData(null);
    setLoading(false);
    setScreen("home");
    setResumeOpen(false);
    setResumeDraft(null);
    setResumeError(null);
    setPendingScreen(null);
    void terminalLogout();
  }, []);

  const openResumeIfAny = useCallback((employeeId: string) => {
    const result = readDraft(browserStorage(), employeeId);
    if (result.status === "none") {
      setResumeOpen(false);
      setResumeDraft(null);
      setResumeError(null);
      return;
    }
    if (result.status === "error") {
      setResumeDraft(null);
      setResumeError(result.reason);
      setResumeOpen(true);
      return;
    }
    setResumeDraft(result.draft);
    setResumeError(null);
    setResumeOpen(true);
  }, []);

  const handleLogin = useCallback(async () => {
    const generation = sessionGeneration.current + 1;
    sessionGeneration.current = generation;
    setLoading(true);
    try {
      const next = await getTerminalData();
      if (generation !== sessionGeneration.current) return;
      setData(next);
      setEmployee(next.currentEmployee);
      setScreen("home");
      openResumeIfAny(next.currentEmployee.id);
    } catch (error) {
      if (generation === sessionGeneration.current) {
        setData(null);
        setEmployee(null);
        setLoading(false);
        await terminalLogout();
      }
      throw error;
    } finally {
      if (generation === sessionGeneration.current) setLoading(false);
    }
  }, [openResumeIfAny]);

  const handleSelectScreen = useCallback(
    (next: TerminalScreen) => {
      if (!employee) return;
      const result = readDraft(browserStorage(), employee.id);
      if (result.status === "error") {
        setPendingScreen(next);
        setResumeDraft(null);
        setResumeError(result.reason);
        setResumeOpen(true);
        return;
      }
      if (result.status === "ok") {
        const draftScreen = SCREEN_BY_OPERATION[result.draft.operationType];
        if (draftScreen !== next) {
          setPendingScreen(next);
          setResumeDraft(result.draft);
          setResumeError(null);
          setResumeOpen(true);
          return;
        }
      }
      setScreen(next);
    },
    [employee],
  );

  const handleResumeContinue = useCallback(() => {
    if (resumeDraft) setScreen(SCREEN_BY_OPERATION[resumeDraft.operationType]);
    setResumeOpen(false);
    setPendingScreen(null);
  }, [resumeDraft]);

  const handleResumeDelete = useCallback(() => {
    if (!employee) return;
    clearDraft(browserStorage(), employee.id);
    setResumeOpen(false);
    setResumeDraft(null);
    setResumeError(null);
    const next = pendingScreen;
    setPendingScreen(null);
    if (next && next !== "home") setScreen(next);
  }, [employee, pendingScreen]);

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

      {!employee && loading ? (
        <main className="text-muted-foreground flex flex-1 items-center justify-center text-base">
          Загрузка данных…
        </main>
      ) : !employee ? (
        <LoginScreen onSuccess={handleLogin} />
      ) : !data ? (
        <main className="text-muted-foreground flex flex-1 items-center justify-center text-base">
          Загрузка данных…
        </main>
      ) : screen === "home" ? (
        <HomeScreen
          birthdaysToday={data.birthdaysToday}
          employee={employee}
          onSelect={handleSelectScreen}
        />
      ) : screen === "torcovka" ? (
        <TorcovkaScreen data={data} employee={employee} onDone={handleOperationDone} />
      ) : screen === "prisadka" ? (
        <PrisadkaScreen data={data} employee={employee} onDone={handleOperationDone} />
      ) : screen === "upakovka" ? (
        <UpakovkaScreen data={data} employee={employee} onDone={handleOperationDone} />
      ) : (
        <HoursScreen employee={employee} onDone={handleOperationDone} />
      )}
      <TerminalDraftResumeDialog
        open={resumeOpen}
        draft={resumeDraft}
        parseError={resumeError}
        onContinue={handleResumeContinue}
        onDelete={handleResumeDelete}
        onDismiss={() => {
          setResumeOpen(false);
          setPendingScreen(null);
        }}
      />
      <TerminalToaster />
    </div>
  );
}
