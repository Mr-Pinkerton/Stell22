"use client";

import { useMemo, useState } from "react";
import { toast } from "@/components/terminal/toast";
import { Boxes, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OperationTile, OperationTileRow } from "@/components/terminal/operation-tile";
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
    if (l.id === lotId) {
      setDialog({ kind: "rails" });
      return;
    }
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
      <Section title="Партии">
        <OperationTileRow>
          {batches.map((b) => (
            <OperationTile
              key={b.id}
              active={b.id === batchId}
              icon={<Boxes />}
              title={b.name}
              subtitle={`${b.sectionWidthMm}×${b.sectionHeightMm} мм`}
              onClick={() => selectBatch(b)}
            />
          ))}
        </OperationTileRow>
      </Section>

      {batchId && (
        <Section title="Пакеты и рейки">
          <OperationTileRow>
            {lots.map((l) => (
              <OperationTile
                key={l.id}
                active={l.id === lotId}
                icon={<Layers />}
                title={l.isPackage ? `Пакет ${l.code}` : "Поштучно"}
                subtitle={`${formatLength(l.lengthM)} · ${SORT_LABEL[l.sort]} · ост. ${l.remainingQuantity}`}
                highlight={
                  l.id === lotId
                    ? { prefix: "Взято", value: railsTaken, label: "реек" }
                    : undefined
                }
                onClick={() => selectLot(l)}
              />
            ))}
            {lots.length === 0 && <Empty>Нет доступных реек в партии</Empty>}
          </OperationTileRow>
        </Section>
      )}

      {lot && (
        <Section title="Детали">
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

          <OperationTileRow>
            {detailTiles.map((d) => {
              const qty = picked[d.id] ?? 0;
              return (
                <OperationTile
                  key={d.id}
                  active={qty > 0}
                  icon={<Layers />}
                  title={d.name}
                  subtitle={formatLength(d.lengthM)}
                  highlight={qty > 0 ? { value: qty, label: "шт" } : undefined}
                  onClick={() => setDialog({ kind: "detail", detail: d })}
                />
              );
            })}
            {detailTiles.length === 0 && <Empty>Нет деталей этого типа и сорта</Empty>}
          </OperationTileRow>
        </Section>
      )}

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

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-40 w-full shrink-0 items-center justify-center text-base">
      {children}
    </div>
  );
}
