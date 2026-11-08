"use client";

import { useState } from "react";
import { Eye, Trash2, Upload } from "lucide-react";
import { formatIsoDate, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DataTable, type Column } from "@/components/data-table";
import { TableFilterSlot, tableHeaderClassName, tableSurfaceCardClass } from "@/components/table-surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FinanceFormDialog } from "@/components/finance/finance-form-shared";
import { NestedTable, NestedTableCell } from "@/components/reports/expandable-table";
import { TableRow } from "@/components/ui/table";

import type { FinanceCashFlowRow, FinanceStatementRow } from "@/mocks/finance-fixtures";
import { reportingGapLines, type AccountCoverageSummary } from "@/lib/bank-statement-integrity";
import { scrollThinY } from "@/lib/scroll-classes";
import { tableActionClass, tableActionDestructiveClass } from "@/components/nomenclature/form-shared";

interface FinanceStatementsTabProps {
  filters?: React.ReactNode;
  statements: FinanceStatementRow[];
  coverage?: AccountCoverageSummary[];
  asOf?: string;
  onUploadRequest?: () => void;
  onLoadDetail?: (id: string) => Promise<FinanceCashFlowRow[]>;
  onDelete?: (id: string) => void;
}

export function FinanceStatementsTab({
  filters,
  statements,
  coverage = [],
  asOf,
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

  const canDelete = (row: FinanceStatementRow) =>
    row.periodStatus !== "VERIFIED" &&
    row.periodStatus !== "UNKNOWN" &&
    row.source !== "BANK_1C" &&
    row.operationsCount === 0;

  const columns: Column<FinanceStatementRow>[] = [
    {
      key: "date",
      header: "Период",
      className: "tabular-nums font-medium",
      render: (row) =>
        row.periodStart && row.periodEnd
          ? `${formatIsoDate(row.periodStart)} — ${formatIsoDate(row.periodEnd)}`
          : "Период неизвестен",
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
      header: "Источник",
      render: (row) => (
        <div className="flex flex-col gap-1">
          <Badge variant={row.periodStatus === "VERIFIED" ? "secondary" : "outline"}>
            {row.source === "BANK_1C"
              ? "Банк"
              : row.source === "MANUAL"
                ? "Вручную"
                : "Источник неизвестен"}
          </Badge>
          {(row.overlapDates?.length ?? 0) > 0 && (
            <span className="text-xs text-red-700">
              Пересечение периодов: {row.overlapDates?.map((day) => formatIsoDate(day)).join(", ")}
            </span>
          )}
          {row.mismatch && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="outline" className="border-red-300 text-red-600">
                    ≠
                  </Badge>
                }
              />
              <TooltipContent>
                «Конечный остаток» выписки не совпал с расчётным
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "min-w-56 whitespace-nowrap",
      render: (row) => (
        <div className="flex w-full items-center justify-end gap-0.5">
          {row.operationsCount > 0 && onLoadDetail && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={tableActionClass}
                    aria-label="Операции выписки"
                    onClick={() => void openDetail(row.id)}
                  >
                    <Eye />
                  </Button>
                }
              />
              <TooltipContent>Операции выписки</TooltipContent>
            </Tooltip>
          )}
          {onDelete && canDelete(row) && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={tableActionDestructiveClass}
                    aria-label="Откатить выписку"
                    onClick={() => onDelete(row.id)}
                  >
                    <Trash2 />
                  </Button>
                }
              />
              <TooltipContent>Откатить выписку</TooltipContent>
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
        </div>
      ),
    },
  ];

  return (
    <>
      {coverage.length > 0 && (
        <Card className="mb-4">
          <CardContent className={cn("space-y-3 p-4", scrollThinY, "max-h-72")}>
            <p className="text-sm font-medium">
              Покрытие по счетам{asOf ? ` на ${formatIsoDate(asOf)}` : ""}
            </p>
            {coverage.map((row) => (
              <div key={row.accountId} className="text-sm">
                <p className="font-medium">{row.accountName}</p>
                {row.status === "UNKNOWN" ? (
                  <p className="text-muted-foreground">
                    Нет доказанного периода. Дни до первой проверенной выписки не считаются пропуском.
                  </p>
                ) : (
                  <div className="text-muted-foreground space-y-1">
                    <p>
                      Покрыто:{" "}
                      {row.coveredRanges.length
                        ? row.coveredRanges
                            .map((range) => `${formatIsoDate(range.start)} — ${formatIsoDate(range.end)}`)
                            .join("; ")
                        : "нет цельного диапазона"}
                    </p>
                    <p>
                      Пропуски рабочих дней:{" "}
                      {row.missingDates.length ? row.missingDates.map(formatIsoDate).join(", ") : "нет"}
                    </p>
                    <p>
                      Пересечения:{" "}
                      {row.overlappingDates.length
                        ? row.overlappingDates.map((day) => formatIsoDate(day.date)).join(", ")
                        : "нет"}
                    </p>
                    <p>
                      После последней выписки
                      {row.trailingFrom && row.trailingTo
                        ? ` ${formatIsoDate(row.trailingFrom)} — ${formatIsoDate(row.trailingTo)}`
                        : ": нет"}
                      {row.trailingBusinessDates.length
                        ? `. Рабочие дни без выписки: ${row.trailingBusinessDates.map(formatIsoDate).join(", ")}`
                        : ""}
                    </p>
                    {reportingGapLines(row.possibleGapDates).map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Card className={tableSurfaceCardClass}>
        <CardContent className="p-0">
          <TableFilterSlot filters={filters} />
          <DataTable
            columns={columns}
            rows={statements}
            empty="Выписок нет"
            className="border-0"
            padded
            headerClassName={tableHeaderClassName}
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
            empty="Нет операций"
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
