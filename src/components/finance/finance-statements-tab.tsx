"use client";

import { useState } from "react";
import { Eye, Trash2, Upload } from "lucide-react";
import { formatIsoDate, formatMoney } from "@/lib/format";
import { DataTable, type Column } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FinanceFormDialog } from "@/components/finance/finance-form-shared";
import { NestedTable, NestedTableCell } from "@/components/reports/expandable-table";
import { TableRow } from "@/components/ui/table";

import type { FinanceCashFlowRow, FinanceStatementRow } from "@/mocks/finance-fixtures";

const iconActionClass =
  "text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const iconDestructiveClass =
  "text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

interface FinanceStatementsTabProps {
  statements: FinanceStatementRow[];
  onUploadRequest?: () => void;
  onLoadDetail?: (id: string) => Promise<FinanceCashFlowRow[]>;
  onDelete?: (id: string) => void;
}

export function FinanceStatementsTab({
  statements,
  onUploadRequest,
  onLoadDetail,
  onDelete,
}: FinanceStatementsTabProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailRows, setDetailRows] = useState<FinanceCashFlowRow[] | null>(null);

  const openDetail = async (id: string) => {
    setDetailRows(null);
    setDetailOpen(true);
    const rows = (await onLoadDetail?.(id)) ?? [];
    setDetailRows(rows);
  };

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
      className: "w-44",
      render: (row) => (
        <div className="flex items-center justify-center gap-0.5">
          {row.operationsCount > 0 && onLoadDetail && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={iconActionClass}
                    onClick={() => void openDetail(row.id)}
                  >
                    <Eye />
                  </Button>
                }
              />
              <TooltipContent>Операции выписки</TooltipContent>
            </Tooltip>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-8 rounded-lg px-3 text-xs"
            onClick={() => onUploadRequest?.()}
          >
            <Upload className="size-3.5" />
            {row.uploaded ? "Перезагрузить" : "Загрузить"}
          </Button>
          {onDelete && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={iconDestructiveClass}
                    onClick={() => onDelete(row.id)}
                  >
                    <Trash2 />
                  </Button>
                }
              />
              <TooltipContent>Откатить выписку</TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
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

      <FinanceFormDialog
        open={detailOpen}
        title="Операции выписки"
        onOpenChange={setDetailOpen}
        onSubmit={() => setDetailOpen(false)}
        submitLabel="Закрыть"
        maxWidth="sm:max-w-2xl"
      >
        {detailRows === null ? (
          <p className="text-muted-foreground text-sm">Загрузка…</p>
        ) : (
          <NestedTable
            headers={["Дата", "Тип", "Контрагент", "Статья", "Сумма"]}
            isEmpty={detailRows.length === 0}
          >
            {detailRows.map((r) => (
              <TableRow key={r.id}>
                <NestedTableCell className="tabular-nums">{formatIsoDate(r.date)}</NestedTableCell>
                <NestedTableCell>{r.flowType === "INCOME" ? "Поступление" : "Расход"}</NestedTableCell>
                <NestedTableCell>{r.counterpartyName ?? "—"}</NestedTableCell>
                <NestedTableCell>
                  {r.articleName ?? <span className="text-amber-700">не разнесено</span>}
                </NestedTableCell>
                <NestedTableCell className="text-right tabular-nums">
                  {formatMoney(r.amount)}
                </NestedTableCell>
              </TableRow>
            ))}
          </NestedTable>
        )}
      </FinanceFormDialog>
    </>
  );
}
