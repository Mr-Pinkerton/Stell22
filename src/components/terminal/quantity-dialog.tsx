"use client";

import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KeypadDisplay } from "@/components/terminal/keypad-panel";
import { NumericKeypad } from "@/components/terminal/numeric-keypad";
import { terminalDialogContentClass } from "@/lib/scroll-classes";
import { canConfirmQuantity } from "@/lib/quantity-input";
import { beginExclusiveSubmit } from "@/lib/terminal-submit-guard";

export const QUANTITY_CONFIRM_LABEL = "Сохранить количество";

interface QuantityDialogProps {
  open: boolean;
  title: string;
  hint?: ReactNode;
  /** Стартовое значение поля (напр. ранее введённое количество). */
  initial?: number;
  /** Жёсткий лимит ввода (нельзя подтвердить больше). */
  max?: number;
  /** Текст при превышении max (иначе «Доступно не более N»). */
  limitMessage?: string;
  confirmLabel?: string;
  /** TORCOVKA: разрешить 0, чтобы снять одну уже выбранную длину. */
  allowZero?: boolean;
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
  confirmLabel = QUANTITY_CONFIRM_LABEL,
  allowZero = false,
  onConfirm,
  onClose,
}: QuantityDialogProps) {
  const [value, setValue] = useState(initial > 0 ? String(initial) : "");
  const confirmLock = useRef(false);

  const numeric = Number(value || 0);
  const overLimit = max != null && numeric > max;
  const canConfirm = canConfirmQuantity({ numeric, max, allowZero });
  const limitText = limitMessage ?? (max != null ? `Доступно не более ${max}` : "");

  return (
    <DialogContent className={terminalDialogContentClass} showCloseButton={false}>
      <DialogHeader>
        <DialogTitle className="text-xl">{title}</DialogTitle>
        {hint ? <p className="text-muted-foreground text-base">{hint}</p> : null}
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
          onClick={() => {
            if (!canConfirm || !beginExclusiveSubmit(confirmLock)) return;
            onConfirm(numeric);
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </DialogContent>
  );
}
