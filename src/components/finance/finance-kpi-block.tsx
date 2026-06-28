"use client";

import { useMemo } from "react";
import {
  financeAccountBalance,
  financeExpenseChart,
  financePeriodExpense,
  financePeriodIncome,
  financeAccounts,
  financeArticles,
  financeCashFlows,
  type FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";
import { formatMoney } from "@/lib/format";
import { FinanceExpenseChart } from "@/components/finance/finance-expense-chart";
import { KpiTile } from "@/components/kpi-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface FinanceKpiBlockProps {
  rows?: FinanceCashFlowRow[];
}

export function FinanceKpiBlock({ rows = financeCashFlows }: FinanceKpiBlockProps) {
  const balance = useMemo(() => financeAccountBalance(financeAccounts), []);
  const income = useMemo(() => financePeriodIncome(rows), [rows]);
  const expense = useMemo(() => financePeriodExpense(rows), [rows]);
  const chart = useMemo(() => financeExpenseChart(rows, financeArticles), [rows]);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_minmax(11rem,13rem)]">
      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile title="Остаток на счетах" value={formatMoney(balance)} hint="на текущую дату" />
        <KpiTile title="Поступления" value={formatMoney(income)} hint="за период" />
        <KpiTile title="Расходы" value={formatMoney(expense)} hint="за период" />
      </div>
      <Card className="surface-card ring-0">
        <CardHeader className="pb-2">
          <CardTitle className="text-muted-foreground text-sm font-medium">
            Расходы по статьям
          </CardTitle>
        </CardHeader>
        <CardContent>
          <FinanceExpenseChart slices={chart} />
        </CardContent>
      </Card>
    </div>
  );
}
