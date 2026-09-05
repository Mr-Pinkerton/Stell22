"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/terminal/toast";
import { Boxes, Layers } from "lucide-react";
import { useTerminalDraft } from "@/components/terminal/use-terminal-draft";
import type { TorcovkaAckUiPhase } from "@/lib/terminal-draft-storage";
import { restorePendingAck, type RestoredPendingAck } from "@/lib/restore-pending-ack";
import { cn } from "@/lib/utils";
import { OperationTile, OperationTileGrid, OperationTileRow } from "@/components/terminal/operation-tile";
import { QuantityDialog } from "@/components/terminal/quantity-dialog";
import { TerminalConfirmBar } from "@/components/terminal/terminal-confirm-bar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatLength } from "@/lib/format";
import { maxDetailQuantity, type TorcovkaPick } from "@/lib/torcovka";
import {
  computeTorcovkaWasteMetrics,
  TORCOVKA_WASTE_REASON_LABEL,
  TORCOVKA_WASTE_REASONS,
  type TorcovkaWasteReason,
} from "@/lib/torcovka-plausibility";
import { submitTorcovka } from "@/server/terminal";
import type { RailType, Sort } from "@/types/domain";
import type {
  TerminalBatch,
  TerminalData,
  TerminalEmployee,
  TerminalRailLot,
} from "@/components/terminal/types";

interface TorcovkaScreenProps {
  data: TerminalData;
  employee: TerminalEmployee;
  onDone: () => void;
}

type Dialog = { kind: "rails" } | { kind: "length"; lengthM: number; sort: Sort } | null;

type PendingAck = RestoredPendingAck;

function wasteBandClass(band: "NORMAL" | "SUSPICIOUS" | "EXTREME"): string {
  if (band === "NORMAL") return "text-muted-foreground";
  if (band === "SUSPICIOUS") return "text-amber-700 font-medium";
  return "text-destructive font-semibold";
}

const SORT_LABEL: Record<Sort, string> = { SORT1: "1 сорт", SORT2: "2 сорт" };
const RAIL_TYPE_LABEL: Record<RailType, string> = { POLKA: "Полка", KANAVKA: "Канавка" };
const SORT_TABS: Sort[] = ["SORT1", "SORT2"];

const RAIL_LENGTH_LIMIT_MESSAGE = "Длина заготовок превышает длину взятых реек";

// Ключ выбора — длина + фактический сорт (из пакета любого сорта можно наложить
// заготовки обоих сортов; факт vs заявленное определяет распределение стоимости).
const pickKey = (lengthM: number, sort: Sort) => `${lengthM}|${sort}`;

