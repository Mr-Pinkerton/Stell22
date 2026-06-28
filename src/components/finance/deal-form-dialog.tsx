"use client";

import { useEffect, useMemo, useState } from "react";
import { batches } from "@/mocks/fixtures";
import type { FinanceDeal } from "@/mocks/finance-fixtures";
import {
  Field,
  FinanceFormDialog,
  fieldClass,
} from "@/components/finance/finance-form-shared";
import { scrollThinY } from "@/lib/scroll-classes";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export interface DealFormValues {
  name: string;
  batchNames: string[];
}

interface DealFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: DealFormValues) => void;
}

const materialBatches = batches.filter((b) => b.status !== "ARCHIVED");

function generatedDealName(batchNames: string[]): string {
  return batchNames.join(" + ");
}

export function dealBatchTotal(batchNames: string[]): number {
  return batchNames.reduce((sum, batchName) => {
    const batch = batches.find((b) => b.name === batchName);
    return sum + (batch?.totalCost ?? 0);
  }, 0);
}

export function DealFormDialog({ open, onOpenChange, onSubmit }: DealFormDialogProps) {
  const [name, setName] = useState("");
  const [nameManual, setNameManual] = useState(false);
  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(new Set());

  const selectedList = useMemo(() => [...selectedBatches], [selectedBatches]);

  useEffect(() => {
    if (!open) return;
    setName("");
    setNameManual(false);
    setSelectedBatches(new Set());
  }, [open]);

  useEffect(() => {
    if (!open || nameManual) return;
    setName(generatedDealName(selectedList));
  }, [open, nameManual, selectedList]);

  const toggleBatch = (batchName: string, checked: boolean) => {
    setSelectedBatches((prev) => {
      const next = new Set(prev);
      if (checked) next.add(batchName);
      else next.delete(batchName);
      return next;
    });
  };

  const canSubmit = selectedBatches.size > 0 && name.trim().length > 0;

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed || selectedBatches.size === 0) return;
    onSubmit?.({
      name: trimmed,
      batchNames: selectedList,
    });
    onOpenChange(false);
  };

  return (
    <FinanceFormDialog
      open={open}
      title="Добавить сделку"
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel="Добавить"
      submitDisabled={!canSubmit}
      maxWidth="sm:max-w-lg"
      bodyTall
    >
      <Field id="deal-batches" label="Закупки" required>
        <div className={cn("border-border max-h-48 space-y-2 rounded-xl border p-3", scrollThinY)}>
          {materialBatches.map((b) => (
            <label
              key={b.id}
              className="border-border bg-card hover:bg-muted/40 flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-sm transition-colors"
            >
              <Checkbox
                checked={selectedBatches.has(b.name)}
                onCheckedChange={(v) => toggleBatch(b.name, v === true)}
                className="border-[#98a2b3] bg-card size-[18px] cursor-pointer"
              />
              <Label className="cursor-pointer font-medium">{b.name}</Label>
            </label>
          ))}
        </div>
      </Field>

      <Field id="deal-name" label="Название сделки" required>
        <Input
          id="deal-name"
          value={name}
          onChange={(e) => {
            setNameManual(true);
            setName(e.target.value);
          }}
          className={fieldClass}
          placeholder="Подставится из закупок"
        />
      </Field>

      <p className="text-muted-foreground rounded-xl bg-tag-blue-bg/40 px-3 py-2 text-xs leading-relaxed">
        Доставка и дополнительные расходы вносятся в ДДС и привязываются к сделке при
        разнесении операций.
      </p>
    </FinanceFormDialog>
  );
}

export function dealValuesToRow(values: DealFormValues): FinanceDeal {
  const batchesTotal = dealBatchTotal(values.batchNames);

  return {
    id: `deal-${Date.now()}`,
    name: values.name,
    status: "OPEN",
    batchNames: values.batchNames,
    deliveryExtra: 0,
    total: batchesTotal,
  };
}
