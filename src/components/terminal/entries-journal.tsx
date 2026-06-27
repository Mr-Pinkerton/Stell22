"use client";

import { useMemo, useState } from "react";
import { ChevronDown, NotebookText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMoney } from "@/lib/format";
import {
  buildJournal,
  dayKey,
  journalTotal,
  type DayGroup,
  type JournalPeriod,
} from "@/lib/entries";
import type { OperationType, TerminalEntry } from "@/types/domain";

const TIME_ZONE = "Europe/Moscow";
const DAY_MS = 24 * 60 * 60 * 1000;

const TYPE_LABEL: Record<OperationType, string> = {
  TORCOVKA: "Торцовка",
  PRISADKA: "Присадка",
  UPAKOVKA: "Упаковка",
  HOURS: "Часы",
};

const TYPE_UNIT: Record<OperationType, string> = {
  TORCOVKA: "дет",
  PRISADKA: "присадк.",
  UPAKOVKA: "шт",
  HOURS: "ч",
};

const TYPE_ORDER: OperationType[] = ["TORCOVKA", "PRISADKA", "UPAKOVKA", "HOURS"];

interface EntriesJournalProps {
  entries: TerminalEntry[];
}

export function EntriesJournal({ entries }: EntriesJournalProps) {
  const [period, setPeriod] = useState<JournalPeriod>("week");
  const now = useMemo(() => new Date(), []);

  const groups = useMemo(() => buildJournal(entries, period, now), [entries, period, now]);
  const total = useMemo(() => journalTotal(groups), [groups]);

  return (
    <Card className="surface-card ring-0">
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-2xl [&_svg]:size-5 [&_svg]:stroke-[1.75]">
              <NotebookText />
            </span>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Журнал внесений</h2>
              <p className="text-muted-foreground text-sm">
                Заработано за период: <span className="text-foreground font-semibold">{formatMoney(total)}</span>
              </p>
            </div>
          </div>

          <Tabs value={period} onValueChange={(v) => setPeriod(v as JournalPeriod)}>
            <TabsList className="h-auto gap-1.5 rounded-2xl p-1.5">
              {(["week", "month"] as JournalPeriod[]).map((p) => (
                <TabsTrigger
                  key={p}
                  value={p}
                  className="border-border bg-card/60 data-active:bg-card data-active:shadow-soft h-10 min-w-24 rounded-xl border px-5 text-base font-semibold data-active:border-transparent"
                >
                  {p === "week" ? "Неделя" : "Месяц"}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {groups.length === 0 ? (
          <div className="text-muted-foreground flex h-24 items-center justify-center text-base">
            За этот период внесений нет
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {groups.map((g) => (
              <DayRow key={g.date} group={g} now={now} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DayRow({ group, now }: { group: DayGroup; now: Date }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-border bg-card/50 rounded-2xl border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left active:opacity-90"
      >
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold">{formatDayLabel(group.date, now)}</p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {TYPE_ORDER.filter((t) => group.byType[t]).map((t) => {
              const stat = group.byType[t]!;
              return (
                <span key={t} className="text-muted-foreground text-sm">
                  {TYPE_LABEL[t]}{" "}
                  <span className="text-foreground font-medium tabular-nums">
                    {stat.quantity} {TYPE_UNIT[t]}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
        <span className="text-brand shrink-0 text-lg font-bold tabular-nums">
          {formatMoney(group.totalAmount)}
        </span>
        <ChevronDown
          className={cn(
            "text-muted-foreground size-5 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="border-border/70 flex flex-col gap-1 border-t px-4 py-2">
          {group.entries.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-3 py-1">
              <span className="text-muted-foreground text-sm">
                {formatTime(e.occurredAt)} · {TYPE_LABEL[e.type]}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-foreground text-sm font-medium tabular-nums">
                  {e.quantity} {TYPE_UNIT[e.type]}
                </span>
                <span className="text-muted-foreground w-28 text-right text-sm tabular-nums">
                  {formatMoney(e.amount)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** «Сегодня · пт 27.06», «Вчера · чт 26.06» или «вт 24.06.2026». */
function formatDayLabel(date: string, now: Date): string {
  const todayKey = dayKey(now);
  const yesterdayKey = dayKey(new Date(now.getTime() - DAY_MS));
  const d = new Date(`${date}T12:00:00+03:00`);

  const weekday = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    weekday: "short",
  }).format(d);
  const dayMonth = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
  }).format(d);

  if (date === todayKey) return `Сегодня · ${weekday} ${dayMonth}`;
  if (date === yesterdayKey) return `Вчера · ${weekday} ${dayMonth}`;
  return `${weekday} ${dayMonth}`;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
