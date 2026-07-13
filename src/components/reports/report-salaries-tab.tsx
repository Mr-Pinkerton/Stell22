"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { salaryReportKpis, type SalaryReportRow } from "@/mocks/report-fixtures";
import { markEmployeePaid } from "@/server/payroll";
import { formatIsoDate, formatMoney } from "@/lib/format";
import { aggregateBanknotes } from "@/lib/cash-bills";
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

/** Сводная строка в селекте купюр — сумма по невыплаченным. */
const ALL_UNPAID_BILLS = "all-unpaid";

const billSelectTriggerClass = cn(
  filterSelectTriggerClass,
  "h-10 w-full min-w-[17.6rem] sm:min-w-[20.8rem]",
);

export function ReportSalariesTab({ initialRows }: { initialRows: SalaryReportRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [billEmployeeId, setBillEmployeeId] = useState(() =>
    initialRows.some((r) => !r.paid)
      ? ALL_UNPAID_BILLS
      : (initialRows[0]?.id ?? ALL_UNPAID_BILLS),
  );
  const [isPending, startTransition] = useTransition();

  const kpis = useMemo(() => salaryReportKpis(rows), [rows]);
  const unpaid = rows.filter((r) => !r.paid);
  const paid = rows.filter((r) => r.paid);

  const billView = useMemo(() => {
    if (billEmployeeId === ALL_UNPAID_BILLS && unpaid.length > 0) {
      const total = unpaid.reduce((sum, r) => sum + r.total, 0);
      return {
        label: `Все сотрудники — ${formatMoney(total)}`,
        bills: aggregateBanknotes(unpaid.map((r) => r.total)).bills,
      };
    }
    const row =
      rows.find((r) => r.id === billEmployeeId) ?? unpaid[0] ?? rows[0];
    if (!row) return null;
    return {
      label: `${row.employeeName} — ${formatMoney(row.total)}`,
      amount: row.total,
    };
  }, [billEmployeeId, rows, unpaid]);

  const markPaid = (row: SalaryReportRow) => {
    const employeeId = row.id.replace(/^unpaid:/, "");
    startTransition(async () => {
      try {
        const fresh = await markEmployeePaid(employeeId);
        setRows(fresh);
        setBillEmployeeId(
          fresh.some((r) => !r.paid) ? ALL_UNPAID_BILLS : fresh[0]?.id ?? ALL_UNPAID_BILLS,
        );
        toast.success("Выплата проведена");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Не удалось провести выплату");
      }
    });
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
              onPaid={() => markPaid(row)}
              pending={isPending}
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

      {billView && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h3 className="text-sm font-semibold">Расчёт купюр</h3>
            <div className="grid w-full max-w-[28.8rem] gap-1.5 sm:w-auto">
              <label htmlFor="bill-emp" className="text-muted-foreground text-xs font-medium">
                Сотрудник
              </label>
              <Select value={billEmployeeId} onValueChange={(v) => setBillEmployeeId(v ?? "")}>
                <SelectTrigger id="bill-emp" className={billSelectTriggerClass}>
                  <SelectValue>{billView.label}</SelectValue>
                </SelectTrigger>
                <SelectContent className="min-w-[var(--anchor-width)] rounded-xl p-1.5 shadow-balanced ring-0">
                  {unpaid.length > 0 && (
                    <SelectItem
                      value={ALL_UNPAID_BILLS}
                      className="cursor-pointer rounded-lg pr-10"
                    >
                      Все сотрудники — {formatMoney(unpaid.reduce((s, r) => s + r.total, 0))}
                    </SelectItem>
                  )}
                  {rows.map((r) => (
                    <SelectItem
                      key={r.id}
                      value={r.id}
                      className="cursor-pointer rounded-lg pr-10"
                    >
                      {r.employeeName} — {formatMoney(r.total)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {"bills" in billView ? (
            <BanknoteTiles bills={billView.bills} />
          ) : (
            <BanknoteTiles amount={billView.amount} />
          )}
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
  pending = false,
}: {
  row: SalaryReportRow;
  expanded: boolean;
  striped: boolean;
  onToggle: () => void;
  onPaid?: () => void;
  paid?: boolean;
  pending?: boolean;
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
              disabled={pending}
              onClick={onPaid}
            >
              Выплатить
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
