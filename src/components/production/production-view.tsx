"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { getDefaultDateFilterValue, type DateFilterValue } from "@/components/date-filter";
import {
  productionEntries as mockProductionEntries,
  type ProductionDetailLine,
  type ProductionEntryRow,
} from "@/mocks/production-fixtures";
import {
  filterProductionEntries,
  formatChangeLogWhen,
  formatEntryTime,
  OPERATION_TYPE_LABEL,
  OPERATION_TYPE_UNIT,
  sortProductionEntries,
} from "@/lib/production-entries";
import { formatIsoDate, formatLength, formatMoney } from "@/lib/format";
import { scrollTableYClass } from "@/lib/scroll-classes";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import {
  ExpandableDetailRow,
  expandableChevronClass,
  expandableExpandedAccentClass,
  expandableExpandedChevronClass,
  expandableExpandedDetailClass,
  expandableExpandedSummaryClass,
  expandableNestedWrapExpandedClass,
  expandableSummaryCellClass,
  NestedTable,
  NestedTableCell,
} from "@/components/reports/expandable-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const COL_SPAN = 6;
const COL_WIDTHS = ["13%", "9%", "28%", "14%", "16%", "12%"] as const;

const cellPad = "px-3 first:pl-5 last:pr-5 md:first:pl-6 md:last:pr-6";

const headClass = "bg-card text-base font-semibold h-11 align-middle";

const headLeftClass = cn(headClass, "text-left");

const headCenterClass = cn(headClass, "text-center");

const stickyHeadRowClass =
  "sticky top-0 z-20 bg-card shadow-[0_1px_0_0_var(--border)] hover:bg-card";

const tableActionDestructiveClass =
  "text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const DETAIL_HEADERS = [
  "Деталь",
  "Операция",
  "С терминала",
  "Исправить",
  "",
] as const;

const CHANGE_LOG_HEADERS = ["Когда", "Кто", "Поле", "Было", "Стало"] as const;

interface DetailEditRow {
  index: number;
  detailName: string;
  operationLabel: string;
  terminalQty: number;
}

