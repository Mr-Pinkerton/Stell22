"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { DashboardAlert } from "@/lib/dashboard-metrics";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const toneClass: Record<DashboardAlert["tone"], string> = {
  amber: "border-amber-200 bg-amber-50 text-amber-950",
  red: "border-red-200 bg-red-50 text-red-950",
  violet: "border-violet-200 bg-violet-50 text-violet-950",
  blue: "border-sky-200 bg-sky-50 text-sky-950",
};

interface DashboardAlertsBlockProps {
  alerts: DashboardAlert[];
}

export function DashboardAlertsBlock({ alerts }: DashboardAlertsBlockProps) {
  const [expanded, setExpanded] = useState(false);

  if (alerts.length === 0) {
    return (
      <Card className="surface-card ring-0">
        <CardContent className="text-muted-foreground py-5 text-sm">Все в норме</CardContent>
      </Card>
    );
  }

  const top = alerts.slice(0, 3);
  const rest = alerts.slice(3);

  return (
    <Card className="surface-card ring-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Требует внимания</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {top.map((alert) => (
          <AlertCard key={alert.id} alert={alert} />
        ))}

        {rest.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm font-medium"
            >
              <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
              Все сигналы ({alerts.length})
            </button>
            {expanded && (
              <div className="mt-3 space-y-3">
                {rest.map((alert) => (
                  <AlertCard key={alert.id} alert={alert} />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AlertCard({ alert }: { alert: DashboardAlert }) {
  return (
    <Link
      href={alert.href}
      className={cn(
        "block rounded-xl border px-4 py-3 transition-opacity hover:opacity-90",
        toneClass[alert.tone],
      )}
    >
      <p className="font-semibold">{alert.title}</p>
      <p className="mt-0.5 text-sm opacity-90">{alert.description}</p>
    </Link>
  );
}
