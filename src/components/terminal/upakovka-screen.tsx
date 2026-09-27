"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/components/terminal/toast";
import { Package } from "lucide-react";
import { OperationTile, OperationTileGrid } from "@/components/terminal/operation-tile";
import { QuantityDialog } from "@/components/terminal/quantity-dialog";
import { TerminalConfirmBar } from "@/components/terminal/terminal-confirm-bar";
import { useTerminalDraft } from "@/components/terminal/use-terminal-draft";
import { TerminalSuccessAck, useTerminalSuccessAck } from "@/components/terminal/terminal-success-ack";
import { submitUpakovka } from "@/server/terminal";
import { formatProductSku } from "@/lib/format";
import { sectionLabel } from "@/lib/material";
import { newRequestId } from "@/lib/request-id";
import { terminalDialogContentClass, terminalStickyOperationClass } from "@/lib/scroll-classes";
import { beginExclusiveSubmit, endExclusiveSubmit } from "@/lib/terminal-submit-guard";
import type { UpakovkaShortage } from "@/lib/upakovka-availability";
import {
  confirmedRecoveryPicks,
  UPAKOVKA_PARTIAL_BODY,
  UPAKOVKA_PARTIAL_TITLE,
  UPAKOVKA_RECOVERY_ACTION,
  UPAKOVKA_RECOVERY_CONFIRM,
  UPAKOVKA_RECOVERY_HINT,
  unrecordedCandidates,
} from "@/lib/upakovka-partial";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type {
  TerminalData,
  TerminalEmployee,
  TerminalProduct,
} from "@/components/terminal/types";

interface UpakovkaScreenProps {
  data: TerminalData;
  employee: TerminalEmployee;
  onDone: () => void | Promise<void>;
}

function availabilityOf(product: TerminalProduct, data: TerminalData) {
  return data.stock.upakovka[product.id] ?? { canAssemble: 0, shortages: [] };
}

