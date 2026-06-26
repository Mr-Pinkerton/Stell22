"use client";

import { useState } from "react";
import { toast } from "@/components/terminal/toast";
import { Drill } from "lucide-react";
import { OperationTile, OperationTileRow } from "@/components/terminal/operation-tile";
import { QuantityDialog } from "@/components/terminal/quantity-dialog";
import type { Detail } from "@/types/domain";
import type { TerminalData } from "@/components/terminal/types";

interface PrisadkaScreenProps {
  data: TerminalData;
  onDone: () => void;
}

type PrisadkaKind = "torcev" | "plosk";

interface Tile {
  detail: Detail;
  kind: PrisadkaKind;
  label: string;
  pending: number;
  done: number;
  total: number;
}

const KIND_LABEL: Record<PrisadkaKind, string> = {
  torcev: "торцевая",
  plosk: "по плоскости",
};

function buildTiles(data: TerminalData): Tile[] {
  const tiles: Tile[] = [];
  for (const d of data.details) {
    if (d.status !== "ACTIVE") continue;
    const required: PrisadkaKind[] = [];
    if (d.prisadkaTorcevaya) required.push("torcev");
    if (d.prisadkaPloskost) required.push("plosk");
    if (required.length === 0) continue;

    const pendingMap = data.stock.prisadkaPending[d.id] ?? { torcev: 0, plosk: 0 };
    const done = required.filter((k) => pendingMap[k] === 0).length;

    for (const kind of required) {
      const pending = pendingMap[kind];
      if (pending <= 0) continue;
      tiles.push({
        detail: d,
        kind,
        label: `${d.name} — ${KIND_LABEL[kind]}`,
        pending,
        done,
        total: required.length,
      });
    }
  }
  return tiles;
}

export function PrisadkaScreen({ data, onDone }: PrisadkaScreenProps) {
  const tiles = buildTiles(data);
  const [dialog, setDialog] = useState<Tile | null>(null);

  return (
    <main className="flex flex-1 flex-col gap-5 p-6">
      <h2 className="text-muted-foreground text-sm font-semibold tracking-wide uppercase">
        Требуют присадки
      </h2>

      {tiles.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
          Нет деталей, ожидающих присадки
        </div>
      ) : (
        <OperationTileRow>
          {tiles.map((t) => (
            <OperationTile
              key={`${t.detail.id}-${t.kind}`}
              icon={<Drill />}
              title={t.label}
              subtitle={`ожидает: ${t.pending} шт`}
              badge={`${t.done} из ${t.total}`}
              onClick={() => setDialog(t)}
            />
          ))}
        </OperationTileRow>
      )}

      <QuantityDialog
        open={dialog != null}
        title={dialog?.label ?? ""}
        hint={dialog ? `Ожидает присадки: ${dialog.pending} шт` : ""}
        max={dialog?.pending}
        onConfirm={(v) => {
          toast.success(`Присадка внесена: ${v} шт`);
          setDialog(null);
          onDone();
        }}
        onClose={() => setDialog(null)}
      />
    </main>
  );
}
