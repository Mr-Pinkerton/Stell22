"use client";

import Link from "next/link";
import { ArrowLeft, LogIn, LogOut, ChevronLeft } from "lucide-react";
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

export function TerminalHeader({
  employee,
  title,
  onBack,
  onLoginClick,
  onLogout,
}: TerminalHeaderProps) {
  return (
    <header className="surface-card mx-4 mt-4 flex h-16 items-center justify-between px-4 md:mx-6 md:px-6">
      <div className="flex items-center gap-3">
        {onBack ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="rounded-xl [&_svg]:stroke-[1.75]"
            onClick={onBack}
          >
            <ChevronLeft />
          </Button>
        ) : (
          <div className="bg-brand flex size-10 items-center justify-center rounded-2xl text-sm font-bold text-white shadow-soft">
            S
          </div>
        )}
        <div className="text-lg font-semibold tracking-tight">{title}</div>
      </div>

      <div className="flex items-center gap-3">
        {employee ? (
          <>
            <span className="hidden text-sm font-medium sm:inline">{employee.fullName}</span>
            <Button
              variant="outline"
              className="rounded-xl [&_svg]:stroke-[1.75]"
              onClick={onLogout}
            >
              <LogOut />
              Выйти
            </Button>
          </>
        ) : (
          <>
            <span className="text-muted-foreground text-sm font-medium">Вход не выполнен</span>
            <Button className="rounded-xl [&_svg]:stroke-[1.75]" onClick={onLoginClick}>
              <LogIn />
              Войти
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          className="rounded-xl [&_svg]:stroke-[1.75]"
          nativeButton={false}
          render={<Link href="/dashboard" />}
        >
          <ArrowLeft />
          <span className="hidden sm:inline">В админку</span>
        </Button>
      </div>
    </header>
  );
}
