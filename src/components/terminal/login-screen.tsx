"use client";

import { useState } from "react";
import { toast } from "sonner";
import { User, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NumericKeypad } from "@/components/terminal/numeric-keypad";
import type { Employee } from "@/types/domain";

interface LoginScreenProps {
  employees: Employee[];
  onSuccess: (employee: Employee) => void;
}

export function LoginScreen({ employees, onSuccess }: LoginScreenProps) {
  const [selected, setSelected] = useState<Employee | null>(null);
  const [pin, setPin] = useState("");

  const active = employees.filter((e) => e.status === "ACTIVE");

  const submit = (next: string) => {
    setPin(next);
    if (next.length === 4 && selected) {
      if (next === selected.pin) {
        toast.success(`Здравствуйте, ${selected.fullName.split(" ")[0]}!`);
        onSuccess(selected);
      } else {
        toast.error("Неверный PIN");
        setPin("");
      }
    }
  };

  if (!selected) {
    return (
      <main className="flex flex-1 flex-col items-center gap-6 p-6">
        <h1 className="text-xl font-semibold tracking-tight">Выберите сотрудника</h1>
        <div className="grid w-full max-w-3xl grid-cols-2 gap-4 sm:grid-cols-3">
          {active.map((e) => (
            <Card
              key={e.id}
              className="surface-card ring-0 transition-all hover:-translate-y-0.5 hover:shadow-soft-lg"
            >
              <CardContent
                className="flex cursor-pointer flex-col items-center gap-3 py-8"
                onClick={() => setSelected(e)}
              >
                <span className="bg-muted text-muted-foreground flex size-14 items-center justify-center rounded-2xl [&_svg]:size-7 [&_svg]:stroke-[1.75]">
                  <User />
                </span>
                <span className="text-center text-sm font-semibold">{e.fullName}</span>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <div className="w-full max-w-xs space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold tracking-tight">{selected.fullName}</h1>
          <p className="text-muted-foreground text-sm">Введите PIN-код</p>
        </div>

        <div className="flex justify-center gap-3">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={
                "size-4 rounded-full transition-colors " +
                (i < pin.length ? "bg-brand" : "bg-muted")
              }
            />
          ))}
        </div>

        <NumericKeypad value={pin} onChange={submit} maxLength={4} />

        <Button
          variant="ghost"
          className="w-full rounded-xl [&_svg]:stroke-[1.75]"
          onClick={() => {
            setSelected(null);
            setPin("");
          }}
        >
          <ArrowLeft />
          Назад к списку
        </Button>
      </div>
    </main>
  );
}
