"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { unzipSync } from "fflate";
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
  /** Одна или несколько выписок (ZIP-архив) — импортируются по порядку. */
  onSubmit?: (values: StatementUploadValues[]) => void;
}

/** Разобранная 1С-выписка из файла или записи архива. */
interface ParsedStatement {
  fileName: string;
  content: string;
  accountNumber: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  operations: number;
  matchedAccountName: string | null;
}

const CREATE_NEW = "__new__";

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Декодирование текста выписки по объявленной кодировке 1С (Windows/UTF8/DOS). */
function decodeStatementBytes(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let text = new TextDecoder("windows-1251").decode(bytes);
  const enc = text.match(/Кодировка\s*=\s*(\S+)/)?.[1]?.toUpperCase() ?? "";
  if (enc.includes("UTF")) text = new TextDecoder("utf-8").decode(bytes);
  else if (enc.includes("DOS") || enc.includes("866")) text = new TextDecoder("ibm866").decode(bytes);
  return text;
}

function isZipFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".zip") || file.type.includes("zip");
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
  // Одна не-1С выписка (ручные реквизиты) ИЛИ список 1С-выписок (файл/архив).
  const [parsed, setParsed] = useState<ParsedStatement[]>([]);
  const [isPlainFile, setIsPlainFile] = useState(false);
  const [skippedEntries, setSkippedEntries] = useState(0);
  const [bindId, setBindId] = useState<string>(CREATE_NEW);

  if (useJustOpened(open)) {
    setDateText(isoToDisplayDate(todayIso()));
    setAccountId(accounts[0]?.id ?? "");
    setFileName("");
    setParsed([]);
    setIsPlainFile(false);
    setSkippedEntries(0);
    setBindId(CREATE_NEW);
  }

  const toParsed = (name: string, text: string): ParsedStatement => {
    const st = parse1CStatement(text);
    const matched = st.accountNumber
      ? accounts.find((a) => a.accountNumber === st.accountNumber)?.name ?? null
      : null;
    return {
      fileName: name,
      content: text,
      accountNumber: st.accountNumber,
      dateStart: st.dateStart,
      dateEnd: st.dateEnd,
      operations: st.documents.length,
      matchedAccountName: matched,
    };
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setBindId(CREATE_NEW);
    setSkippedEntries(0);

    if (isZipFile(file)) {
      // ZIP: каждая запись — потенциальная выписка; не-1С записи пропускаем.
      const buf = new Uint8Array(await file.arrayBuffer());
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(buf);
      } catch {
        setParsed([]);
        setIsPlainFile(false);
        setSkippedEntries(-1);
        return;
      }
      const items: ParsedStatement[] = [];
      let skipped = 0;
      for (const [name, bytes] of Object.entries(entries)) {
        if (name.endsWith("/") || bytes.length === 0) continue; // папки
        const text = decodeStatementBytes(bytes);
        if (is1CStatement(text)) items.push(toParsed(name.split("/").pop() ?? name, text));
        else skipped += 1;
      }
      // Стабильный порядок импорта: по дате начала периода, затем по имени.
      items.sort(
        (a, b) =>
          (a.dateStart ?? "").localeCompare(b.dateStart ?? "") ||
          a.fileName.localeCompare(b.fileName),
      );
      setParsed(items);
      setIsPlainFile(false);
      setSkippedEntries(skipped);
      return;
    }

    const text = decodeStatementBytes(await file.arrayBuffer());
    if (is1CStatement(text)) {
      setParsed([toParsed(file.name, text)]);
      setIsPlainFile(false);
    } else {
      setParsed([]);
      setIsPlainFile(true);
    }
  };

  const single1C = !isPlainFile && parsed.length === 1 ? parsed[0] : null;
  const multi1C = !isPlainFile && parsed.length > 1;

  const canSubmit = isPlainFile
    ? parseDisplayDate(dateText) != null && accountId.length > 0 && fileName.length > 0
    : parsed.length > 0;

  const handleSubmit = () => {
    if (isPlainFile) {
      const iso = parseDisplayDate(dateText);
      const account = accounts.find((a) => a.id === accountId);
      if (!iso || !account || !fileName) return;
      onSubmit?.([
        {
          date: iso,
          accountName: account.name,
          fileName,
          content: "",
          is1C: false,
          bindAccountId: null,
        },
      ]);
      onOpenChange(false);
      return;
    }

    if (parsed.length === 0) return;
    onSubmit?.(
      parsed.map((p) => ({
        date: "",
        accountName: "",
        fileName: p.fileName,
        content: p.content,
        is1C: true,
        // Ручная привязка имеет смысл только для одиночного нераспознанного
        // файла; в архиве каждый файл распределяется по своему РасчСчёту.
        bindAccountId:
          single1C && !single1C.matchedAccountName && bindId !== CREATE_NEW ? bindId : null,
      })),
    );
    onOpenChange(false);
  };

  return (
    <FinanceFormDialog
      open={open}
      title="Загрузить выписку"
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel={parsed.length > 1 ? `Загрузить (${parsed.length})` : "Загрузить"}
      submitDisabled={!canSubmit}
    >
      <p className="text-muted-foreground text-sm">
        Формат 1С (kl_to_1c) и ZIP-архивы с такими файлами разносятся автоматически:
        счёт, контрагенты и операции берутся из файлов. Для других форматов укажите
        дату и счёт вручную.
      </p>

      {isPlainFile && (
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

      <Field id="st-file" label="Файл выписки или ZIP-архив" required>
        <input
          ref={fileRef}
          id="st-file"
          type="file"
          accept=".csv,.txt,.xml,.pdf,.zip"
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

      {skippedEntries === -1 && (
        <p className="text-destructive text-sm">Не удалось распаковать архив.</p>
      )}

      {fileName && !isPlainFile && parsed.length === 0 && skippedEntries >= 0 && (
        <p className="text-destructive text-sm">
          В файле не найдено выписок формата 1С (kl_to_1c).
        </p>
      )}

      {single1C && (
        <div className="border-border bg-muted/30 space-y-1 rounded-lg border px-3 py-2.5 text-sm">
          <p className="text-foreground font-medium">Формат 1С распознан</p>
          <p className="text-muted-foreground">Счёт: {single1C.accountNumber ?? "—"}</p>
          <p className="text-muted-foreground">
            Период: {single1C.dateStart ?? "—"} — {single1C.dateEnd ?? "—"}
          </p>
          <p className="text-muted-foreground">Операций: {single1C.operations}</p>
          {single1C.matchedAccountName && (
            <p className="text-muted-foreground">Счёт распознан: {single1C.matchedAccountName}</p>
          )}
        </div>
      )}

      {multi1C && (
        <div className="border-border bg-muted/30 space-y-2 rounded-lg border px-3 py-2.5 text-sm">
          <p className="text-foreground font-medium">
            Выписок в архиве: {parsed.length}
            {skippedEntries > 0 && (
              <span className="text-muted-foreground font-normal">
                {" "}
                (пропущено не-1С файлов: {skippedEntries})
              </span>
            )}
          </p>
          <ul className="space-y-1.5">
            {parsed.map((p) => (
              <li key={p.fileName} className="text-muted-foreground">
                <span className="text-foreground">••{p.accountNumber?.slice(-4) ?? "????"}</span>
                {" · "}
                {p.dateStart ?? "—"} — {p.dateEnd ?? "—"}
                {" · операций: "}
                {p.operations}
                {" · "}
                {p.matchedAccountName ?? (
                  <span className="text-amber-700">новый счёт</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {single1C && !single1C.matchedAccountName && (
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
