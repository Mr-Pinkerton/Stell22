"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  salaryReportKpis,
  salaryReportRows,
  type SalaryReportRow,
} from "@/mocks/report-fixtures";
import { formatIsoDate, formatMoney } from "@/lib/format";
import { BanknoteTiles } from "@/components/reports/banknote-tiles";
import {
  ExpandableDetailRow,
  ExpandableMainHeader,
  ExpandableReportTable,
  NestedTable,
  NestedTableCell,
  expandableChevronClass,
  expandableColWidths6,
  expandableExpandedAccentClass,
  expandableExpandedChevronClass,
  expandableExpandedSummaryClass,
  expandableNestedWrapExpandedClass,
  expandableSummaryCellClass,
} from "@/components/reports/expandable-table";
import { KpiTile } from "@/components/kpi-tile";
import { filterSelectTriggerClass } from "@/components/filter-fields";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableCell, TableRow } from "@/components/ui/table";

const SALARY_HEADERS = [
  "Сотрудник",
  "К выплате",
  "Произведено",
  "В среднем",
  "Итого",
  "",
] as const;

const SALARY_DAY_HEADERS = ["Дата", "Часы", "Торцовка", "Присадка", "Упаковка", "Итого"];

export function ReportSalariesTab() {
  const [rows, setRows] = useState(salaryReportRows);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [billEmployeeId, setBillEmployeeId] = useState(
    () => salaryReportRows.find((r) => !r.paid)?.id ?? salaryReportRows[0]?.id ?? "",
  );

  const kpis = useMemo(() => salaryReportKpis(rows), [rows]);
  const unpaid = rows.filter((r) => !r.paid);
  const paid = rows.filter((r) => r.paid);
  const billRow = rows.find((r) => r.id === billEmployeeId) ?? unpaid[0];

  const markPaid = (id: string) => {
    setRows((prev) =>
      prev
        .map((r) =>
          r.id === id
            ? { ...r, paid: true, paidAt: new Date().toISOString().slice(0, 10) }
            : r,
        )
        .sort((a, b) => {
          if (a.paid !== b.paid) return a.paid ? 1 : -1;
          if (!a.paid && !b.paid) return b.total - a.total;
          return (b.paidAt ?? "").localeCompare(a.paidAt ?? "");
        }),
    );
    toast.success("Выплачено (прототип)");
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <KpiTile title="Работников" value={String(kpis.workerCount)} hint="невыплаченные" />
        <KpiTile title="Зарплата" value={formatMoney(kpis.totalSalary)} hint="к выплате" />
      </div>

      <Card className="surface-card ring-0 overflow-hidden">
        <ExpandableReportTable
          widths={expandableColWidths6}
          header={
            <ExpandableMainHeader labels={SALARY_HEADERS} />
          }
        >
          {unpaid.map((row, index) => (
            <SalaryRowGroup
              key={row.id}
              row={row}
              expanded={expandedId === row.id}
              striped={index % 2 === 1}
              onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
              onPaid={() => markPaid(row.id)}
            />
          ))}
          {paid.length > 0 && (
            <TableRow className="bg-muted/60 hover:bg-muted/60">
              <TableCell
                colSpan={6}
                className="text-muted-foreground px-5 py-2 text-xs font-semibold tracking-wide uppercase"
              >
                Выплаченные
              </TableCell>
            </TableRow>
          )}
          {paid.map((row, index) => (
            <SalaryRowGroup
              key={row.id}
              row={row}
              expanded={expandedId === row.id}
              striped={index % 2 === 1}
              onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
              paid
            />
          ))}
        </ExpandableReportTable>
      </Card>

      {billRow && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h3 className="text-sm font-semibold">Расчёт купюр</h3>
            <div className="grid min-w-[14rem] gap-1.5">
              <label htmlFor="bill-emp" className="text-muted-foreground text-xs font-medium">
                Сотрудник
              </label>
              <Select value={billEmployeeId} onValueChange={(v) => setBillEmployeeId(v ?? "")}>
                <SelectTrigger
                  id="bill-emp"
                  className={cn(filterSelectTriggerClass, "w-full min-w-[17.5rem]")}
                >
                  <SelectValue>{billRow.employeeName}</SelectValue>
                </SelectTrigger>
                <SelectContent className="rounded-xl shadow-balanced ring-0 p-1.5">
                  {rows.map((r) => (
                    <SelectItem key={r.id} value={r.id} className="cursor-pointer rounded-lg">
                      {r.employeeName} — {formatMoney(r.total)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <BanknoteTiles amount={billRow.total} />
        </section>
      )}
    </div>
  );
}

function SalaryRowGroup({
  row,
  expanded,
  striped,
  onToggle,
  onPaid,
  paid = false,
}: {
  row: SalaryReportRow;
  expanded: boolean;
  striped: boolean;
  onToggle: () => void;
  onPaid?: () => void;
  paid?: boolean;
}) {
  return (
    <Fragment>
      <TableRow
        className={cn(
          "cursor-pointer align-top",
          striped && !expanded && "bg-muted/40",
          expanded && expandableExpandedSummaryClass,
          !expanded && "hover:bg-muted/50",
        )}
        onClick={onToggle}
      >
        <TableCell className={cn(expandableSummaryCellClass, expanded && expandableExpandedAccentClass)}>
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className={cn(expandableChevronClass, expandableExpandedChevronClass)} />
            ) : (
              <ChevronRight className={expandableChevronClass} />
            )}
            <span className="font-medium">{row.employeeName}</span>
          </div>
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
          {formatMoney(row.amountDue)}
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
          {row.produced} шт
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
          {formatMoney(row.avgPerUnit)}
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center font-semibold tabular-nums")}>
          {formatMoney(row.total)}
        </TableCell>
        <TableCell
          className={cn(expandableSummaryCellClass, "text-center")}
          onClick={(e) => e.stopPropagation()}
        >
          {!paid && onPaid && (
            <Button
              type="button"
              variant="brand"
              className="h-8 rounded-lg px-3 text-xs"
              onClick={onPaid}
            >
              Выплачено
            </Button>
          )}
          {paid && row.paidAt && (
            <span className="text-muted-foreground text-xs">{formatIsoDate(row.paidAt)}</span>
          )}
        </TableCell>
      </TableRow>
      {expanded && (
        <ExpandableDetailRow colSpan={6}>
          <div className={expandableNestedWrapExpandedClass}>
            <NestedTable headers={SALARY_DAY_HEADERS} isEmpty={row.days.length === 0}>
              {row.days.map((d) => (
                <TableRow key={d.date}>
                  <NestedTableCell>{formatIsoDate(d.date)}</NestedTableCell>
                  <NestedTableCell className="text-center tabular-nums">
                    {d.hours ? d.hours : ""}
                  </NestedTableCell>
                  <NestedTableCell className="text-center tabular-nums">
                    {d.torcovka ? formatMoney(d.torcovka) : ""}
                  </NestedTableCell>
                  <NestedTableCell className="text-center tabular-nums">
                    {d.prisadka ? formatMoney(d.prisadka) : ""}
                  </NestedTableCell>
                  <NestedTableCell className="text-center tabular-nums">
                    {d.upakovka ? formatMoney(d.upakovka) : ""}
                  </NestedTableCell>
                  <NestedTableCell className="text-center font-medium tabular-nums">
                    {formatMoney(d.total)}
                  </NestedTableCell>
                </TableRow>
              ))}
            </NestedTable>
          </div>
        </ExpandableDetailRow>
      )}
    </Fragment>
  );
}
