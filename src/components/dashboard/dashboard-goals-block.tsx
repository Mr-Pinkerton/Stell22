"use client";

import type { DashboardGoalProgress } from "@/lib/dashboard-metrics";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface DashboardGoalsBlockProps {
  goals: DashboardGoalProgress[];
}

export function DashboardGoalsBlock({ goals }: DashboardGoalsBlockProps) {
  if (goals.length === 0) {
    return (
      <Card className="surface-card ring-0">
        <CardHeader>
          <CardTitle className="text-base">Цели и прогноз</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">Активных целей нет</CardContent>
      </Card>
    );
  }

  return (
    <Card className="surface-card ring-0">
      <CardHeader>
        <CardTitle className="text-base">Цели и прогноз</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {goals.map((goal) => (
          <div key={goal.id} className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium">{goal.title}</p>
              <Badge variant={goal.onTrack ? "secondary" : "outline"}>
                {goal.onTrack ? "Успеваем" : "Не успеваем"}
              </Badge>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground tabular-nums">
                {goal.produced} / {goal.target} шт
              </span>
              <span className="font-semibold tabular-nums">{goal.pct}%</span>
            </div>
            <div className="bg-muted h-2 overflow-hidden rounded-full">
              <div
                className={cn(
                  "h-full rounded-full",
                  goal.onTrack ? "bg-emerald-600" : "bg-brand",
                )}
                style={{ width: `${Math.min(goal.pct, 100)}%` }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
