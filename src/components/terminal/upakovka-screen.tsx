"use client";

import { useState } from "react";
import { toast } from "@/components/terminal/toast";
import { Package } from "lucide-react";
import { OperationTile, OperationTileRow } from "@/components/terminal/operation-tile";
import { QuantityDialog } from "@/components/terminal/quantity-dialog";
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
  const products = data.products.filter((p) => p.status === "ACTIVE");
  const [dialog, setDialog] = useState<{ product: Product; max: number } | null>(null);

  return (
    <main className="flex flex-1 flex-col gap-5 p-6">
      <h2 className="text-muted-foreground text-sm font-semibold tracking-wide uppercase">
        Изделия — сколько можно собрать
      </h2>

      <OperationTileRow>
        {products.map((p) => {
          const max = canAssemble(p, data);
          const disabled = max === 0;
          return (
            <OperationTile
              key={p.id}
              disabled={disabled}
              icon={<Package />}
              title={p.name}
              subtitle={p.sku}
              badge={`${max} шт`}
              onClick={() => !disabled && setDialog({ product: p, max })}
            />
          );
        })}
      </OperationTileRow>

      <QuantityDialog
        open={dialog != null}
        title={dialog?.product.name ?? ""}
        hint={dialog ? `Можно собрать: ${dialog.max} шт` : ""}
        max={dialog?.max}
        confirmLabel="Упаковать"
        onConfirm={(v) => {
          toast.success(`Упаковано: ${v} шт «${dialog?.product.name}»`);
          setDialog(null);
          onDone();
        }}
        onClose={() => setDialog(null)}
      />
    </main>
  );
}
