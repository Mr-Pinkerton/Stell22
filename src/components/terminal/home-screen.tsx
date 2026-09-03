"use client";

import { useEffect, useState } from "react";
import { Drill, Package, Clock, Cake } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Saw } from "@/components/terminal/saw-icon";
import { EntriesJournal } from "@/components/terminal/entries-journal";
import { getEmployeeEntries } from "@/server/terminal";
import type { TerminalEntry } from "@/types/domain";
import type {
  TerminalBirthday,
  TerminalEmployee,
  TerminalScreen,
} from "@/components/terminal/types";

const TILES: { screen: TerminalScreen; title: string; icon: typeof Saw }[] = [
  { screen: "torcovka", title: "Торцовка", icon: Saw },
  { screen: "prisadka", title: "Присадка", icon: Drill },
  { screen: "upakovka", title: "Упаковка", icon: Package },
  { screen: "hours", title: "Рабочие часы", icon: Clock },
];

interface HomeScreenProps {
  birthdaysToday: TerminalBirthday[];
  employee: TerminalEmployee;
  onSelect: (screen: TerminalScreen) => void;
}

export function HomeScreen({ birthdaysToday, employee, onSelect }: HomeScreenProps) {
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  useEffect(() => {
    let alive = true;
    getEmployeeEntries(employee.id).then((rows) => {
      if (alive) setEntries(rows);
    });
    return () => {
      alive = false;
    };
  }, [employee.id]);

  return (
    <main className="scrollbar-thin-y flex flex-1 flex-col gap-6 overflow-y-auto p-6">
      <div className="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-4">
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

      {birthdaysToday.length > 0 && (
        <Card className="border-brand/30 bg-brand/5 ring-0">
          <CardContent className="flex flex-col items-center gap-3 py-5 text-center">
            <span className="bg-brand/15 text-brand flex size-10 items-center justify-center rounded-2xl [&_svg]:size-5 [&_svg]:stroke-[1.75]">
              <Cake />
            </span>
            <p className="text-sm font-medium">
              Сегодня день рождения у {birthdaysToday.map((person) => person.fullName).join(", ")} —
              поздравляем!
            </p>
          </CardContent>
        </Card>
      )}

      <EntriesJournal entries={entries} />
    </main>
  );
}
