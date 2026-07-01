"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { getDefaultDateFilterValue, type DateFilterValue } from "@/components/date-filter";
import type { GoalRow } from "@/mocks/goals-fixtures";
import { createGoal, type GoalProductOption } from "@/server/goals";
import {
  countWorkingDaysInMonth,
  dailyPlan,
  goalCompletionPercent,
  parseGoalMonthIso,
  startOfWeekMonday,
  weeklyPlan,
} from "@/lib/goals";
import { goalMonthLabel, splitGoalsForView } from "@/lib/goals-view";
import { dataTableArchivedRowClass } from "@/lib/table-archive";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { DataTable, type Column } from "@/components/data-table";
import { GoalFormDialog, type GoalFormValues } from "@/components/goals/goal-form-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

function formatPlanValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function GoalsView({
  initialGoals,
  products,
}: {
  initialGoals: GoalRow[];
  products: GoalProductOption[];
}) {
  const router = useRouter();
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(getDefaultDateFilterValue);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const { active, past } = useMemo(
    () => splitGoalsForView(initialGoals, dateFilter),
    [initialGoals, dateFilter],
  );

  const handleCreate = (values: GoalFormValues) => {
    startTransition(async () => {
      const res = await createGoal(values);
      if (res.ok) {
        toast.success("Цель добавлена");
        setDialogOpen(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  };

  return (
    <>
      <PageHeader
        title="Цели"
        addLabel="Создать цель"
        onAdd={() => setDialogOpen(true)}
      />

      <FiltersBar
        date
        dateAllTime
        dateFilterValue={dateFilter}
        onDateFilterChange={setDateFilter}
      />

      <div className="space-y-8">
        <section className="space-y-4">
          <h2 className="text-lg font-semibold tracking-tight">Активные цели</h2>
          {active.length === 0 ? (
            <p className="text-muted-foreground text-sm">Активных целей за период нет</p>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {active.map((goal) => (
                <GoalCard key={goal.id} goal={goal} variant="active" />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold tracking-tight">Прошлые периоды</h2>
          {past.length === 0 ? (
            <p className="text-muted-foreground text-sm">Архивных целей за период нет</p>
          ) : (
            <Card className="surface-card ring-0">
              <CardContent className="p-0">
                <DataTable
                  columns={pastColumns}
                  rows={past}
                  empty="Нет целей"
                  padded
                  className="border-0"
                  rowClassName={(row, index) =>
                    dataTableArchivedRowClass(row, index, (r) => r.status === "ARCHIVED")
                  }
                />
              </CardContent>
            </Card>
          )}
        </section>
      </div>

      <GoalFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
        products={products}
        submitDisabled={pending}
      />
    </>
  );
}

function GoalCard({ goal, variant }: { goal: GoalRow; variant: "active" | "compact" }) {
  const monthDate = parseGoalMonthIso(goal.month);
  const now = new Date();
  const workingDays = countWorkingDaysInMonth(monthDate);
  const daily = dailyPlan(goal.quantity, workingDays);
  const weekly = weeklyPlan(goal.quantity, monthDate, startOfWeekMonday(now));
  const pct = goalCompletionPercent(goal.producedQty, goal.quantity);

  return (
    <Card className={cn("surface-card ring-0", variant === "active" && "border-primary/15")}>
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{goal.name}</h3>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {goal.productName} · {goalMonthLabel(goal.month)}
            </p>
          </div>
          <Badge variant={goal.status === "ACTIVE" ? "secondary" : "outline"}>
            {goal.status === "ACTIVE" ? "Активна" : "Архив"}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Metric label="План" value={`${goal.quantity} шт`} />
          <Metric label="Факт" value={`${goal.producedQty} шт`} />
          <Metric label="Дневной план" value={`${formatPlanValue(daily)} шт`} />
          <Metric label="Недельный план" value={`${formatPlanValue(weekly)} шт`} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Выполнение</span>
            <span className={cn("font-semibold tabular-nums", pct >= 100 ? "text-emerald-700" : "text-brand")}>
              {pct}%
            </span>
          </div>
          <div className="bg-muted h-2.5 overflow-hidden rounded-full">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                pct >= 100 ? "bg-emerald-600" : "bg-brand",
              )}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-0.5 font-medium tabular-nums">{value}</p>
    </div>
  );
}

const pastColumns: Column<GoalRow>[] = [
  {
    key: "name",
    header: "Название",
    render: (row) => <span className="font-medium">{row.name}</span>,
  },
  {
    key: "product",
    header: "Изделие",
    render: (row) => row.productName,
  },
  {
    key: "month",
    header: "Период",
    render: (row) => goalMonthLabel(row.month),
  },
  {
    key: "quantity",
    header: "План",
    className: "w-24",
    render: (row) => <span className="tabular-nums">{row.quantity}</span>,
  },
  {
    key: "produced",
    header: "Факт",
    className: "w-24",
    render: (row) => <span className="tabular-nums">{row.producedQty}</span>,
  },
  {
    key: "pct",
    header: "%",
    className: "w-20",
    render: (row) => (
      <span className="font-medium tabular-nums">
        {goalCompletionPercent(row.producedQty, row.quantity)}%
      </span>
    ),
  },
];
