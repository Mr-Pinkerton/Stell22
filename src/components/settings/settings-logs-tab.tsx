"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LOG_LEVEL_LABEL, type LogLevel, type SystemLogRow } from "@/mocks/settings-fixtures";
import { cn } from "@/lib/utils";
import { TIME_ZONE } from "@/lib/format";
import { scrollThinY } from "@/lib/scroll-classes";

type LogFilter = "all" | LogLevel;

function formatLogTime(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

function levelVariant(level: LogLevel): "secondary" | "outline" | "destructive" {
  if (level === "ERROR") return "destructive";
  if (level === "WARN") return "outline";
  return "secondary";
}

function formatDetails(details: Record<string, unknown>): string {
  return JSON.stringify(details, null, 2);
}

function LogDetailsPanel({ details }: { details: Record<string, unknown> }) {
  return (
    <pre
      className={cn(
        scrollThinY,
        "bg-muted/60 text-muted-foreground mt-2 max-h-48 overflow-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap",
      )}
    >
      {formatDetails(details)}
    </pre>
  );
}

function LogMessageCell({ row }: { row: SystemLogRow }) {
  const [open, setOpen] = useState(false);
  const hasDetails = row.kind === "system" && row.details && Object.keys(row.details).length > 0;

  return (
    <div className="min-w-0">
      <div className="flex items-start gap-1">
        {hasDetails ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mt-0.5 size-6 shrink-0"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Скрыть детали" : "Показать детали"}
          >
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </Button>
        ) : (
          <span className="size-6 shrink-0" />
        )}
        <div className="min-w-0">
          <p className="whitespace-normal">{row.message}</p>
          {row.kind === "audit" && (
            <p className="text-muted-foreground mt-0.5 text-xs">аудит изменений</p>
          )}
          {open && hasDetails && row.details && <LogDetailsPanel details={row.details} />}
        </div>
      </div>
    </div>
  );
}

const FILTER_OPTIONS: { key: LogFilter; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "ERROR", label: "Ошибки" },
  { key: "WARN", label: "Предупр." },
  { key: "INFO", label: "Инфо" },
];

interface SettingsLogsTabProps {
  rows: SystemLogRow[];
}

export function SettingsLogsTab({ rows }: SettingsLogsTabProps) {
  const [filter, setFilter] = useState<LogFilter>("all");

  const filtered = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.level === filter)),
    [rows, filter],
  );

  const columns: Column<SystemLogRow>[] = [
    {
      key: "at",
      header: "Время",
      className: "w-40",
      render: (row) => (
        <span className="text-muted-foreground whitespace-nowrap tabular-nums">
          {formatLogTime(row.at)}
        </span>
      ),
    },
    {
      key: "level",
      header: "Уровень",
      className: "w-28",
      render: (row) => (
        <Badge
          variant={levelVariant(row.level)}
          className={cn(row.level === "WARN" && "border-amber-300 text-amber-800")}
        >
          {LOG_LEVEL_LABEL[row.level]}
        </Badge>
      ),
    },
    {
      key: "source",
      header: "Источник",
      className: "w-36",
      render: (row) => <span className="font-medium">{row.source}</span>,
    },
    {
      key: "message",
      header: "Сообщение",
      render: (row) => <LogMessageCell row={row} />,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {FILTER_OPTIONS.map((opt) => (
          <Button
            key={opt.key}
            type="button"
            size="sm"
            variant={filter === opt.key ? "default" : "outline"}
            className="h-8 rounded-lg px-3"
            onClick={() => setFilter(opt.key)}
          >
            {opt.label}
            {opt.key !== "all" && (
              <span className="text-muted-foreground ml-1 tabular-nums">
                ({rows.filter((r) => r.level === opt.key).length})
              </span>
            )}
          </Button>
        ))}
      </div>
      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            rows={filtered}
            empty="Логов нет"
            padded
            className="border-0"
          />
        </CardContent>
      </Card>
    </div>
  );
}
