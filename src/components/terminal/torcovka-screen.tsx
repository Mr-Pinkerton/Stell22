"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/terminal/toast";
import { Boxes, ChevronLeft, ChevronRight, Layers, Package, Ruler, Trash2 } from "lucide-react";
import { useTerminalDraft } from "@/components/terminal/use-terminal-draft";
import type { TorcovkaAckUiPhase } from "@/lib/terminal-draft-storage";
import { restorePendingAck, type RestoredPendingAck } from "@/lib/restore-pending-ack";
import { cn } from "@/lib/utils";
import { OperationTile, OperationTileGrid, OperationTileRow } from "@/components/terminal/operation-tile";
import { QuantityDialog } from "@/components/terminal/quantity-dialog";
import { TerminalConfirmBar } from "@/components/terminal/terminal-confirm-bar";
import { NumericKeypad } from "@/components/terminal/numeric-keypad";
import { KeypadDisplay } from "@/components/terminal/keypad-panel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatGroupedDecimal, formatLength } from "@/lib/format";
import { TerminalDialogScrollBody } from "@/components/terminal/terminal-dialog-scroll-body";
import { TerminalSuccessAck, useTerminalSuccessAck } from "@/components/terminal/terminal-success-ack";
import {
  terminalDialogContentClass,
  terminalDialogShellClass,
  terminalOperationBodyClass,
  terminalOperationScreenClass,
} from "@/lib/scroll-classes";
import { maxDetailQuantity, type TorcovkaPick } from "@/lib/torcovka";
import {
  applyRailsCancelled,
  applyRailsConfirmed,
  canEnterTorcovkaBlanks,
  decideBatchTap,
  decideLotTap,
  isTorcovkaDirty,
  nextTorcovkaStateAfterSuccess,
  shouldShowTorcovkaConfirmBar,
  shouldSkipTorcovkaDraftPersist,
  torcovkaBlankPrerequisiteHint,
  torcovkaSavedDetail,
  TORCOVKA_SWITCH_RESET,
  TORCOVKA_SWITCH_STAY,
  TORCOVKA_SWITCH_WARNING,
} from "@/lib/torcovka-terminal-flow";
import { computeTorcovkaWasteMetrics } from "@/lib/torcovka-plausibility";
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
  onDone: () => void | Promise<void>;
}

type Dialog = { kind: "rails" } | { kind: "length"; lengthM: number; sort: Sort } | null;

type PendingSwitch = { kind: "lot"; lotId: string } | { kind: "batch"; batchId: string };

type PendingAck = RestoredPendingAck;

function wasteBandClass(band: "NORMAL" | "SUSPICIOUS" | "EXTREME"): string {
  if (band === "NORMAL") return "text-muted-foreground";
  if (band === "SUSPICIOUS") return "text-amber-700 font-medium";
  return "text-destructive font-semibold";
}

const SORT_LABEL: Record<Sort, string> = { SORT1: "1 сорт", SORT2: "2 сорт" };
const RAIL_TYPE_LABEL: Record<RailType, string> = { POLKA: "Полка", KANAVKA: "Канавка" };
const APPROVAL_CODE_LENGTH = 4;
const CODE_ROTATED_MESSAGE =
  "Старый код больше не действует. Запросите новый код у администратора.";
