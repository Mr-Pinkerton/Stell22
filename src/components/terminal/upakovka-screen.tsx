"use client";

import { useMemo, useState } from "react";
import { toast } from "@/components/terminal/toast";
import { Package } from "lucide-react";
import { OperationTile, OperationTileGrid } from "@/components/terminal/operation-tile";
import { QuantityDialog } from "@/components/terminal/quantity-dialog";
import { TerminalConfirmBar } from "@/components/terminal/terminal-confirm-bar";
import type { Product } from "@/types/domain";
import type { TerminalData } from "@/components/terminal/types";

interface UpakovkaScreenProps {
  data: TerminalData;
  onDone: () => void;
}

/** Сколько изделий можно собрать = минимум по всем компонентам. */
function canAssemble(product: Product, data: TerminalData): number {
  const limits: number[] = [];
  for (const d of product.details) {
    const ready = data.stock.detailsReady[d.detailId] ?? 0;
    limits.push(Math.floor(ready / d.quantity));
  }
  for (const f of product.fastenerIds) {
    const have = data.stock.nomenclature[f.nomenclatureId] ?? 0;
    limits.push(Math.floor(have / f.quantity));
  }
  if (product.packagingId) {
    limits.push(data.stock.nomenclature[product.packagingId] ?? 0);
  }
  return limits.length ? Math.max(0, Math.min(...limits)) : 0;
}

export function UpakovkaScreen({ data, onDone }: UpakovkaScreenProps) {
  const products = useMemo(
    () => data.products.filter((p) => p.status === "ACTIVE"),
    [data.products],
  );
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [dialogProduct, setDialogProduct] = useState<Product | null>(null);

  const dialogMax = dialogProduct ? canAssemble(dialogProduct, data) : 0;
  const pickedCount = Object.values(picked).reduce((a, b) => a + b, 0);
  const pickedLines = Object.keys(picked).filter((k) => (picked[k] ?? 0) > 0).length;

  const confirm = () => {
    if (pickedCount === 0) return;
    toast.success(`Упаковано: ${pickedCount} шт`);
    onDone();
  };

  return (
    <main className="flex flex-1 flex-col gap-5 p-6">
      <h2 className="text-muted-foreground text-sm font-semibold tracking-wide uppercase">
        Изделия — сколько можно собрать
      </h2>

      <OperationTileGrid>
        {products.map((p) => {
          const max = canAssemble(p, data);
          const disabled = max === 0;
          const qty = picked[p.id] ?? 0;
          return (
            <OperationTile
              key={p.id}
              layout="grid"
              disabled={disabled}
              active={qty > 0}
              icon={<Package />}
              title={p.name}
              subtitle={p.sku}
              highlight={qty > 0 ? { value: qty, label: "шт" } : undefined}
              badge={qty === 0 && !disabled ? `${max} шт` : undefined}
              onClick={() => !disabled && setDialogProduct(p)}
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

      <TerminalConfirmBar
        summary={
          <>
            <span className="font-medium">{pickedCount} шт</span>
            <span className="text-muted-foreground ml-3">
              {pickedLines > 0 ? `${pickedLines} поз.` : "выберите изделия"}
            </span>
          </>
        }
        disabled={pickedCount === 0}
        onConfirm={confirm}
      />

      <QuantityDialog
        open={dialogProduct != null}
        title={dialogProduct?.name ?? ""}
        hint={dialogProduct ? `Можно собрать: ${dialogMax} шт` : ""}
        initial={dialogProduct ? (picked[dialogProduct.id] ?? 0) : 0}
        max={dialogMax}
        onConfirm={(v) => {
          if (dialogProduct) {
            setPicked((p) => ({ ...p, [dialogProduct.id]: v }));
          }
          setDialogProduct(null);
        }}
        onClose={() => setDialogProduct(null)}
      />
    </main>
  );
}
