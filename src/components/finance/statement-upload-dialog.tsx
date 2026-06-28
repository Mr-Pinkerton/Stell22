"use client";

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  financeAccounts,
  type FinanceStatementRow,
} from "@/mocks/finance-fixtures";
import {
  DateFieldInput,
  Field,
  FinanceFormDialog,
  isoToDisplayDate,
  parseDisplayDate,
  fieldClass,
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

export interface StatementUploadValues {
  date: string;
  accountName: string;
  fileName: string;
}

interface StatementUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: StatementUploadValues) => void;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export function StatementUploadDialog({
  open,
  onOpenChange,
  onSubmit,
}: StatementUploadDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dateText, setDateText] = useState("");
  const [accountId, setAccountId] = useState("");
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    if (!open) return;
    setDateText(isoToDisplayDate(todayIso()));
    setAccountId(financeAccounts[0]?.id ?? "");
    setFileName("");
    if (fileRef.current) fileRef.current.value = "";
  }, [open]);

  const canSubmit =
    parseDisplayDate(dateText) != null && accountId.length > 0 && fileName.length > 0;

  const handleSubmit = () => {
    const iso = parseDisplayDate(dateText);
    const account = financeAccounts.find((a) => a.id === accountId);
    if (!iso || !account || !fileName) return;

    onSubmit?.({
      date: iso,
      accountName: account.name,
      fileName,
    });
    onOpenChange(false);
  };

  return (
    <FinanceFormDialog
      open={open}
      title="Загрузить выписку"
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel="Загрузить"
      submitDisabled={!canSubmit}
    >
      <p className="text-muted-foreground text-sm">
        В одном дне можно загрузить несколько выписок с разных счетов.
      </p>

      <Field id="st-date" label="Дата" required>
        <DateFieldInput id="st-date" value={dateText} onChange={setDateText} />
      </Field>

      <Field id="st-account" label="Счёт" required>
        <Select value={accountId} onValueChange={(v) => setAccountId(v ?? "")}>
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue placeholder="Выберите счёт">
              {financeAccounts.find((a) => a.id === accountId)?.name}
            </SelectValue>
          </SelectTrigger>
          <SelectContent {...formSelectContentProps}>
            {financeAccounts.map((a) => (
              <SelectItem key={a.id} value={a.id} className="cursor-pointer rounded-lg">
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field id="st-file" label="Файл выписки" required>
        <input
          ref={fileRef}
          id="st-file"
          type="file"
          accept=".csv,.txt,.xml,.pdf"
          className="sr-only"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
        />
        <button
          type="button"
          className={cn(
            fieldClass,
            "text-foreground hover:bg-muted/40 flex w-full cursor-pointer items-center gap-2 text-left text-sm font-normal transition-colors",
          )}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">{fileName || "Выберите файл"}</span>
        </button>
      </Field>
    </FinanceFormDialog>
  );
}

export function statementUploadToRow(values: StatementUploadValues): FinanceStatementRow {
  return {
    id: `st-${Date.now()}`,
    date: values.date,
    accountName: values.accountName,
    operationsCount: 0,
    unassignedCount: 0,
    uploaded: true,
  };
}