export function ProductionView() {
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(getDefaultDateFilterValue);
  const [entries, setEntries] = useState(mockProductionEntries);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const filtered = filterProductionEntries(entries, dateFilter);
    return sortProductionEntries(filtered);
  }, [entries, dateFilter]);

  const handleDelete = (id: string) => {
    const row = entries.find((e) => e.id === id);
    if (!row) return;
    if (row.isPaid) {
      toast.error("Нельзя удалить — операция уже выплачена");
      return;
    }
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setExpandedId((cur) => (cur === id ? null : cur));
    toast.success("Операция удалена (прототип)");
  };

  const handleSaveQuantity = (id: string, lineIndex: number, newQty: number) => {
    if (!Number.isFinite(newQty) || newQty <= 0) {
      toast.error("Укажите положительное количество");
      return;
    }

    setEntries((prev) =>
      prev.map((row) => {
        if (row.id !== id || row.isPaid) return row;

        const editRows = buildDetailEditRows(row);
        const target = editRows[lineIndex];
        if (!target || target.terminalQty === newQty) return row;

        const logEntry = {
          id: `log-${Date.now()}`,
          changedAt: new Date().toISOString(),
          userName: "Админ",
          field: "Количество",
          oldValue: String(target.terminalQty),
          newValue: String(newQty),
        };

        let detailLines = row.detailLines;
        if (detailLines && detailLines.length > 0) {
          detailLines = detailLines.map((line, i) =>
            i === lineIndex ? { ...line, quantity: newQty } : line,
          );
        }

        const quantity =
          detailLines && detailLines.length > 1
            ? detailLines.reduce((sum, l) => sum + l.quantity, 0)
            : newQty;

        return {
          ...row,
          quantity,
          amount: Math.round(quantity * row.unitRate * 100) / 100,
          detailLines,
          changeLog: [logEntry, ...row.changeLog],
        };
      }),
    );
    toast.success("Операция обновлена — пересчёт предварительной себестоимости (прототип)");
  };

  return (
    <>
      <PageHeader
        title="Производство"
        canExport
        addLabel="Добавить"
        onExport={() => toast.message("Экспорт — прототип")}
        onAdd={() => toast.message("Добавление операции — прототип")}
      />

      <FiltersBar
        date
        dateFilterValue={dateFilter}
        onDateFilterChange={setDateFilter}
      />

      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          <div className={scrollTableYClass}>
            <table className="w-full table-fixed border-collapse text-sm">
              <colgroup>
                {COL_WIDTHS.map((width, i) => (
                  <col key={i} style={{ width }} />
                ))}
              </colgroup>
              <TableHeader className="[&_tr]:border-b">
                <TableRow className={stickyHeadRowClass}>
                  <TableHead className={cn(cellPad, headLeftClass)}>Дата</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass)}>Время</TableHead>
                  <TableHead className={cn(cellPad, headLeftClass)}>ФИО</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass)}>Сумма</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass)}>Статус</TableHead>
                  <TableHead className={cn(cellPad, headCenterClass, "w-14")} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={COL_SPAN}
                      className={cn(cellPad, "text-muted-foreground h-24 text-center")}
                    >
                      Внесений за период нет
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row, index) => (
                    <ProductionRowGroup
                      key={row.id}
                      row={row}
                      expanded={expandedId === row.id}
                      striped={index % 2 === 1}
                      onToggle={() =>
                        setExpandedId((id) => (id === row.id ? null : row.id))
                      }
                      onDelete={() => handleDelete(row.id)}
                      onSaveQuantity={(lineIndex, qty) =>
                        handleSaveQuantity(row.id, lineIndex, qty)
                      }
                    />
                  ))
                )}
              </TableBody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function ProductionRowGroup({
  row,
  expanded,
  striped,
  onToggle,
  onDelete,
  onSaveQuantity,
}: {
  row: ProductionEntryRow;
  expanded: boolean;
  striped: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSaveQuantity: (lineIndex: number, qty: number) => void;
}) {
  const editRows = useMemo(() => buildDetailEditRows(row), [row]);
  const [editQty, setEditQty] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!expanded) return;
    const next: Record<number, string> = {};
    for (const line of editRows) {
      next[line.index] = String(line.terminalQty);
    }
    setEditQty(next);
  }, [expanded, row.id, row.quantity, editRows]);

  return (
    <Fragment>
      <TableRow
        className={cn(
          "cursor-pointer align-middle",
          striped && !expanded && "bg-muted/40",
          expanded && expandableExpandedSummaryClass,
          !expanded && "hover:bg-muted/50",
        )}
        onClick={onToggle}
      >
        <TableCell
          className={cn(
            expandableSummaryCellClass,
            expanded && expandableExpandedAccentClass,
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {expanded ? (
              <ChevronDown
                className={cn(expandableChevronClass, expandableExpandedChevronClass)}
              />
            ) : (
              <ChevronRight className={expandableChevronClass} />
            )}
            <span className="truncate tabular-nums">{formatIsoDate(row.workDate)}</span>
          </div>
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
          {formatEntryTime(row.createdAt)}
        </TableCell>
        <TableCell className={expandableSummaryCellClass}>
          <span className="block truncate font-medium">{row.employeeName}</span>
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center font-medium tabular-nums")}>
          {formatMoney(row.amount)}
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center")}>
          <Badge variant={row.isPaid ? "outline" : "secondary"}>
            {row.isPaid ? "Выплачено" : "Не выплачено"}
          </Badge>
        </TableCell>
        <TableCell
          className={cn(expandableSummaryCellClass, "text-center")}
          onClick={(e) => e.stopPropagation()}
        >
          {!row.isPaid && (
            <div className="flex justify-center">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={tableActionDestructiveClass}
                      onClick={onDelete}
                    >
                      <Trash2 />
                    </Button>
                  }
                />
                <TooltipContent>Удалить</TooltipContent>
              </Tooltip>
            </div>
          )}
        </TableCell>
      </TableRow>

      {expanded && (
        <ExpandableDetailRow colSpan={COL_SPAN} className={expandableExpandedDetailClass}>
          <div className={expandableNestedWrapExpandedClass}>
            <ProductionEntryDetail
              row={row}
              editRows={editRows}
              editQty={editQty}
              onEditQtyChange={(index, value) =>
                setEditQty((prev) => ({ ...prev, [index]: value }))
              }
              onSaveLine={(index) => onSaveQuantity(index, Number(editQty[index]))}
            />
          </div>
        </ExpandableDetailRow>
      )}
    </Fragment>
  );
}

