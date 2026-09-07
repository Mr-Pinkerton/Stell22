"use client";

import { useEffect, useMemo, useState } from "react";
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
import { terminalDialogContentClass, terminalStickyOperationClass } from "@/lib/scroll-classes";
import type { UpakovkaShortage } from "@/lib/upakovka-availability";
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
    if (pickedCount === 0 || submitting) return;
    const picks = Object.entries(picked)
      .filter(([, qty]) => qty > 0)
      .map(([productId, quantity]) => ({ productId, quantity }));
    setSubmitting(true);
    try {
      await submitUpakovka({
        employeeId: employee.id,
        clientRequestId,
        picks,
      });
      toast.success(`Упаковано: ${pickedCount} шт`);
      clearDraft();
      setPicked({});
      setDialogProduct(null);
      successAck.show(`Упаковка сохранена: ${pickedCount} шт`);
      await onDone();
      setSubmitting(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
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

      <TerminalConfirmBar
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
