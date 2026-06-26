"use client";

import { LogIn, LogOut, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Employee } from "@/types/domain";

interface TerminalHeaderProps {
  employee: Employee | null;
  title: string;
  /** Кнопка «назад» внутри операции (null — скрыта). */
  onBack?: (() => void) | null;
  onLoginClick: () => void;
  onLogout: () => void;
}

const actionBtn =
  "h-12 rounded-xl px-5 text-base font-medium [&_svg]:size-5 [&_svg]:stroke-[1.75]";

export function TerminalHeader({
  employee,
  title,
  onBack,
  onLoginClick,
  onLogout,
}: TerminalHeaderProps) {
  return (
    <header className="surface-card mx-4 mt-4 flex h-20 items-center justify-between px-4 md:mx-6 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        {onBack ? (
          <Button variant="outline" className={actionBtn} onClick={onBack}>
            <ChevronLeft />
            Назад
          </Button>
        ) : (
          <div className="bg-brand flex size-12 shrink-0 items-center justify-center rounded-2xl text-base font-bold text-white shadow-soft">
            S
          </div>
        )}
        <div className="truncate text-xl font-semibold tracking-tight">{title}</div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {employee ? (
          <>
            <span className="hidden text-base font-medium md:inline">{employee.fullName}</span>
            <Button variant="outline" className={actionBtn} onClick={onLogout}>
              <LogOut />
              Выйти
            </Button>
          </>
        ) : (
          <>
            <span className="text-muted-foreground hidden text-base font-medium sm:inline">
              Вход не выполнен
            </span>
            <Button className={actionBtn} onClick={onLoginClick}>
              <LogIn />
              Войти
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
