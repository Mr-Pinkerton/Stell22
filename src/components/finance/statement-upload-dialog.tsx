"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useJustOpened } from "@/hooks/use-just-opened";
import { cn } from "@/lib/utils";
import { is1CStatement, parse1CStatement } from "@/lib/bank-statement-1c";
import type { FinanceAccount } from "@/mocks/finance-fixtures";
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
  /** Декодированный текст файла. Заполняется только для формата 1С. */
  content: string;
  /** Файл распознан как 1CClientBankExchange → серверный импорт операций. */
  is1C: boolean;
  /** Привязать выписку к выбранному счёту (если номер не распознан). */
  bindAccountId: string | null;
}

interface StatementUploadDialogProps {
  open: boolean;
  accounts: FinanceAccount[];
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: StatementUploadValues) => void;
}

interface Preview {
  accountNumber: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  operations: number;
  matchedAccountId: string | null;
}

const CREATE_NEW = "__new__";

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Декодирование файла выписки по объявленной кодировке 1С (Windows/UTF8/DOS). */
async function decodeStatementFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder("windows-1251").decode(buf);
  const enc = text.match(/Кодировка\s*=\s*(\S+)/)?.[1]?.toUpperCase() ?? "";
  if (enc.includes("UTF")) text = new TextDecoder("utf-8").decode(buf);
  else if (enc.includes("DOS") || enc.includes("866")) text = new TextDecoder("ibm866").decode(buf);
  return text;
}

export function StatementUploadDialog({
  open,
  accounts,
  onOpenChange,
  onSubmit,
}: StatementUploadDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dateText, setDateText] = useState("");
  const [accountId, setAccountId] = useState("");
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");
  const [is1C, setIs1C] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [bindId, setBindId] = useState<string>(CREATE_NEW);

  if (useJustOpened(open)) {
    setDateText(isoToDisplayDate(todayIso()));
    setAccountId(accounts[0]?.id ?? "");
    setFileName("");
    setContent("");
    setIs1C(false);
    setPreview(null);
    setBindId(CREATE_NEW);
  }

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    const text = await decodeStatementFile(file);
    const detected = is1CStatement(text);
    setContent(text);
    setIs1C(detected);
    if (detected) {
      const st = parse1CStatement(text);
      const matched = st.accountNumber
        ? accounts.find((a) => a.accountNumber === st.accountNumber)?.id ?? null
        : null;
      setPreview({
        accountNumber: st.accountNumber,
        dateStart: st.dateStart,
        dateEnd: st.dateEnd,
        operations: st.documents.length,
        matchedAccountId: matched,
      });
      setBindId(CREATE_NEW);
    } else {
      setPreview(null);
    }
  };

  // Для 1С реквизиты берутся из файла; для прочих форматов — поля вручную.
  const canSubmit = is1C
    ? fileName.length > 0
    : parseDisplayDate(dateText) != null && accountId.length > 0 && fileName.length > 0;

  const handleSubmit = () => {
    if (is1C) {
      const bindAccountId =
        preview?.matchedAccountId ?? (bindId === CREATE_NEW ? null : bindId);
      onSubmit?.({
        date: "",
        accountName: "",
        fileName,
        content,
        is1C: true,
        bindAccountId,
      });
      onOpenChange(false);
      return;
    }
    const iso = parseDisplayDate(dateText);
    const account = accounts.find((a) => a.id === accountId);
    if (!iso || !account || !fileName) return;
    onSubmit?.({
      date: iso,
      accountName: account.name,
      fileName,
      content: "",
      is1C: false,
      bindAccountId: null,
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
        Формат 1С (kl_to_1c) разносится автоматически: счёт, контрагенты и операции
        берутся из файла. Для других форматов укажите дату и счёт вручную.
      </p>

      {!is1C && (
        <>
          <Field id="st-date" label="Дата" required>
            <DateFieldInput id="st-date" value={dateText} onChange={setDateText} />
          </Field>

          <Field id="st-account" label="Счёт" required>
            <Select value={accountId} onValueChange={(v) => setAccountId(v ?? "")}>
              <SelectTrigger className={selectTriggerClass}>
                <SelectValue placeholder="Выберите счёт">
                  {accounts.find((a) => a.id === accountId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent {...formSelectContentProps}>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id} className="cursor-pointer rounded-lg">
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </>
      )}

      <Field id="st-file" label="Файл выписки" required>
        <input
          ref={fileRef}
          id="st-file"
          type="file"
          accept=".csv,.txt,.xml,.pdf"
          className="sr-only"
          onChange={(e) => void handleFile(e.target.files?.[0])}
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

      {is1C && preview && (
        <div className="border-border bg-muted/30 space-y-1 rounded-lg border px-3 py-2.5 text-sm">
          <p className="text-foreground font-medium">Формат 1С распознан</p>
          <p className="text-muted-foreground">Счёт: {preview.accountNumber ?? "—"}</p>
          <p className="text-muted-foreground">
            Период: {preview.dateStart ?? "—"} — {preview.dateEnd ?? "—"}
          </p>
          <p className="text-muted-foreground">Операций: {preview.operations}</p>
          {preview.matchedAccountId && (
            <p className="text-muted-foreground">
              Счёт распознан: {accounts.find((a) => a.id === preview.matchedAccountId)?.name}
            </p>
          )}
        </div>
      )}

      {is1C && preview && !preview.matchedAccountId && (
        <Field id="st-bind" label="Привязать к счёту">
          <Select value={bindId} onValueChange={(v) => setBindId(v ?? CREATE_NEW)}>
            <SelectTrigger className={selectTriggerClass}>
              <SelectValue>
                {bindId === CREATE_NEW
                  ? "Создать новый счёт"
                  : accounts.find((a) => a.id === bindId)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent {...formSelectContentProps}>
              <SelectItem value={CREATE_NEW} className="cursor-pointer rounded-lg">
                Создать новый счёт
              </SelectItem>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id} className="cursor-pointer rounded-lg">
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
    </FinanceFormDialog>
  );
}
