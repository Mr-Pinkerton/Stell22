"use client";

import { Upload } from "lucide-react";
import { formatIsoDate } from "@/lib/format";
import { DataTable, type Column } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import type { FinanceStatementRow } from "@/mocks/finance-fixtures";

interface FinanceStatementsTabProps {
  statements: FinanceStatementRow[];
  onUploadRequest?: () => void;
}

export function FinanceStatementsTab({
  statements,
  onUploadRequest,
}: FinanceStatementsTabProps) {
  const columns: Column<FinanceStatementRow>[] = [
    {
      key: "date",
      header: "Дата",
      className: "tabular-nums font-medium",
      render: (row) => formatIsoDate(row.date),
    },
    {
      key: "account",
      header: "Счёт",
      render: (row) => row.accountName ?? "—",
    },
    {
      key: "operations",
      header: "Операций",
      className: "tabular-nums",
      render: (row) => row.operationsCount,
    },
    {
      key: "unassigned",
      header: "Не разнесено",
      className: "tabular-nums",
      render: (row) =>
        row.unassignedCount > 0 ? (
          <span className="text-amber-700">{row.unassignedCount}</span>
        ) : (
          "0"
        ),
    },
    {
      key: "status",
      header: "Статус",
      render: (row) => (
        <Badge variant={row.uploaded ? "secondary" : "outline"}>
          {row.uploaded ? "Загружена" : "Нет выписки"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "w-36",
      render: (row) => (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            className="h-8 rounded-lg px-3 text-xs"
            onClick={() => onUploadRequest?.()}
          >
            <Upload className="size-3.5" />
            {row.uploaded ? "Перезагрузить" : "Загрузить"}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Card className="surface-card ring-0">
      <CardContent className="p-0">
        <DataTable
          columns={columns}
          rows={statements}
          empty="Выписок нет"
          className="border-0"
          padded
        />
      </CardContent>
    </Card>
  );
}
