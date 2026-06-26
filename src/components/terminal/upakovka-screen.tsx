"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Package } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {products.map((p) => {
          const max = canAssemble(p, data);
          const disabled = max === 0;
          return (
            <Card
              key={p.id}
              className={cn(
                "surface-card ring-0 transition-all",
                disabled
                  ? "opacity-60"
                  : "cursor-pointer hover:-translate-y-0.5 hover:shadow-soft-lg",
              )}
            >
              <CardContent
                className="flex flex-col gap-3 py-6"
                onClick={() => !disabled && setDialog({ product: p, max })}
              >
                <div className="flex items-center justify-between">
                  <span className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-2xl [&_svg]:size-5 [&_svg]:stroke-[1.75]">
                    <Package />
                  </span>
                  <Badge variant={disabled ? "outline" : "default"}>{max} шт</Badge>
                </div>
                <div>
                  <span className="block text-sm font-semibold">{p.name}</span>
                  <span className="text-muted-foreground block text-xs">{p.sku}</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

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
