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
import { goalMonthLabel, goalMonthRelation, splitGoalsForView } from "@/lib/goals-view";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { DataTable, type Column } from "@/components/data-table";
import { TableSurface, tableHeaderClassName } from "@/components/table-surface";
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

  const { active, archived } = useMemo(
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

      <section className="space-y-3">
        <SectionHeading title="Активные цели" count={active.length} />
        {active.length === 0 ? (
          <p className="text-muted-foreground text-sm">Активных целей за выбранный период нет</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {active.map((goal) => (
              <GoalCard key={goal.id} goal={goal} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeading title="Архивные цели" count={archived.length} />
        <TableSurface
          filters={
            <FiltersBar
              embedded
              date
              dateAllTime
              dateFilterValue={dateFilter}
              onDateFilterChange={setDateFilter}
            />
          }
        >
          <DataTable
            columns={pastColumns}
            rows={archived}
            empty="Архивных целей за выбранный период нет"
            padded
            className="border-0"
            headerClassName={tableHeaderClassName}
          />
        </TableSurface>
      </section>

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

function SectionHeading({
  title,
  count,
  className,
}: {
  title: string;
  count: number;
  className?: string;
}) {
  return (
    <h2 className={cn("flex items-baseline gap-2 text-lg font-semibold tracking-tight", className)}>
      {title}
      <span className="text-muted-foreground text-sm font-medium tabular-nums">{count}</span>
    </h2>
  );
}

function GoalCard({ goal }: { goal: GoalRow }) {
  const relation = goalMonthRelation(goal.month);
  const monthDate = parseGoalMonthIso(goal.month);
  const pct = goalCompletionPercent(goal.producedQty, goal.quantity);
  const showCurrentGuides = relation === "current";
  const daily = showCurrentGuides
    ? dailyPlan(goal.quantity, countWorkingDaysInMonth(monthDate))
    : null;
  const weekly = showCurrentGuides
    ? weeklyPlan(goal.quantity, monthDate, startOfWeekMonday(new Date()))
    : null;
  const statusLabel = relation === "past" ? "Период завершён" : "Активна";

  return (
    <Card className="border-border bg-card min-w-0 shadow-sm ring-1 ring-border">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{goal.name}</h3>
            <p className="text-muted-foreground mt-0.5 truncate text-sm">
              {goal.productName} · {goalMonthLabel(goal.month)}
            </p>
          </div>
          <Badge variant={relation === "past" ? "outline" : "secondary"} className="shrink-0">
            {statusLabel}
          </Badge>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">Факт / план</p>
            <p className="mt-1 text-2xl leading-none font-semibold tabular-nums">
              {goal.producedQty}
              <span className="text-muted-foreground text-base font-medium"> / {goal.quantity} шт</span>
            </p>
          </div>
          <p
            className={cn(
              "text-2xl leading-none font-semibold tabular-nums",
              pct >= 100 ? "text-emerald-700 dark:text-emerald-400" : "text-brand",
            )}
          >
            {pct}%
          </p>
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

        {showCurrentGuides && daily != null && weekly != null ? (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Дневной ориентир" value={`${formatPlanValue(daily)} шт`} />
            <Metric label="Недельный ориентир" value={`${formatPlanValue(weekly)} шт`} />
          </div>
        ) : null}
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
    render: (row) => (
      <span className="inline-flex min-w-0 items-center gap-2">
        <span className="truncate font-medium">{row.name}</span>
        <Badge variant="outline" className="shrink-0">
          Архив
        </Badge>
      </span>
    ),
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