export function TorcovkaScreen({ data, employee, onDone }: TorcovkaScreenProps) {
  const {
    draft: storedDraft,
    clientRequestId,
    save: saveDraft,
    clear: clearDraft,
  } = useTerminalDraft({ employeeId: employee.id });
  const initial = storedDraft?.operationType === "TORCOVKA" ? storedDraft.payload : null;
  const [batchId, setBatchId] = useState<string | null>(initial?.batchId ?? null);
  const [lotId, setLotId] = useState<string | null>(initial?.lotId ?? null);
  const [railsTaken, setRailsTaken] = useState(initial?.railsTaken ?? 0);
  const [picked, setPicked] = useState<Record<string, number>>(() => {
    if (!initial) return {};
    const next: Record<string, number> = {};
    for (const p of initial.picks) {
      if (p.quantity > 0) next[pickKey(p.lengthM, p.sort)] = p.quantity;
    }
    return next;
  });
  const [activeSort, setActiveSort] = useState<Sort>(initial?.activeSort ?? "SORT1");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingAck, setPendingAck] = useState<PendingAck | null>(() =>
    restorePendingAck({
      draft: storedDraft,
      railLots: data.railLots,
    }),
  );
  const [highWasteReason, setHighWasteReason] = useState<TorcovkaWasteReason | null>(
    initial?.ackUi.highWasteReason ?? null,
  );
  const [highWasteNote, setHighWasteNote] = useState(initial?.ackUi.highWasteNote ?? "");

  const materialById = useMemo(
    () => new Map(data.materials.map((m) => [m.id, m])),
    [data.materials],
  );
  const batches = data.batches.filter((b) => b.status === "IN_WORK" || b.id === batchId);
  const lots = useMemo(() => {
    return data.railLots.filter(
      (l) => l.batchId === batchId && (l.remainingQuantity > 0 || l.id === lotId),
    );
  }, [data.railLots, batchId, lotId]);
  const lot = data.railLots.find((l) => l.id === lotId) ?? null;
  const lotMissing = Boolean(lotId) && !lot;
  const stockLow = Boolean(lot && railsTaken > lot.remainingQuantity);

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

  const wasteMetrics = useMemo(() => {
    if (!lot || railsTaken <= 0) return null;
    return computeTorcovkaWasteMetrics(railsTaken, lot.lengthM, torcovkaPicks);
  }, [lot, railsTaken, torcovkaPicks]);
  const takenLengthM = wasteMetrics ? wasteMetrics.takenM.toNumber() : 0;
  const overLength = wasteMetrics ? wasteMetrics.producedM.gt(wasteMetrics.takenM) : false;
  const pickedCount = Object.values(picked).reduce((a, b) => a + b, 0);

  const ackPhase: TorcovkaAckUiPhase =
    pendingAck?.band === "EXTREME"
      ? "extreme"
      : pendingAck?.band === "SUSPICIOUS"
        ? "suspicious"
        : "none";

  useEffect(() => {
    const picks = Object.entries(picked).flatMap(([key, quantity]) => {
      if (quantity <= 0) return [];
      const [len, sort] = key.split("|");
      return [{ lengthM: Number(len), sort: sort as Sort, quantity }];
    });
    saveDraft({
      operationType: "TORCOVKA",
      payload: {
        batchId,
        lotId,
        railsTaken,
        picks,
        activeSort,
        ackUi: {
          phase: ackPhase,
          highWasteReason,
          highWasteNote,
        },
      },
    });
  }, [
    batchId,
    lotId,
    railsTaken,
    picked,
    activeSort,
    ackPhase,
    highWasteReason,
    highWasteNote,
    saveDraft,
  ]);

  const resetLot = () => {
    setLotId(null);
    setRailsTaken(0);
    setPicked({});
    setPendingAck(null);
  };

  const selectBatch = (b: TerminalBatch) => {
    setBatchId(b.id);
    resetLot();
  };

  const selectLot = (l: TerminalRailLot) => {
    if (l.id === lotId) {
      setDialog({ kind: "rails" });
      return;
    }
    setLotId(l.id);
    setRailsTaken(0);
    setPicked({});
    setPendingAck(null);
    setDialog({ kind: "rails" });
  };

  const confirm = async () => {
    if (!lotId || !batchId || railsTaken <= 0 || pickedCount === 0 || overLength || submitting) return;
    setSubmitting(true);
    const picks = torcovkaPicks.map((p) => ({
      lengthM: p.lengthM,
      sort: p.sort,
      quantity: p.quantity,
    }));
    try {
      const result = await submitTorcovka({
        employeeId: employee.id,
        clientRequestId,
        batchId,
        railLotId: lotId,
        railsTaken,
        picks,
      });
      if (result.status === "ACK_REQUIRED") {
        setPendingAck({
          ...result,
          picks,
          clientRequestId,
          batchId,
          railLotId: lotId,
        });
        setSubmitting(false);
        return;
      }
      const wasteLabel = wasteMetrics
        ? formatLength(wasteMetrics.wasteM.toNumber())
        : formatLength(0);
      toast.success(`Торцовка внесена: ${pickedCount} заг., отход ${wasteLabel}`);
      clearDraft();
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
      setSubmitting(false);
    }
  };

  const retryWithAck = async (ackKind: "SUSPICIOUS" | "HIGH_WASTE") => {
    if (!pendingAck || submitting) return;
    if (ackKind === "HIGH_WASTE" && !highWasteReason) return;
    if (ackKind === "HIGH_WASTE" && highWasteReason === "OTHER" && !highWasteNote.trim()) return;
    setSubmitting(true);
    try {
      const result = await submitTorcovka({
        employeeId: employee.id,
        clientRequestId: pendingAck.clientRequestId,
        batchId: pendingAck.batchId,
        railLotId: pendingAck.railLotId,
        railsTaken: pendingAck.railsTaken,
        picks: pendingAck.picks,
        plausibilityAck: {
          kind: ackKind,
          railsTaken: pendingAck.railsTaken,
          takenM: pendingAck.takenM,
          producedM: pendingAck.producedM,
          wastePct: pendingAck.wastePct,
          ...(ackKind === "HIGH_WASTE"
            ? { reason: highWasteReason!, reasonNote: highWasteNote }
            : {}),
        },
      });
      if (result.status === "ACK_REQUIRED") {
        setPendingAck((prev) => (prev ? { ...prev, ...result } : prev));
        setSubmitting(false);
        return;
      }
      toast.success(`Торцовка внесена: ${pendingAck.picks.reduce((s, p) => s + p.quantity, 0)} заг.`);
      setPendingAck(null);
      clearDraft();
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
              material={{
                name: materialById.get(b.materialId)?.name ?? "—",
                section: `${b.sectionWidthMm}×${b.sectionHeightMm}`,
              }}
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
                subtitle={`${formatLength(l.lengthM)} · ${SORT_LABEL[l.sort]} · ${RAIL_TYPE_LABEL[l.railType]} · ост. ${l.remainingQuantity}`}
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

      {(wasteMetrics || (lotMissing && railsTaken > 0 && pickedCount > 0)) && (
        <>
          {(lotMissing || stockLow) && (
            <p className="text-amber-800 text-sm leading-relaxed">
              {lotMissing
                ? "Пакет больше недоступен в каталоге. Если операция уже прошла, повтор будет идемпотентным."
                : "В пакете сейчас меньше реек, чем во вводе. Если операция уже прошла, повтор будет идемпотентным."}
            </p>
          )}
        <TerminalConfirmBar
          summary={
            wasteMetrics ? (
            <div className="space-y-0.5">
              <div>Фактически взято реек: {railsTaken}</div>
              <div>Общая длина: {formatLength(wasteMetrics.takenM.toNumber())}</div>
              <div>Получено заготовок: {pickedCount}</div>
              <div>Полезный выход: {formatLength(wasteMetrics.producedM.toNumber())}</div>
              <div className={wasteBandClass(wasteMetrics.band)}>
                Отход: {formatLength(wasteMetrics.wasteM.toNumber())} /{" "}
                {wasteMetrics.canon.wastePct.replace(".", ",")}%
              </div>
            </div>
            ) : (
              <div>
                Черновик: {railsTaken} реек, {pickedCount} заг.
              </div>
            )
          }
          disabled={railsTaken <= 0 || pickedCount === 0 || overLength || submitting}
          onConfirm={confirm}
        />
        </>
      )}

      <QuantityDialog
        open={dialog?.kind === "rails"}
        title="Сколько реек вы сейчас фактически взяли в торцовку?"
        hint={
          lot ? (
            <>
              <span className="block">Не указывайте количество реек во всём пакете.</span>
              <span className="block">Остаток пакета: {lot.remainingQuantity} шт</span>
            </>
          ) : (
            ""
          )
        }
        initial={railsTaken}
        max={lot ? Math.max(lot.remainingQuantity, railsTaken) : undefined}
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

      <Dialog
        open={pendingAck?.band === "SUSPICIOUS"}
        onOpenChange={(o) => {
          if (!o) setPendingAck(null);
        }}
      >
        {pendingAck?.band === "SUSPICIOUS" && (
          <DialogContent className="gap-5 px-8 py-6 sm:max-w-[28rem]" showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="text-xl">Отход {pendingAck.wastePct.replace(".", ",")}% — это верно?</DialogTitle>
            </DialogHeader>
            <p className="text-muted-foreground text-base leading-relaxed">
              Фактически взято реек: {pendingAck.railsTaken}
              <br />
              Общая длина: {pendingAck.takenM.replace(".", ",")} м
              <br />
              Полезный выход: {pendingAck.producedM.replace(".", ",")} м
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-14 rounded-xl text-lg"
                onClick={() => setPendingAck(null)}
              >
                Отмена
              </Button>
              <Button
                className="h-14 rounded-xl text-lg"
                disabled={submitting}
                onClick={() => void retryWithAck("SUSPICIOUS")}
              >
                Подтвердить
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={pendingAck?.band === "EXTREME"}
        onOpenChange={(o) => {
          if (!o) setPendingAck(null);
        }}
      >
        {pendingAck?.band === "EXTREME" && (
          <DialogContent
            className="scrollbar-thin-y max-h-[min(90vh,40rem)] gap-5 overflow-y-auto px-8 py-6 sm:max-w-[32rem]"
            showCloseButton={false}
          >
            <DialogHeader>
              <DialogTitle className="text-xl">Высокий отход / брак</DialogTitle>
            </DialogHeader>
            <p className={cn("text-base font-semibold", wasteBandClass("EXTREME"))}>
              Отход {pendingAck.wastePct.replace(".", ",")}%
            </p>
            <p className="text-muted-foreground text-base leading-relaxed">
              Фактически взято реек: {pendingAck.railsTaken}
              <br />
              Общая длина: {pendingAck.takenM.replace(".", ",")} м
              <br />
              Полезный выход: {pendingAck.producedM.replace(".", ",")} м
            </p>
            <div className="grid grid-cols-2 gap-2">
              {TORCOVKA_WASTE_REASONS.map((reason) => (
                <Button
                  key={reason}
                  type="button"
                  variant={highWasteReason === reason ? "brand" : "outline"}
                  className="h-12 rounded-xl text-base capitalize"
                  onClick={() => setHighWasteReason(reason)}
                >
                  {TORCOVKA_WASTE_REASON_LABEL[reason]}
                </Button>
              ))}
            </div>
            {highWasteReason === "OTHER" && (
              <Input
                value={highWasteNote}
                onChange={(e) => setHighWasteNote(e.target.value)}
                placeholder="Укажите причину"
                className="h-12 rounded-xl text-base"
              />
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-14 rounded-xl text-lg"
                onClick={() => setPendingAck(null)}
              >
                Отмена
              </Button>
              <Button
                className="h-14 rounded-xl text-lg"
                disabled={
                  submitting ||
                  !highWasteReason ||
                  (highWasteReason === "OTHER" && !highWasteNote.trim())
                }
                onClick={() => void retryWithAck("HIGH_WASTE")}
              >
                Подтвердить брак
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
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
