"use client";

import { useMemo } from "react";
import {
  financeAccountBalance,
  financeExpenseChart,
  financePeriodExpense,
  financePeriodIncome,
  type FinanceAccount,
  type FinanceArticle,
  type FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";
import { formatMoney } from "@/lib/format";
import { FinanceExpenseChart } from "@/components/finance/finance-expense-chart";
import { KpiTile } from "@/components/kpi-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface FinanceKpiBlockProps {
  rows: FinanceCashFlowRow[];
  accounts: FinanceAccount[];
  articles: FinanceArticle[];
}

export function FinanceKpiBlock({ rows, accounts, articles }: FinanceKpiBlockProps) {
  const balance = useMemo(() => financeAccountBalance(accounts), [accounts]);
  const income = useMemo(() => financePeriodIncome(rows), [rows]);
  const expense = useMemo(() => financePeriodExpense(rows), [rows]);
  const chart = useMemo(() => financeExpenseChart(rows, articles), [rows, articles]);

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
