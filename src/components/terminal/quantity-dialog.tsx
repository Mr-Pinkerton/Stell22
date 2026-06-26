"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumericKeypad } from "@/components/terminal/numeric-keypad";

interface QuantityDialogProps {
  open: boolean;
  title: string;
  hint?: string;
  /** Стартовое значение поля (напр. ранее введённое количество). */
  initial?: number;
  /** Жёсткий лимит ввода (нельзя подтвердить больше). */
  max?: number;
  confirmLabel?: string;
  onConfirm: (value: number) => void;
  onClose: () => void;
}

/** Модалка ввода количества: заголовок + подсказка + клавиатура. */
export function QuantityDialog(props: QuantityDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      {/* Тело монтируется заново при каждом открытии → состояние сбрасывается без эффектов. */}
      {props.open && <QuantityDialogBody {...props} />}
    </Dialog>
  );
}

function QuantityDialogBody({
  title,
  hint = "Введите количество",
  initial = 0,
  max,
  confirmLabel = "Подтвердить",
  onConfirm,
  onClose,
}: QuantityDialogProps) {
  const [value, setValue] = useState(initial > 0 ? String(initial) : "");

  const numeric = Number(value || 0);
  const overLimit = max != null && numeric > max;
  const canConfirm = numeric > 0 && !overLimit;

  return (
    <DialogContent className="sm:max-w-sm" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle className="text-xl">{title}</DialogTitle>
        <p className="text-muted-foreground text-base">{hint}</p>
      </DialogHeader>

      <div className="bg-muted/50 flex h-20 items-center justify-center rounded-2xl text-4xl font-semibold tabular-nums">
        {value || "0"}
      </div>
      {overLimit && (
        <p className="text-destructive text-center text-sm font-medium">Доступно не более {max}</p>
      )}

      <NumericKeypad value={value} onChange={setValue} />

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" className="h-14 rounded-xl text-lg" onClick={onClose}>
          Отмена
        </Button>
        <Button
          className="h-14 rounded-xl text-lg"
          disabled={!canConfirm}
          onClick={() => onConfirm(numeric)}
        >
          {confirmLabel}
        </Button>
      </div>
    </DialogContent>
  );
}