function ProductionEntryDetail({
  row,
  editRows,
  editQty,
  onEditQtyChange,
  onSaveLine,
}: {
  row: ProductionEntryRow;
  editRows: DetailEditRow[];
  editQty: Record<number, string>;
  onEditQtyChange: (index: number, value: string) => void;
  onSaveLine: (index: number) => void;
}) {
  const unit = OPERATION_TYPE_UNIT[row.type];

  return (
    <div className="space-y-4">
      <p className="text-foreground pl-1 text-sm leading-relaxed">
        <span className="font-semibold">{OPERATION_TYPE_LABEL[row.type]}</span>
        <span className="text-muted-foreground"> · </span>
        <span>{row.batchName ?? "—"}</span>
        <span className="text-muted-foreground"> · </span>
        <span>
          {row.railsTaken != null && row.railLengthM != null
            ? `${row.railsTaken} × ${formatLength(row.railLengthM)}`
            : "—"}
        </span>
        <span className="text-muted-foreground"> · </span>
        <span className="tabular-nums">
          {row.quantity} {unit}
        </span>
        <span className="text-muted-foreground"> · </span>
        <span className="font-semibold tabular-nums">{formatMoney(row.amount)}</span>
      </p>

      <NestedTable headers={[...DETAIL_HEADERS]} isEmpty={editRows.length === 0} empty="Нет строк">
        {editRows.map((line) => {
          const raw = editQty[line.index] ?? String(line.terminalQty);
          const parsed = Number(raw);
          const hasChange =
            !row.isPaid && Number.isFinite(parsed) && parsed > 0 && parsed !== line.terminalQty;

          return (
            <TableRow key={`${row.id}-line-${line.index}`}>
              <NestedTableCell className="font-medium whitespace-normal">
                {line.detailName}
              </NestedTableCell>
              <NestedTableCell className="text-center whitespace-normal">
                {line.operationLabel}
              </NestedTableCell>
              <NestedTableCell className="text-center tabular-nums">
                {line.terminalQty}
              </NestedTableCell>
              <NestedTableCell className="text-center">
                {row.isPaid ? (
                  <span className="text-muted-foreground tabular-nums">—</span>
                ) : (
                  <Input
                    type="number"
                    min={1}
                    value={raw}
                    onChange={(e) => onEditQtyChange(line.index, e.target.value)}
                    className="border-border mx-auto h-9 w-24 rounded-lg text-center tabular-nums"
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </NestedTableCell>
              <NestedTableCell className="text-right">
                {!row.isPaid && (
                  <div className="flex justify-end">
                    <Button
                    type="button"
                    size="sm"
                    variant={hasChange ? "brand" : "outline"}
                    disabled={!hasChange}
                    className={cn(
                      "h-9 min-w-[6.5rem] rounded-xl px-4",
                      !hasChange &&
                        "text-muted-foreground border-border/50 bg-muted/25 hover:bg-muted/25",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSaveLine(line.index);
                    }}
                    >
                      Сохранить
                    </Button>
                  </div>
                )}
              </NestedTableCell>
            </TableRow>
          );
        })}
      </NestedTable>

      {row.changeLog.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Журнал изменений</p>
          <NestedTable
            headers={[...CHANGE_LOG_HEADERS]}
            isEmpty={row.changeLog.length === 0}
            empty="Изменений не было"
          >
            {row.changeLog.map((log) => (
              <TableRow key={log.id}>
                <NestedTableCell className="whitespace-nowrap tabular-nums">
                  {formatChangeLogWhen(log.changedAt)}
                </NestedTableCell>
                <NestedTableCell>{log.userName}</NestedTableCell>
                <NestedTableCell className="text-center">{log.field}</NestedTableCell>
                <NestedTableCell className="text-center tabular-nums">
                  {log.oldValue}
                </NestedTableCell>
                <NestedTableCell className="text-center tabular-nums">
                  {log.newValue}
                </NestedTableCell>
              </TableRow>
            ))}
          </NestedTable>
        </div>
      )}

      {row.isPaid && (
        <p className="text-muted-foreground pl-1 text-xs leading-relaxed">
          Операция выплачена — редактирование и удаление недоступны.
        </p>
      )}
    </div>
  );
}

function buildDetailEditRows(row: ProductionEntryRow): DetailEditRow[] {
  if (row.detailLines && row.detailLines.length > 0) {
    return row.detailLines.map((line, index) => ({
      index,
      detailName: line.detailName,
      operationLabel: lineOperationLabel(row.type, line),
      terminalQty: line.quantity,
    }));
  }

  return [
    {
      index: 0,
      detailName: row.productName ?? "—",
      operationLabel: OPERATION_TYPE_LABEL[row.type],
      terminalQty: row.quantity,
    },
  ];
}

function lineOperationLabel(type: ProductionEntryRow["type"], line: ProductionDetailLine): string {
  if (type !== "PRISADKA") return OPERATION_TYPE_LABEL[type];

  const parts = [
    line.prisadkaTorcevaya && "Торцевая",
    line.prisadkaPloskost && "Плоскостная",
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : OPERATION_TYPE_LABEL.PRISADKA;
}