const WRONG_APPROVAL_CODE_MESSAGE = "Неверный код подтверждения";

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
  const [approvalCode, setApprovalCode] = useState(initial?.ackUi.approvalCode ?? "");
  const [pendingLotId, setPendingLotId] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);
  const successAck = useTerminalSuccessAck();
  const skipDraftPersistRef = useRef(false);
  const applySelectionAfterRefresh = useRef(false);
  const selectionAfterSuccessRef = useRef<{
    batchId: string | null;
    lotId: string | null;
  } | null>(null);
  const batchRowRef = useRef<HTMLDivElement>(null);
  const lotRowRef = useRef<HTMLDivElement>(null);

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
  const batchPager = useRowPagerEdges(batchRowRef, batches.length);
  const lotPager = useRowPagerEdges(lotRowRef, `${batchId ?? ""}:${lots.length}`);
  const lot = data.railLots.find((l) => l.id === lotId) ?? null;
  const pendingLot = pendingLotId ? (data.railLots.find((l) => l.id === pendingLotId) ?? null) : null;
  const railsDialogLot = pendingLot ?? lot;
  const lotMissing = Boolean(lotId) && !lot;
  const stockLow = Boolean(lot && railsTaken > lot.remainingQuantity);
  const blanksReady = canEnterTorcovkaBlanks({ lotId, railsTaken });
  const blankHint = torcovkaBlankPrerequisiteHint({ batchId, lotId, railsTaken });

  // Заготовки нарезаются по длине; конкретная деталь определяется на присадке.
  // Доступные длины — из каталога деталей соответствующего типа рейки.
  const lengthTiles = useMemo(() => {
    if (!blanksReady || !lot) return [];
    const lengths = new Set<number>();
    for (const d of data.details) {
      if (d.status === "ACTIVE" && d.detailType === lot.railType) lengths.add(d.lengthM);
    }
    return [...lengths].sort((a, b) => a - b);
  }, [blanksReady, data.details, lot]);

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
    pendingAck?.status === "APPROVAL_REQUIRED" || pendingAck?.band === "EXTREME"
      ? "approval"
      : pendingAck?.band === "SUSPICIOUS"
        ? "suspicious"
        : "none";

  useEffect(() => {
    if (
      shouldSkipTorcovkaDraftPersist({
        suppressPostSuccess: skipDraftPersistRef.current,
        railsTaken,
        pickedCount,
      })
    ) {
      return;
    }
    skipDraftPersistRef.current = false;
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
          approvalCode,
        },
      },
    });
  }, [
    batchId,
    lotId,
    railsTaken,
    picked,
    pickedCount,
    activeSort,
    ackPhase,
    approvalCode,
    saveDraft,
  ]);

  useEffect(() => {
    if (!applySelectionAfterRefresh.current) return;
    applySelectionAfterRefresh.current = false;
    const keep = selectionAfterSuccessRef.current;
    selectionAfterSuccessRef.current = null;
    if (!keep) return;
    const next = nextTorcovkaStateAfterSuccess({
      batchId: keep.batchId,
      lotId: keep.lotId,
      batches: data.batches,
      lots: data.railLots,
    });
    setBatchId(next.batchId);
    setLotId(next.lotId);
    setRailsTaken(0);
  }, [data]);

  const resetLot = () => {
    setLotId(null);
    setRailsTaken(0);
    setPicked({});
    setPendingAck(null);
    setPendingLotId(null);
  };

  const selectBatch = (b: TerminalBatch) => {
    successAck.dismiss();
    skipDraftPersistRef.current = false;
    const dirty = isTorcovkaDirty({ railsTaken, pickedCount });
    const decision = decideBatchTap({
      tappedBatchId: b.id,
      committedBatchId: batchId,
      dirty,
    });
    if (decision === "noop") return;
    if (decision === "confirm-switch") {
      setPendingSwitch({ kind: "batch", batchId: b.id });
      return;
    }
    setBatchId(b.id);
    resetLot();
  };

  const selectLot = (l: TerminalRailLot) => {
    successAck.dismiss();
    skipDraftPersistRef.current = false;
    const dirty = isTorcovkaDirty({ railsTaken, pickedCount });
    const decision = decideLotTap({
      tappedLotId: l.id,
      committedLotId: lotId,
      dirty,
    });
    if (decision.action === "edit-rails") {
      setPendingLotId(l.id);
      setDialog({ kind: "rails" });
      return;
    }
    if (decision.action === "confirm-switch") {
      setPendingSwitch({ kind: "lot", lotId: l.id });
      return;
    }
    setPendingLotId(decision.nextLotId);
    setDialog({ kind: "rails" });
  };

  const confirmDestructiveSwitch = () => {
    if (!pendingSwitch) return;
    skipDraftPersistRef.current = false;
    if (pendingSwitch.kind === "lot") {
      const nextLotId = pendingSwitch.lotId;
      setPendingSwitch(null);
      setPendingLotId(nextLotId);
      setDialog({ kind: "rails" });
      return;
    }
    const nextBatchId = pendingSwitch.batchId;
    setPendingSwitch(null);
    setBatchId(nextBatchId);
    resetLot();
  };

  const finishCreated = async (detail: string, toastMessage: string) => {
    toast.success(toastMessage);
    skipDraftPersistRef.current = true;
    clearDraft();
    setPicked({});
    setPendingAck(null);
    setApprovalCode("");
    setDialog(null);
    setPendingLotId(null);
    setPendingSwitch(null);
    setRailsTaken(0);
    selectionAfterSuccessRef.current = { batchId, lotId };
    applySelectionAfterRefresh.current = true;
    successAck.show(detail);
    await onDone();
    setSubmitting(false);
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
      if (result.status === "ACK_REQUIRED" || result.status === "APPROVAL_REQUIRED") {
        if (result.status === "APPROVAL_REQUIRED") {
          setApprovalCode("");
        }
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
      await finishCreated(
        torcovkaSavedDetail(pickedCount),
        `Торцовка внесена: ${pickedCount} заг., отход ${wasteLabel}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
      setSubmitting(false);
    }
  };

  const retryWithAck = async (ackKind: "SUSPICIOUS") => {
    if (!pendingAck || submitting) return;
    if (pendingAck.status !== "ACK_REQUIRED") return;
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
        },
      });
      if (result.status === "ACK_REQUIRED" || result.status === "APPROVAL_REQUIRED") {
        if (result.status === "APPROVAL_REQUIRED") {
          setApprovalCode("");
        }
        setPendingAck((prev) => (prev ? { ...prev, ...result } : prev));
        setSubmitting(false);
        return;
      }
      const qty = pendingAck.picks.reduce((s, p) => s + p.quantity, 0);
      setPendingAck(null);
      await finishCreated(torcovkaSavedDetail(qty), `Торцовка внесена: ${qty} заг.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
      setSubmitting(false);
    }
  };

  const retryWithApprovalCode = async () => {
    if (!pendingAck || submitting) return;
    if (pendingAck.status !== "APPROVAL_REQUIRED") return;
    if (approvalCode.length !== APPROVAL_CODE_LENGTH) return;
    setSubmitting(true);
    try {
      const result = await submitTorcovka({
        employeeId: employee.id,
        clientRequestId: pendingAck.clientRequestId,
        batchId: pendingAck.batchId,
        railLotId: pendingAck.railLotId,
        railsTaken: pendingAck.railsTaken,
        picks: pendingAck.picks,
        approvalCode,
      });
      if (result.status === "APPROVAL_REQUIRED") {
        setApprovalCode("");
        setPendingAck((prev) => (prev ? { ...prev, ...result } : prev));
        toast.error(CODE_ROTATED_MESSAGE);
        setSubmitting(false);
        return;
      }
      if (result.status === "ACK_REQUIRED") {
        setPendingAck((prev) => (prev ? { ...prev, ...result } : prev));
        setSubmitting(false);
        return;
      }
      const qty = pendingAck.picks.reduce((s, p) => s + p.quantity, 0);
      setPendingAck(null);
      setApprovalCode("");
      await finishCreated(torcovkaSavedDetail(qty), `Торцовка внесена: ${qty} заг.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
      if (err instanceof Error && err.message === WRONG_APPROVAL_CODE_MESSAGE) {
        setApprovalCode("");
      }
      setSubmitting(false);
    }
  };

  return (
    <main className={terminalOperationScreenClass}>
      <div className={terminalOperationBodyClass}>
      <TerminalSuccessAck ack={successAck.ack} />
      <Section
        title="1. ПАРТИЯ"
        aside={
          <RowPager
            total={batches.length}
            unit="партий"
            prevLabel="Предыдущая партия"
            nextLabel="Следующая партия"
            canPrev={batchPager.canPrev}
            canNext={batchPager.canNext}
            onPrev={() => scrollRowBy(batchRowRef.current, -1)}
            onNext={() => scrollRowBy(batchRowRef.current, 1)}
          />
        }
      >
        <OperationTileRow rowRef={batchRowRef}>
          {batches.map((b) => (
            <OperationTile
              key={b.id}
              layout="compact"
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
        <Section
          title="2. ПАКЕТ / РЕЙКА"
          aside={
            <RowPager
              total={lots.length}
              unit="пакетов"
              prevLabel="Предыдущий пакет"
              nextLabel="Следующий пакет"
              canPrev={lotPager.canPrev}
              canNext={lotPager.canNext}
              onPrev={() => scrollRowBy(lotRowRef.current, -1)}
              onNext={() => scrollRowBy(lotRowRef.current, 1)}
            />
          }
        >
          <OperationTileRow rowRef={lotRowRef}>
            {lots.map((l) => {
              const taken = l.id === lotId ? railsTaken : 0;
              const remaining = l.remainingQuantity;
              const remainder =
                remaining <= 0 ? 0 : Math.max(0, 1 - Math.min(1, taken / remaining));
              return (
                <OperationTile
                  key={l.id}
                  layout="compact"
                  active={l.id === lotId}
                  icon={<Layers />}
                  title={l.isPackage ? `Пакет ${l.code}` : "Поштучно"}
                  subtitle={`${formatLength(l.lengthM)} · ${SORT_LABEL[l.sort]} · ${RAIL_TYPE_LABEL[l.railType]}`}
                  meter={{
                    caption: `осталось ${remaining} реек`,
                    value: remainder,
                  }}
                  onClick={() => selectLot(l)}
                />
              );
            })}
            {lots.length === 0 && <Empty>Нет доступных реек в партии</Empty>}
          </OperationTileRow>
        </Section>
      )}

      {blanksReady && (
        <Section title="3. ЗАГОТОВКИ">
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              {(["SORT1", "SORT2"] as const).map((s) => {
                const count = torcovkaPicks
                  .filter((p) => p.sort === s)
                  .reduce((a, p) => a + p.quantity, 0);
                return (
                  <Button
                    key={s}
                    type="button"
                    variant="outline"
                    className={cn(
                      "h-14 min-w-36 rounded-xl px-8 text-lg font-semibold",
                      s === activeSort && "border-brand bg-brand/5",
                    )}
                    onClick={() => setActiveSort(s)}
                  >
                    {SORT_LABEL[s]}
                    {count > 0 && <span className="text-brand ml-2 tabular-nums">{count}</span>}
                  </Button>
                );
              })}
              {torcovkaPicks.some((p) => p.sort === activeSort && p.quantity > 0) && (
                <Button
                  type="button"
                  variant="outline"
                  className="text-muted-foreground h-14 rounded-xl px-8 text-lg font-semibold"
                  onClick={() =>
                    setPicked((p) => {
                      const next = { ...p };
                      for (const key of Object.keys(next)) {
                        if (key.endsWith(`|${activeSort}`)) delete next[key];
                      }
                      return next;
                    })
                  }
                >
                  Сбросить
                </Button>
              )}
            </div>

            <OperationTileGrid>
            {lengthTiles.map((lengthM) => {
              const key = pickKey(lengthM, activeSort);
              const qty = picked[key] ?? 0;
              return (
                <OperationTile
                  key={key}
                  layout="blank"
                  active={qty > 0}
                  title={formatLength(lengthM)}
                  subtitle={SORT_LABEL[activeSort]}
                  highlight={{ value: qty, label: "шт" }}
                  onClick={() => {
                    successAck.dismiss();
                    setDialog({ kind: "length", lengthM, sort: activeSort });
                  }}
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

      {blankHint && (
        <p className="text-muted-foreground text-base leading-relaxed">{blankHint}</p>
      )}
      </div>

      {shouldShowTorcovkaConfirmBar({ pickedCount }) && (
        <div className="bg-card flex-none">
          {(lotMissing || stockLow) && (
            <p className="text-amber-800 px-6 pt-3 text-sm leading-relaxed">
              {lotMissing
                ? "Пакет больше недоступен в каталоге. Если операция уже прошла, повтор будет идемпотентным."
                : "В пакете сейчас меньше реек, чем во вводе. Если операция уже прошла, повтор будет идемпотентным."}
            </p>
          )}
        <TerminalConfirmBar
          layout="docked"
          summary={
            <div className="flex min-w-0 items-center divide-x divide-border">
              <ConfirmMetric
                icon={<Package />}
                label="Взято"
                value={`${formatGroupedDecimal(wasteMetrics ? wasteMetrics.takenM.toNumber() : 0, 2)} м`}
              />
              <ConfirmMetric
                icon={<Ruler />}
                label="Использовано"
                value={`${formatGroupedDecimal(wasteMetrics ? wasteMetrics.producedM.toNumber() : 0, 2)} м`}
              />
              <ConfirmMetric
                icon={<Trash2 />}
                label="Отход"
                value={`${formatGroupedDecimal(wasteMetrics ? Number(wasteMetrics.canon.wastePct) : 0, 2)}%`}
                valueClassName={
                  wasteMetrics && wasteMetrics.band !== "NORMAL"
                    ? wasteBandClass(wasteMetrics.band)
                    : undefined
                }
              />
            </div>
          }
          disabled={railsTaken <= 0 || pickedCount === 0 || overLength || submitting}
          onConfirm={confirm}
        />
        </div>
      )}

      <QuantityDialog
        open={dialog?.kind === "rails"}
        title="Сколько реек вы взяли в работу?"
        hint=""
        initial={pendingLotId != null && pendingLotId !== lotId ? 0 : railsTaken}
        max={
          railsDialogLot
            ? Math.max(
                railsDialogLot.remainingQuantity,
                pendingLotId === lotId ? railsTaken : 0,
              )
            : undefined
        }
        onConfirm={(v) => {
          successAck.dismiss();
          skipDraftPersistRef.current = false;
          const pending = pendingLotId ?? lotId;
          if (!pending) {
            setDialog(null);
            return;
          }
          const next = applyRailsConfirmed({
            pendingLotId: pending,
            committedLotId: lotId,
            railsTaken: v,
          });
          setLotId(next.lotId);
          setRailsTaken(next.railsTaken);
          if (next.resetPicks) {
            setPicked({});
            setPendingAck(null);
          }
          setPendingLotId(applyRailsCancelled().pendingLotId);
          setDialog(null);
        }}
        onClose={() => {
          setPendingLotId(applyRailsCancelled().pendingLotId);
          setDialog(null);
        }}
      />
      <QuantityDialog
        open={dialog?.kind === "length" && blanksReady}
        title={
          dialog?.kind === "length"
            ? `Заготовка ${formatLength(dialog.lengthM)} · ${SORT_LABEL[dialog.sort]}`
            : ""
        }
        initial={dialog?.kind === "length" ? (picked[pickKey(dialog.lengthM, dialog.sort)] ?? 0) : 0}
        max={
          dialog?.kind === "length" && blanksReady && lot
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
            successAck.dismiss();
            setPicked((p) => ({ ...p, [pickKey(dialog.lengthM, dialog.sort)]: v }));
          }
          setDialog(null);
        }}
        onClose={() => setDialog(null)}
      />

      <Dialog
        open={pendingSwitch != null}
        onOpenChange={(o) => {
          if (!o) setPendingSwitch(null);
        }}
      >
        {pendingSwitch && (
          <DialogContent className={terminalDialogContentClass} showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="text-xl">{TORCOVKA_SWITCH_WARNING}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-14 rounded-xl text-lg"
                onClick={() => setPendingSwitch(null)}
              >
                {TORCOVKA_SWITCH_STAY}
              </Button>
              <Button className="h-14 rounded-xl text-lg" onClick={confirmDestructiveSwitch}>
                {TORCOVKA_SWITCH_RESET}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={pendingAck?.band === "SUSPICIOUS"}
        onOpenChange={(o) => {
          if (!o) setPendingAck(null);
        }}
      >
        {pendingAck?.band === "SUSPICIOUS" && (
          <DialogContent className={terminalDialogContentClass} showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="text-xl">Отход {formatGroupedDecimal(Number(pendingAck.wastePct), 4)}% — это верно?</DialogTitle>
            </DialogHeader>
            <p className="text-muted-foreground text-base leading-relaxed">
              Фактически взято реек: {pendingAck.railsTaken}
              <br />
              Общая длина: {formatGroupedDecimal(Number(pendingAck.takenM), 2)} м
              <br />
              Полезный выход: {formatGroupedDecimal(Number(pendingAck.producedM), 2)} м
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
        open={pendingAck?.status === "APPROVAL_REQUIRED"}
        onOpenChange={(o) => {
          if (!o) setPendingAck(null);
        }}
      >
        {pendingAck?.status === "APPROVAL_REQUIRED" && (
          <DialogContent
            className={cn(terminalDialogShellClass, "px-8 py-6 sm:max-w-[32rem]")}
            showCloseButton={false}
          >
            <TerminalDialogScrollBody>
            <DialogHeader>
              <DialogTitle className="text-xl">Высокий процент брака</DialogTitle>
            </DialogHeader>
            <p className="text-base leading-relaxed">
              Для проведения операции требуется подтверждение руководителя.
            </p>
            <p className="text-muted-foreground text-base leading-relaxed">
              Взято реек: {pendingAck.railsTaken}
              <br />
              Входные метры: {formatGroupedDecimal(Number(pendingAck.takenM), 4)} м
              <br />
              Выходные метры: {formatGroupedDecimal(Number(pendingAck.producedM), 4)} м
              <br />
              Отход: {formatGroupedDecimal(Number(pendingAck.wasteM), 4)} м
              <br />
              <span className={cn("font-semibold", wasteBandClass("EXTREME"))}>
                Отход {formatGroupedDecimal(Number(pendingAck.wastePct), 4)}%
              </span>
            </p>
            <KeypadDisplay
              footerMessage="Спросите код у руководителя."
              showFooterMessage
              footerTone="muted"
            >
              {approvalCode.length > 0 ? approvalCode : "••••"}
            </KeypadDisplay>
            <NumericKeypad
              value={approvalCode}
              onChange={setApprovalCode}
              maxLength={APPROVAL_CODE_LENGTH}
              allowLeadingZeros
            />
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                className="h-14 rounded-xl text-lg"
                onClick={() => setPendingAck(null)}
              >
                Назад
              </Button>
              <Button
                className="h-14 rounded-xl text-lg"
                disabled={submitting || approvalCode.length !== APPROVAL_CODE_LENGTH}
                onClick={() => void retryWithApprovalCode()}
              >
                Подтвердить
              </Button>
            </div>
            </TerminalDialogScrollBody>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}

const pendingRowScrollLeft = new WeakMap<HTMLDivElement, number>();

function getRowScrollLeft(row: HTMLDivElement) {
  return pendingRowScrollLeft.get(row) ?? row.scrollLeft;
}

function getRowPagerEdges(row: HTMLDivElement | null) {
  if (!row) return { canPrev: false, canNext: false };
  const max = row.scrollWidth - row.clientWidth;
  const left = getRowScrollLeft(row);
  return {
    canPrev: left > 1,
    canNext: max > 1 && left < max - 1,
  };
}

function scrollRowBy(row: HTMLDivElement | null, direction: -1 | 1) {
  if (!row) return;
  const child = row.firstElementChild;
  if (!(child instanceof HTMLElement)) return;
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
  const step = child.offsetWidth + gap;
  const max = Math.max(0, row.scrollWidth - row.clientWidth);
  const next = Math.min(max, Math.max(0, getRowScrollLeft(row) + direction * step));
  pendingRowScrollLeft.set(row, next);
  row.scrollTo({ left: next, behavior: "smooth" });
  row.dispatchEvent(new Event("scroll"));
}

function useRowPagerEdges(
  rowRef: React.RefObject<HTMLDivElement | null>,
  syncKey: string | number,
) {
  const [edges, setEdges] = useState({ canPrev: false, canNext: false });
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) {
      setEdges({ canPrev: false, canNext: false });
      return;
    }
    const update = () => {
      const pending = pendingRowScrollLeft.get(row);
      if (pending != null && Math.abs(row.scrollLeft - pending) < 1) {
        pendingRowScrollLeft.delete(row);
      }
      const next = getRowPagerEdges(row);
      setEdges((prev) =>
        prev.canPrev === next.canPrev && prev.canNext === next.canNext ? prev : next,
      );
    };
    const onPointerDown = () => {
      pendingRowScrollLeft.delete(row);
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    row.addEventListener("pointerdown", onPointerDown);
    const ro = new ResizeObserver(update);
    ro.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      row.removeEventListener("pointerdown", onPointerDown);
      ro.disconnect();
    };
  }, [rowRef, syncKey]);
  return edges;
}

function RowPager({
  total,
  unit,
  prevLabel,
  nextLabel,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  total: number;
  unit: string;
  prevLabel: string;
  nextLabel: string;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground text-sm font-semibold tabular-nums">
        {total} {unit}
      </span>
      <Button
        type="button"
        variant="outline"
        className="size-14 shrink-0 rounded-xl [&_svg]:size-8"
        disabled={!canPrev}
        onClick={onPrev}
        aria-label={prevLabel}
      >
        <ChevronLeft />
      </Button>
      <Button
        type="button"
        variant="outline"
        className="size-14 shrink-0 rounded-xl [&_svg]:size-8"
        disabled={!canNext}
        onClick={onNext}
        aria-label={nextLabel}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

function ConfirmMetric({
  icon,
  label,
  value,
  valueClassName,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center gap-3 px-5 first:pl-0 last:pr-0">
      <span className="bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-full [&_svg]:size-5 [&_svg]:stroke-[1.75]">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-muted-foreground text-xs font-medium">{label}</div>
        <div className={cn("text-lg leading-tight font-semibold tabular-nums", valueClassName)}>
          {value}
        </div>
      </div>
    </div>
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
