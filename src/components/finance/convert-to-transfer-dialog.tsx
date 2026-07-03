"use client";

import { useState } from "react";
import { useJustOpened } from "@/hooks/use-just-opened";
import { formatMoney } from "@/lib/format";
import type { FinanceAccount, FinanceCashFlowRow } from "@/mocks/finance-fixtures";
import {
  Field,
  FinanceFormDialog,
  selectTriggerClass,
  formSelectContentProps,
} from "@/components/finance/finance-form-shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ConvertToTransferDialogProps {
  open: boolean;
  row: FinanceCashFlowRow | null;
  accounts: FinanceAccount[];
  onOpenChange: (open: boolean) => void;
  onSubmit?: (otherAccountId: string) => void;
}

export function ConvertToTransferDialog({
  open,
  row,
  accounts,
  onOpenChange,
  onSubmit,
}: ConvertToTransferDialogProps) {
  const [otherId, setOtherId] = useState("");
  const options = accounts.filter((a) => a.id !== row?.accountId);

  if (useJustOpened(open)) {
    setOtherId(options[0]?.id ?? "");
  }

  const isIncome = row?.flowType === "INCOME";
  const canSubmit = otherId.length > 0 && otherId !== row?.accountId;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit?.(otherId);
    onOpenChange(false);
  };

  return (
    <FinanceFormDialog
      open={open}
      title="Сделать переводом"
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel="Сделать переводом"
      submitDisabled={!canSubmit}
      maxWidth="sm:max-w-md"
    >
      {row && (
        <div className="text-muted-foreground space-y-1 text-sm">
          <p>
            Операция:{" "}
            <span className="text-foreground font-medium tabular-nums">
              {isIncome ? "+" : "−"}
              {formatMoney(row.amount)}
            </span>{" "}
            · {row.accountName}
          </p>
          <p className="text-xs">
            {isIncome
              ? "Поступление станет переводом: на втором счёте появится списание на ту же сумму."
              : "Списание станет переводом: на втором счёте появится зачисление на ту же сумму."}
          </p>
        </div>
      )}

      <Field id="ctt-account" label={isIncome ? "Счёт-источник" : "Счёт зачисления"} required>
        <Select value={otherId} onValueChange={(v) => setOtherId(v ?? "")}>
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue placeholder="Выберите счёт">
              {options.find((a) => a.id === otherId)?.name}
            </SelectValue>
          </SelectTrigger>
          <SelectContent {...formSelectContentProps}>
            {options.map((a) => (
              <SelectItem key={a.id} value={a.id} className="cursor-pointer rounded-lg">
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FinanceFormDialog>
  );
}
