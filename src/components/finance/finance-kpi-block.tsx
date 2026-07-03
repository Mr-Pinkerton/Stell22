"use client";

import { useMemo } from "react";
import {
  financeExpenseChart,
  financePeriodExpense,
  financePeriodIncome,
  type FinanceArticle,
  type FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";
import { formatMoney } from "@/lib/format";
import { FinanceExpenseChart } from "@/components/finance/finance-expense-chart";
import { KpiTile } from "@/components/kpi-tile";
import {
  AccountBalanceTile,
  type AccountBalanceTileAccount,
} from "@/components/account-balance-tile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface FinanceKpiBlockProps {
  rows: FinanceCashFlowRow[];
  /** Счета с текущим остатком — для плитки «Остаток на счетах». */
  accounts: AccountBalanceTileAccount[];
  articles: FinanceArticle[];
}

export function FinanceKpiBlock({ rows, accounts, articles }: FinanceKpiBlockProps) {
  const income = useMemo(() => financePeriodIncome(rows), [rows]);
  const expense = useMemo(() => financePeriodExpense(rows), [rows]);
  const chart = useMemo(() => financeExpenseChart(rows, articles), [rows, articles]);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_minmax(11rem,13rem)]">
      <div className="grid gap-4 sm:grid-cols-3">
        <AccountBalanceTile accounts={accounts} />
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
