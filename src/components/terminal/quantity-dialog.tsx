"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KeypadDisplay } from "@/components/terminal/keypad-panel";
import { NumericKeypad } from "@/components/terminal/numeric-keypad";

interface QuantityDialogProps {
  open: boolean;
  title: string;
  hint?: string;
  /** Стартовое значение поля (напр. ранее введённое количество). */
  initial?: number;
  /** Жёсткий лимит ввода (нельзя подтвердить больше). */
  max?: number;
  /** Текст при превышении max (иначе «Доступно не более N»). */
  limitMessage?: string;
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
  limitMessage,
  confirmLabel = "Подтвердить",
  onConfirm,
  onClose,
}: QuantityDialogProps) {
  const [value, setValue] = useState(initial > 0 ? String(initial) : "");

  const numeric = Number(value || 0);
  const overLimit = max != null && numeric > max;
  const canConfirm = numeric > 0 && !overLimit;
  const limitText = limitMessage ?? (max != null ? `Доступно не более ${max}` : "");

  return (
    <DialogContent className="gap-5 px-8 py-6 sm:max-w-[26rem]" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle className="text-xl">{title}</DialogTitle>
        <p className="text-muted-foreground text-base">{hint}</p>
      </DialogHeader>

      <KeypadDisplay
        footerMessage={max != null ? limitText : undefined}
        showFooterMessage={overLimit}
        footerTone="error"
      >
        {value || "0"}
      </KeypadDisplay>

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
