"use client";

import { useMemo, useState } from "react";
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
import { KpiTile } from "@/components/kpi-tile";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "Сотрудник",
                "К выплате",
                "Произведено",
                "В среднем",
                "Итого",
                "",
              ].map((h, i) => (
                <TableHead
                  key={h || "act"}
                  className={cn(
                    "bg-card h-11 px-4 text-base font-semibold first:pl-5 last:pr-5",
                    i > 0 && "text-center",
                  )}
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {unpaid.map((row, index) => (
              <SalaryRows
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
                <TableCell colSpan={6} className="text-muted-foreground px-5 py-2 text-xs font-semibold tracking-wide uppercase">
                  Выплаченные
                </TableCell>
              </TableRow>
            )}
            {paid.map((row, index) => (
              <SalaryRows
                key={row.id}
                row={row}
                expanded={expandedId === row.id}
                striped={index % 2 === 1}
                onToggle={() => setExpandedId(expandedId === row.id ? null : row.id)}
                paid
              />
            ))}
          </TableBody>
        </Table>
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
                  className="border-border bg-card h-10 w-full min-w-[16rem] cursor-pointer rounded-xl border px-4"
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

function SalaryRows({
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
    <>
      <TableRow
        className={cn("cursor-pointer", striped && "bg-muted/40", expanded && "bg-muted/30")}
        onClick={onToggle}
      >
        <TableCell className="px-5 py-3">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="text-muted-foreground size-4 shrink-0" />
            ) : (
              <ChevronRight className="text-muted-foreground size-4 shrink-0" />
            )}
            <span className="font-medium">{row.employeeName}</span>
          </div>
        </TableCell>
        <TableCell className="text-center tabular-nums">{formatMoney(row.amountDue)}</TableCell>
        <TableCell className="text-center tabular-nums">{row.produced} шт</TableCell>
        <TableCell className="text-center tabular-nums">{formatMoney(row.avgPerUnit)}</TableCell>
        <TableCell className="text-center font-semibold tabular-nums">
          {formatMoney(row.total)}
        </TableCell>
        <TableCell className="px-4 text-center" onClick={(e) => e.stopPropagation()}>
          {!paid && onPaid && (
            <Button
              type="button"
              variant="outline"
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
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={6} className="px-5 py-4">
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Дата</TableHead>
                    <TableHead className="text-center">Часы</TableHead>
                    <TableHead className="text-center">Торцовка</TableHead>
                    <TableHead className="text-center">Присадка</TableHead>
                    <TableHead className="text-center">Упаковка</TableHead>
                    <TableHead className="text-center">Итого</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {row.days.map((d) => (
                    <TableRow key={d.date}>
                      <TableCell>{formatIsoDate(d.date)}</TableCell>
                      <TableCell className="text-center tabular-nums">
                        {d.hours ? d.hours : ""}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {d.torcovka ? formatMoney(d.torcovka) : ""}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {d.prisadka ? formatMoney(d.prisadka) : ""}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {d.upakovka ? formatMoney(d.upakovka) : ""}
                      </TableCell>
                      <TableCell className="text-center font-medium tabular-nums">
                        {formatMoney(d.total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
