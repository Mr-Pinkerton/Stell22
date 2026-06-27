"use client";

import { useState } from "react";
import { toast } from "@/components/terminal/toast";
import { User, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OperationTile, OperationTileRow } from "@/components/terminal/operation-tile";
import { KEYPAD_PANEL } from "@/components/terminal/keypad-panel";
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
        const parts = selected.fullName.split(" ");
        const firstName = parts[1] ?? parts[0];
        toast.success(`Здравствуйте, ${firstName}!`);
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
        <h1 className="text-2xl font-semibold tracking-tight">Выберите сотрудника</h1>
        <div className="w-full">
          <OperationTileRow>
            {active.map((e) => (
              <OperationTile
                key={e.id}
                layout="person"
                icon={<User />}
                title={e.fullName}
                onClick={() => setSelected(e)}
              />
            ))}
          </OperationTileRow>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <div className={KEYPAD_PANEL}>
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">{selected.fullName}</h1>
          <p className="text-muted-foreground text-base">Введите PIN-код</p>
        </div>

        <div className="flex justify-center gap-4">
          {[0, 1, 2, 3].map((i) => (
            <span
              key={i}
              className={
                "size-5 rounded-full " + (i < pin.length ? "bg-brand" : "bg-muted")
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