export function UpakovkaScreen({ data, employee, onDone }: UpakovkaScreenProps) {
  const {
    draft: storedDraft,
    clientRequestId,
    save: saveDraft,
    clear: clearDraft,
  } = useTerminalDraft({ employeeId: employee.id });
  const liveProducts = useMemo(
    () => data.products.filter((p) => p.status === "ACTIVE"),
    [data.products],
  );
  const productById = useMemo(
    () => new Map(data.products.map((p) => [p.id, p])),
    [data.products],
  );
  const materialById = useMemo(
    () => new Map(data.materials.map((m) => [m.id, m])),
    [data.materials],
  );
  const [picked, setPicked] = useState<Record<string, number>>(() => {
    if (storedDraft?.operationType !== "UPAKOVKA") return {};
    const next: Record<string, number> = {};
    for (const p of storedDraft.payload.picks) {
      if (p.quantity > 0) next[p.productId] = p.quantity;
    }
    return next;
  });
  const [dialogProduct, setDialogProduct] = useState<TerminalProduct | null>(null);
  const [reasonProduct, setReasonProduct] = useState<TerminalProduct | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [partial, setPartial] = useState<{ productId: string; quantity: number }[] | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryQty, setRecoveryQty] = useState<Record<string, number>>({});
  const [separatelyPacked, setSeparatelyPacked] = useState<string[]>([]);
  const [recoveryProduct, setRecoveryProduct] = useState<TerminalProduct | null>(null);
  const submitLock = useRef(false);
  const recoveryRequest = useRef<{ signature: string; id: string } | null>(null);
  const successAck = useTerminalSuccessAck();

  const products = useMemo(() => {
    const seen = new Set(liveProducts.map((p) => p.id));
    const extra = Object.entries(picked)
      .filter(([id, qty]) => qty > 0 && !seen.has(id))
      .map(([id]) => {
        const existing = productById.get(id);
        return (
          existing ?? {
            id,
            name: "Изделие недоступно",
            materialId: "",
            skuOzon: "",
            skuWb: "",
            packagingId: null,
            status: "ARCHIVED" as const,
            details: [],
            fastenerIds: [],
            extraIds: [],
          }
        );
      });
    return [...liveProducts, ...extra];
  }, [liveProducts, picked, productById]);

  const dialogMax = dialogProduct
    ? Math.max(availabilityOf(dialogProduct, data).canAssemble, picked[dialogProduct.id] ?? 0)
    : 0;
  const pickedCount = Object.values(picked).reduce((a, b) => a + b, 0);
  const pickedLines = Object.keys(picked).filter((k) => (picked[k] ?? 0) > 0).length;
  const stockWarning = Object.entries(picked).some(([id, qty]) => {
    if (qty <= 0) return false;
    const product = productById.get(id);
    if (!product || product.status !== "ACTIVE") return true;
    return qty > availabilityOf(product, data).canAssemble;
  })
    ? "Текущий остаток меньше сохранённого количества. Если операция уже прошла, повтор будет идемпотентным."
    : null;
  const reasonShortages: UpakovkaShortage[] = reasonProduct
    ? availabilityOf(reasonProduct, data).shortages
    : [];

  useEffect(() => {
    const picks = Object.entries(picked)
      .filter(([, quantity]) => quantity > 0)
      .map(([productId, quantity]) => ({ productId, quantity }));
    saveDraft({ operationType: "UPAKOVKA", payload: { picks } });
  }, [picked, saveDraft]);

  const confirm = async () => {
    if (partial || pickedCount === 0) return;
    if (!beginExclusiveSubmit(submitLock)) return;
    const picks = Object.entries(picked)
      .filter(([, qty]) => qty > 0)
      .map(([productId, quantity]) => ({ productId, quantity }));
    setSubmitting(true);
    try {
      const result = await submitUpakovka({
        employeeId: employee.id,
        clientRequestId,
        picks,
      });
      if (result.status === "PARTIAL") {
        setPartial(result.saved);
        setRecoveryOpen(false);
        setRecoveryQty({});
        return;
      }
      toast.success(`Упаковано: ${pickedCount} шт`);
      clearDraft();
      setPicked({});
      setPartial(null);
      setDialogProduct(null);
      successAck.show(`Упаковка сохранена: ${pickedCount} шт`);
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
    } finally {
      endExclusiveSubmit(submitLock);
      setSubmitting(false);
    }
  };

  const savedIds = partial?.map((row) => row.productId) ?? [];
  const recoveryCandidates = unrecordedCandidates({
    draftPicks: Object.entries(picked).map(([productId, quantity]) => ({ productId, quantity })),
    savedProductIds: savedIds,
    separatelyPackedIds: separatelyPacked,
  });
  const recoveryPicks = confirmedRecoveryPicks({
    candidates: recoveryCandidates,
    confirmedQuantities: recoveryQty,
    savedProductIds: savedIds,
  });

  const confirmRecovery = async () => {
    if (!partial || recoveryPicks.length === 0) return;
    if (!beginExclusiveSubmit(submitLock)) return;
    const signature = recoveryPicks.map((pick) => `${pick.productId}:${pick.quantity}`).join("|");
    if (!recoveryRequest.current || recoveryRequest.current.signature !== signature) {
      recoveryRequest.current = { signature, id: newRequestId() };
    }
    setSubmitting(true);
    try {
      const result = await submitUpakovka({
        employeeId: employee.id,
        clientRequestId: recoveryRequest.current.id,
        recordedRequestId: clientRequestId,
        picks: recoveryPicks,
      });
      if (result.status === "PARTIAL") {
        toast.error("Отдельная упаковка сохранена не полностью. Сверьте журнал.");
        return;
      }
      const packedCount = recoveryPicks.reduce((sum, pick) => sum + pick.quantity, 0);
      toast.success(`Отдельная упаковка сохранена: ${packedCount} шт`);
      setSeparatelyPacked((prev) => [...prev, ...recoveryPicks.map((pick) => pick.productId)]);
      setRecoveryQty({});
      setRecoveryOpen(false);
      recoveryRequest.current = null;
      successAck.show(`Отдельная упаковка сохранена: ${packedCount} шт`);
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
    } finally {
      endExclusiveSubmit(submitLock);
      setSubmitting(false);
    }
  };

  return (
    <main className={terminalStickyOperationClass}>
      <TerminalSuccessAck ack={successAck.ack} />
      <h2 className="text-muted-foreground text-sm font-semibold tracking-wide uppercase">
        Изделия — сколько можно собрать
      </h2>

      <OperationTileGrid>
        {products.map((p) => {
          const max = availabilityOf(p, data).canAssemble;
          const qty = picked[p.id] ?? 0;
          const unavailable = max === 0 && qty === 0;
          const material = materialById.get(p.materialId);
          const sku = formatProductSku(p.skuOzon, p.skuWb);
          return (
            <OperationTile
              key={p.id}
              layout="grid"
              disabled={unavailable}
              allowClickWhenDisabled={unavailable}
              active={qty > 0}
              icon={<Package />}
              title={p.name}
              material={material ? { name: material.name, section: sectionLabel(material) } : undefined}
              subtitle={sku}
              highlight={qty > 0 ? { value: qty, label: "шт" } : undefined}
              badge={qty === 0 && !unavailable ? `${max} шт` : undefined}
              onClick={() => {
                successAck.dismiss();
                if (unavailable) {
                  setReasonProduct(p);
                  return;
                }
                setDialogProduct(p);
              }}
              onClear={
                qty > 0
                  ? () =>
                      setPicked((prev) => {
                        const next = { ...prev };
                        delete next[p.id];
                        return next;
                      })
                  : undefined
              }
            />
          );
        })}
      </OperationTileGrid>

      {stockWarning && <p className="text-amber-800 text-sm leading-relaxed">{stockWarning}</p>}

      {partial && (
        <div className="space-y-3 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-lg font-semibold">{UPAKOVKA_PARTIAL_TITLE}</p>
          <p className="text-base leading-relaxed">{UPAKOVKA_PARTIAL_BODY}</p>
          <ul className="space-y-1 text-base">
            {partial.map((row) => {
              const product = data.products.find((item) => item.id === row.productId);
              return (
                <li key={row.productId}>
                  {product?.name ?? "Изделие"} — {row.quantity} шт
                </li>
              );
            })}
          </ul>
          {recoveryCandidates.length > 0 && !recoveryOpen && (
            <Button
              className="h-14 w-full rounded-xl text-lg"
              onClick={() => {
                setRecoveryQty({});
                setRecoveryOpen(true);
              }}
            >
              {UPAKOVKA_RECOVERY_ACTION}
            </Button>
          )}
          {recoveryOpen && (
            <div className="space-y-3">
              <p className="text-base leading-relaxed">{UPAKOVKA_RECOVERY_HINT}</p>
              {recoveryCandidates.map((productId) => {
                const product = data.products.find((item) => item.id === productId);
                const qty = recoveryQty[productId] ?? 0;
                return (
                  <Button
                    key={productId}
                    variant="outline"
                    className="h-14 w-full justify-between rounded-xl text-lg"
                    onClick={() => setRecoveryProduct(product ?? null)}
                  >
                    <span>{product?.name ?? "Изделие"}</span>
                    <span>{qty > 0 ? `${qty} шт` : "Указать"}</span>
                  </Button>
                );
              })}
              <Button
                className="h-14 w-full rounded-xl text-lg"
                disabled={recoveryPicks.length === 0 || submitting}
                onClick={() => void confirmRecovery()}
              >
                {UPAKOVKA_RECOVERY_CONFIRM}
              </Button>
            </div>
          )}
        </div>
      )}

      {!partial && (
      <TerminalConfirmBar
        label="Сохранить операцию"
        summary={
          <>
            <span className="font-medium">{pickedCount} шт</span>
            <span className="text-muted-foreground ml-3">
              {pickedLines > 0 ? `${pickedLines} поз.` : "выберите изделия"}
            </span>
          </>
        }
        disabled={pickedCount === 0 || submitting}
        onConfirm={confirm}
      />
      )}

      <QuantityDialog
        open={dialogProduct != null}
        title={dialogProduct?.name ?? ""}
        hint={dialogProduct ? `Можно собрать: ${dialogMax} шт` : ""}
        initial={dialogProduct ? (picked[dialogProduct.id] ?? 0) : 0}
        max={dialogMax > 0 ? dialogMax : undefined}
        onConfirm={(v) => {
          if (dialogProduct) {
            setPicked((p) => ({ ...p, [dialogProduct.id]: v }));
          }
          setDialogProduct(null);
        }}
        onClose={() => setDialogProduct(null)}
      />

      <QuantityDialog
        open={recoveryProduct != null}
        title={recoveryProduct?.name ?? ""}
        hint="Количество не подставляется из черновика"
        initial={0}
        max={
          recoveryProduct
            ? Math.max(availabilityOf(recoveryProduct, data).canAssemble, 0) || undefined
            : undefined
        }
        onConfirm={(v) => {
          if (recoveryProduct) {
            setRecoveryQty((prev) => ({ ...prev, [recoveryProduct.id]: v }));
          }
          setRecoveryProduct(null);
        }}
        onClose={() => setRecoveryProduct(null)}
      />

      <Dialog open={reasonProduct != null} onOpenChange={(o) => !o && setReasonProduct(null)}>
        {reasonProduct && (
          <DialogContent className={terminalDialogContentClass} showCloseButton={false}>
            <DialogHeader>
              <DialogTitle className="text-xl">{reasonProduct.name}</DialogTitle>
            </DialogHeader>
            <p className="text-base font-medium">Нельзя упаковать</p>
            {reasonShortages.length > 0 ? (
              <div className="space-y-1">
                <p className="text-muted-foreground text-base">Не хватает:</p>
                <ul className="space-y-1 text-base">
                  {reasonShortages.map((line) => (
                    <li key={`${line.kind}:${line.name}`}>
                      {line.name} — {line.shortage} шт
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-muted-foreground text-base">Нет состава изделия.</p>
            )}
            <Button
              className="h-14 w-full rounded-xl text-lg"
              onClick={() => setReasonProduct(null)}
            >
              Понятно
            </Button>
          </DialogContent>
        )}
      </Dialog>
    </main>
  );
}
