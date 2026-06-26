"use client";

import { Drill, Package, Clock, Cake } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Saw } from "@/components/terminal/saw-icon";
import type { Employee } from "@/types/domain";
import type { TerminalScreen } from "@/components/terminal/types";

const TILES: { screen: TerminalScreen; title: string; icon: typeof Saw }[] = [
  { screen: "torcovka", title: "Торцовка", icon: Saw },
  { screen: "prisadka", title: "Присадка", icon: Drill },
  { screen: "upakovka", title: "Упаковка", icon: Package },
  { screen: "hours", title: "Рабочие часы", icon: Clock },
];

interface HomeScreenProps {
  employees: Employee[];
  onSelect: (screen: TerminalScreen) => void;
}

/** ФИО тех, у кого сегодня ДР (сравниваем месяц+день). */
function birthdayPeople(employees: Employee[]): string[] {
  const now = new Date();
  return employees
    .filter((e) => {
      if (!e.birthDate) return false;
      const d = new Date(e.birthDate);
      return d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    })
    .map((e) => e.fullName);
}

export function HomeScreen({ employees, onSelect }: HomeScreenProps) {
  const birthdays = birthdayPeople(employees);

  return (
    <main className="flex flex-1 flex-col gap-6 p-6">
      {birthdays.length > 0 && (
        <Card className="border-brand/30 bg-brand/5 ring-0">
          <CardContent className="flex items-center gap-3 py-4">
            <span className="bg-brand/15 text-brand flex size-10 items-center justify-center rounded-2xl [&_svg]:size-5 [&_svg]:stroke-[1.75]">
              <Cake />
            </span>
            <p className="text-sm font-medium">
              Сегодня день рождения у {birthdays.join(", ")} — поздравляем!
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid flex-1 grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4">
        {TILES.map((t) => {
          const Icon = t.icon;
          return (
            <Card
              key={t.screen}
              className="surface-card aspect-square ring-0 active:scale-[0.98] active:opacity-90"
            >
              <CardContent
                className="flex h-full cursor-pointer flex-col items-center justify-center gap-4 p-4"
                onClick={() => onSelect(t.screen)}
              >
                <span className="bg-muted text-muted-foreground flex size-16 items-center justify-center rounded-2xl [&_svg]:size-8 [&_svg]:stroke-[1.75]">
                  <Icon />
                </span>
                <span className="text-center text-xl font-semibold tracking-tight sm:text-2xl">
                  {t.title}
                </span>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </main>
  );
}
