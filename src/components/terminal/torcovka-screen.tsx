"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Boxes, Layers, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QuantityDialog } from "@/components/terminal/quantity-dialog";
import { formatLength } from "@/lib/format";
import type { Batch, Detail, RailLot, Sort } from "@/types/domain";
import type { TerminalData } from "@/components/terminal/types";

interface TorcovkaScreenProps {
  data: TerminalData;
  onDone: () => void;
}

type Dialog = { kind: "rails" } | { kind: "detail"; detail: Detail } | null;

const SORT_LABEL: Record<Sort, string> = { SORT1: "1 сорт", SORT2: "2 сорт" };

export function TorcovkaScreen({ data, onDone }: TorcovkaScreenProps) {
  const [batchId, setBatchId] = useState<string | null>(null);
  const [lotId, setLotId] = useState<string | null>(null);
  const [railsTaken, setRailsTaken] = useState(0);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [sort, setSort] = useState<Sort>("SORT1");
  const [dialog, setDialog] = useState<Dialog>(null);

  const batches = data.batches.filter((b) => b.status === "IN_WORK");
  const lots = useMemo(
    () => data.railLots.filter((l) => l.batchId === batchId && l.remainingQuantity > 0),
    [data.railLots, batchId],
  );
  const lot = lots.find((l) => l.id === lotId) ?? null;

  const detailTiles = useMemo(() => {
    if (!lot) return [];
    return data.details.filter(
      (d) => d.status === "ACTIVE" && d.detailType === lot.railType && d.sort === sort,
    );
  }, [data.details, lot, sort]);

  const takenLengthM = lot ? railsTaken * lot.lengthM : 0;
  const usedLengthM = Object.entries(picked).reduce((sum, [id, qty]) => {
    const d = data.details.find((x) => x.id === id);
    return sum + (d ? d.lengthM * qty : 0);
  }, 0);
  const wasteM = takenLengthM - usedLengthM;
  const overLength = wasteM < 0;
  const pickedCount = Object.values(picked).reduce((a, b) => a + b, 0);

  const resetLot = () => {
    setLotId(null);
    setRailsTaken(0);
    setPicked({});
  };

  const selectBatch = (b: Batch) => {
    setBatchId(b.id);
    resetLot();
  };

  const selectLot = (l: RailLot) => {
    setLotId(l.id);
    setRailsTaken(0);
    setPicked({});
    setDialog({ kind: "rails" });
  };

  const confirm = () => {
    if (!lot || railsTaken <= 0 || pickedCount === 0 || overLength) return;
    toast.success(`Торцовка внесена: ${pickedCount} дет., отход ${formatLength(wasteM)}`);
    onDone();
  };

  return (
    <main className="flex flex-1 flex-col gap-5 p-6">
      {/* Блок 1 — партии */}
      <Section title="Партии">
        <TileRow>
          {batches.map((b) => (
            <SelectTile
              key={b.id}
              active={b.id === batchId}
              compact={batchId != null}
              icon={<Boxes />}
              title={b.name}
              subtitle={`${b.sectionWidthMm}×${b.sectionHeightMm} мм`}
              onClick={() => selectBatch(b)}
            />
          ))}
        </TileRow>
      </Section>

      {/* Блок 2 — пакеты/рейки */}
      {batchId && (
        <Section title="Пакеты и рейки">
          <TileRow>
            {lots.map((l) => (
              <SelectTile
                key={l.id}
                active={l.id === lotId}
                compact={lotId != null}
                icon={<Layers />}
                title={l.isPackage ? `Пакет ${l.code}` : "Поштучно"}
                subtitle={`${formatLength(l.lengthM)} · ${SORT_LABEL[l.sort]} · ост. ${l.remainingQuantity}`}
                onClick={() => selectLot(l)}
              />
            ))}
            {lots.length === 0 && <Empty>Нет доступных реек в партии</Empty>}
          </TileRow>
        </Section>
      )}

      {/* Блок 3 — детали */}
      {lot && (
        <Section
          title="Детали"
          aside={
            <button
              type="button"
              onClick={() => setDialog({ kind: "rails" })}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm font-medium"
            >
              <Pencil className="size-3.5" />
              Взято реек: {railsTaken} ({formatLength(takenLengthM)})
            </button>
          }
        >
          <Tabs value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <TabsList className="h-auto gap-1 rounded-xl p-1">
              {(["SORT1", "SORT2"] as Sort[]).map((s) => (
                <TabsTrigger
                  key={s}
                  value={s}
                  className="data-active:bg-card data-active:shadow-soft h-9 rounded-lg px-4"
                >
                  {SORT_LABEL[s]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <TileRow wrap>
            {detailTiles.map((d) => (
              <SelectTile
                key={d.id}
                active={(picked[d.id] ?? 0) > 0}
                icon={<Layers />}
                title={d.name}
                subtitle={formatLength(d.lengthM)}
                badge={picked[d.id] ? `${picked[d.id]} шт` : undefined}
                onClick={() => setDialog({ kind: "detail", detail: d })}
              />
            ))}
            {detailTiles.length === 0 && <Empty>Нет деталей этого типа и сорта</Empty>}
          </TileRow>
        </Section>
      )}

      {/* Подвал */}
      {lot && (
        <div className="surface-card sticky bottom-4 mt-auto flex items-center justify-between gap-4 px-5 py-3 ring-0">
          <div className="text-sm">
            <span className="font-medium">{pickedCount} дет.</span>
            <span
              className={cn(
                "ml-3",
                overLength ? "text-destructive font-medium" : "text-muted-foreground",
              )}
            >
              Отход: {formatLength(wasteM)}
            </span>
          </div>
          <Button
            className="h-11 rounded-xl px-6 text-base"
            disabled={railsTaken <= 0 || pickedCount === 0 || overLength}
            onClick={confirm}
          >
            Подтвердить
          </Button>
        </div>
      )}

      <QuantityDialog
        open={dialog?.kind === "rails"}
        title="Сколько реек взято?"
        hint={lot ? `Доступно ${lot.remainingQuantity} шт` : ""}
        initial={railsTaken}
        max={lot?.remainingQuantity}
        onConfirm={(v) => {
          setRailsTaken(v);
          setDialog(null);
        }}
        onClose={() => setDialog(null)}
      />
      <QuantityDialog
        open={dialog?.kind === "detail"}
        title={dialog?.kind === "detail" ? dialog.detail.name : ""}
        initial={dialog?.kind === "detail" ? (picked[dialog.detail.id] ?? 0) : 0}
        onConfirm={(v) => {
          if (dialog?.kind === "detail") {
            setPicked((p) => ({ ...p, [dialog.detail.id]: v }));
          }
          setDialog(null);
        }}
        onClose={() => setDialog(null)}
      />
    </main>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-muted-foreground text-sm font-semibold tracking-wide uppercase">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function TileRow({ children, wrap }: { children: React.ReactNode; wrap?: boolean }) {
  return (
    <div className={cn("flex gap-3", wrap ? "flex-wrap" : "overflow-x-auto pb-1")}>{children}</div>
  );
}

function SelectTile({
  active,
  compact,
  icon,
  title,
  subtitle,
  badge,
  onClick,
}: {
  active?: boolean;
  compact?: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <Card
      className={cn(
        "ring-0 transition-all hover:-translate-y-0.5 hover:shadow-soft-lg",
        active ? "border-brand bg-brand/5 border-2" : "surface-card",
      )}
    >
      <CardContent
        className={cn(
          "flex min-w-36 cursor-pointer items-center gap-3",
          compact ? "py-3" : "flex-col py-5 text-center",
        )}
        onClick={onClick}
      >
        <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-2xl [&_svg]:size-5 [&_svg]:stroke-[1.75]">
          {icon}
        </span>
        <span className={cn(compact ? "text-left" : "")}>
          <span className="block text-sm font-semibold">{title}</span>
          {subtitle && <span className="text-muted-foreground block text-xs">{subtitle}</span>}
        </span>
        {badge && <Badge className="ml-auto">{badge}</Badge>}
      </CardContent>
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-20 w-full items-center justify-center text-sm">
      {children}
    </div>
  );
}
