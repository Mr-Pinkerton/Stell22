"use client";

import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  LOG_LEVEL_LABEL,
  systemLogRows,
  type LogLevel,
  type SystemLogRow,
} from "@/mocks/settings-fixtures";
import { cn } from "@/lib/utils";

function formatLogTime(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function levelVariant(level: LogLevel): "secondary" | "outline" | "destructive" {
  if (level === "ERROR") return "destructive";
  if (level === "WARN") return "outline";
  return "secondary";
}

const columns: Column<SystemLogRow>[] = [
  {
    key: "at",
    header: "Время",
    className: "w-36",
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
    className: "w-32",
    render: (row) => <span className="font-medium">{row.source}</span>,
  },
  {
    key: "message",
    header: "Сообщение",
    render: (row) => <span className="whitespace-normal">{row.message}</span>,
  },
];

interface SettingsLogsTabProps {
  rows?: SystemLogRow[];
}

export function SettingsLogsTab({ rows = systemLogRows }: SettingsLogsTabProps) {
  return (
    <Card className="surface-card ring-0">
      <CardContent className="p-0">
        <DataTable columns={columns} rows={rows} empty="Логов нет" padded className="border-0" />
      </CardContent>
    </Card>
  );
}
