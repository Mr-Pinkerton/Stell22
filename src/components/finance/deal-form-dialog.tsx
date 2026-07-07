"use client";

import { useMemo, useState } from "react";
import { useJustOpened } from "@/hooks/use-just-opened";
import type { FinanceDeal } from "@/mocks/finance-fixtures";
import {
  Field,
  FinanceFormDialog,
  fieldClass,
} from "@/components/finance/finance-form-shared";
import { scrollThinY } from "@/lib/scroll-classes";
import { capitalizeFirst, cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export interface DealFormValues {
  name: string;
  batchNames: string[];
}

export interface DealBatchOption {
  id: string;
  name: string;
  status: string;
}

interface DealFormDialogProps {
  open: boolean;
  batches: DealBatchOption[];
  deal?: FinanceDeal | null;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: DealFormValues) => void;
}

function generatedDealName(batchNames: string[]): string {
  return batchNames.join(" + ");
}

export function DealFormDialog({ open, batches, deal, onOpenChange, onSubmit }: DealFormDialogProps) {
  const [name, setName] = useState("");
  const [nameManual, setNameManual] = useState(false);
  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(new Set());
  const [showErrors, setShowErrors] = useState(false);

  const selectedList = useMemo(() => [...selectedBatches], [selectedBatches]);

  if (useJustOpened(open)) {
    setName(deal?.name ?? "");
    setNameManual(Boolean(deal));
    setSelectedBatches(new Set(deal?.batchNames ?? []));
    setShowErrors(false);
  }

  // Незаархивированные закупки + уже привязанные (даже если ушли в архив).
  const materialBatches = batches.filter(
    (b) => b.status !== "ARCHIVED" || selectedBatches.has(b.name),
  );

  // Имя подставляется из выбранных закупок, пока его не правили вручную.
  const effectiveName = nameManual ? name : generatedDealName(selectedList);

  const toggleBatch = (batchName: string, checked: boolean) => {
    setSelectedBatches((prev) => {
      const next = new Set(prev);
      if (checked) next.add(batchName);
      else next.delete(batchName);
      return next;
    });
  };

  const canSubmit = selectedBatches.size > 0 && effectiveName.trim().length > 0;

  const handleSubmit = () => {
    const trimmed = effectiveName.trim();
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
      title={deal ? "Редактировать сделку" : "Добавить сделку"}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel={deal ? "Сохранить" : "Добавить"}
      canSubmit={canSubmit}
      onInvalid={() => setShowErrors(true)}
      maxWidth="sm:max-w-lg"
      bodyTall
    >
      <Field id="deal-batches" label="Закупки" required>
        <div
          className={cn(
            "border-border max-h-48 space-y-2 rounded-xl border p-3",
            scrollThinY,
            showErrors && selectedBatches.size === 0 && "border-amber-400 bg-amber-50",
          )}
        >
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

      <Field
        id="deal-name"
        label="Название сделки"
        required
        invalid={showErrors && !effectiveName.trim()}
      >
        <Input
          id="deal-name"
          value={effectiveName}
          onChange={(e) => {
            setNameManual(true);
            setName(capitalizeFirst(e.target.value));
          }}
          className={fieldClass}
          autoCapitalize="sentences"
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
