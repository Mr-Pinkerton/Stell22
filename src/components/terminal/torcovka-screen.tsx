"use client";

import { useMemo, useState } from "react";
import { toast } from "@/components/terminal/toast";
import { Boxes, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { OperationTile, OperationTileGrid, OperationTileRow } from "@/components/terminal/operation-tile";
import { QuantityDialog } from "@/components/terminal/quantity-dialog";
import { TerminalConfirmBar } from "@/components/terminal/terminal-confirm-bar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatLength } from "@/lib/format";
import { maxDetailQuantity, sumDetailLengthM, type TorcovkaPick } from "@/lib/torcovka";
import { submitTorcovka } from "@/server/terminal";
import type { Batch, Employee, RailLot, Sort } from "@/types/domain";
import type { TerminalData } from "@/components/terminal/types";

interface TorcovkaScreenProps {
  data: TerminalData;
  employee: Employee;
  onDone: () => void;
}

type Dialog = { kind: "rails" } | { kind: "length"; lengthM: number; sort: Sort } | null;

const SORT_LABEL: Record<Sort, string> = { SORT1: "1 сорт", SORT2: "2 сорт" };
const SORT_TABS: Sort[] = ["SORT1", "SORT2"];

const RAIL_LENGTH_LIMIT_MESSAGE = "Длина заготовок превышает длину взятых реек";

// Ключ выбора — длина + фактический сорт (из пакета любого сорта можно наложить
// заготовки обоих сортов; факт vs заявленное определяет распределение стоимости).
const pickKey = (lengthM: number, sort: Sort) => `${lengthM}|${sort}`;

export function TorcovkaScreen({ data, employee, onDone }: TorcovkaScreenProps) {
  const [batchId, setBatchId] = useState<string | null>(null);
  const [lotId, setLotId] = useState<string | null>(null);
  const [railsTaken, setRailsTaken] = useState(0);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [activeSort, setActiveSort] = useState<Sort>("SORT1");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [submitting, setSubmitting] = useState(false);

  const batches = data.batches.filter((b) => b.status === "IN_WORK");
  const lots = useMemo(
    () => data.railLots.filter((l) => l.batchId === batchId && l.remainingQuantity > 0),
    [data.railLots, batchId],
  );
  const lot = lots.find((l) => l.id === lotId) ?? null;

  // Заготовки нарезаются по длине; конкретная деталь определяется на присадке.
  // Доступные длины — из каталога деталей соответствующего типа рейки.
  const lengthTiles = useMemo(() => {
    if (!lot) return [];
    const lengths = new Set<number>();
    for (const d of data.details) {
      if (d.status === "ACTIVE" && d.detailType === lot.railType) lengths.add(d.lengthM);
    }
    return [...lengths].sort((a, b) => a - b);
  }, [data.details, lot]);

  const torcovkaPicks = useMemo((): TorcovkaPick[] => {
    return Object.entries(picked).flatMap(([key, quantity]) => {
      if (quantity <= 0) return [];
      const [len, sort] = key.split("|");
      return [{ lengthM: Number(len), sort: sort as Sort, quantity }];
    });
  }, [picked]);

  const takenLengthM = lot ? railsTaken * lot.lengthM : 0;
  const usedLengthM = sumDetailLengthM(torcovkaPicks);
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

  const confirm = async () => {
    if (!lot || !batchId || railsTaken <= 0 || pickedCount === 0 || overLength || submitting) return;
    setSubmitting(true);
    try {
      await submitTorcovka({
        employeeId: employee.id,
        batchId,
        railLotId: lot.id,
        railsTaken,
        picks: torcovkaPicks.map((p) => ({ lengthM: p.lengthM, sort: p.sort, quantity: p.quantity })),
      });
      toast.success(`Торцовка внесена: ${pickedCount} заг., отход ${formatLength(wasteM)}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
      setSubmitting(false);
    }
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
        <Section title="Заготовки">
          <div className="flex flex-col gap-5">
            <Tabs
              value={activeSort}
              onValueChange={(v) => setActiveSort(v as Sort)}
              className="items-center gap-4"
            >
              <TabsList className="h-auto gap-1.5 rounded-2xl p-1.5">
                {SORT_TABS.map((s) => {
                  const count = torcovkaPicks
                    .filter((p) => p.sort === s)
                    .reduce((a, p) => a + p.quantity, 0);
                  return (
                    <TabsTrigger
                      key={s}
                      value={s}
                      className="border-border bg-card/60 data-active:bg-card data-active:shadow-soft h-12 min-w-36 rounded-xl border px-8 text-lg font-semibold data-active:border-transparent"
                    >
                      {SORT_LABEL[s]}
                      {count > 0 && (
                        <span className="text-brand ml-2 tabular-nums">{count}</span>
                      )}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>

            <OperationTileGrid>
              {lengthTiles.map((lengthM) => {
                const key = pickKey(lengthM, activeSort);
                const qty = picked[key] ?? 0;
                return (
                  <OperationTile
                    key={key}
                    layout="grid"
                    active={qty > 0}
                    icon={<Layers />}
                    title={formatLength(lengthM)}
                    subtitle={SORT_LABEL[activeSort]}
                    highlight={qty > 0 ? { value: qty, label: "шт" } : undefined}
                    onClick={() => setDialog({ kind: "length", lengthM, sort: activeSort })}
                    onClear={
                      qty > 0
                        ? () =>
                            setPicked((p) => {
                              const next = { ...p };
                              delete next[key];
                              return next;
                            })
                        : undefined
                    }
                  />
                );
              })}
              {lengthTiles.length === 0 && (
                <div className="col-span-full">
                  <Empty>Нет длин для этого типа рейки</Empty>
                </div>
              )}
            </OperationTileGrid>
          </div>
        </Section>
      )}

      {lot && (
        <TerminalConfirmBar
          summary={
            <>
              <span className="font-medium">{pickedCount} заг.</span>
              <span
                className={cn(
                  "ml-3",
                  overLength ? "text-destructive font-medium" : "text-muted-foreground",
                )}
              >
                Отход: {formatLength(wasteM)}
              </span>
            </>
          }
          disabled={railsTaken <= 0 || pickedCount === 0 || overLength || submitting}
          onConfirm={confirm}
        />
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
        open={dialog?.kind === "length"}
        title={
          dialog?.kind === "length"
            ? `Заготовка ${formatLength(dialog.lengthM)} · ${SORT_LABEL[dialog.sort]}`
            : ""
        }
        initial={dialog?.kind === "length" ? (picked[pickKey(dialog.lengthM, dialog.sort)] ?? 0) : 0}
        max={
          dialog?.kind === "length" && lot && railsTaken > 0
            ? maxDetailQuantity({
                takenLengthM,
                picks: torcovkaPicks,
                lengthM: dialog.lengthM,
                sort: dialog.sort,
              })
            : undefined
        }
        limitMessage={RAIL_LENGTH_LIMIT_MESSAGE}
        onConfirm={(v) => {
          if (dialog?.kind === "length") {
            setPicked((p) => ({ ...p, [pickKey(dialog.lengthM, dialog.sort)]: v }));
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
