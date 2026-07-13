"use client";

import { useMemo, useRef, useState } from "react";
import { newRequestId } from "@/lib/request-id";
import { toast } from "@/components/terminal/toast";
import { Drill } from "lucide-react";
import { OperationTile, OperationTileGrid } from "@/components/terminal/operation-tile";
import { QuantityDialog } from "@/components/terminal/quantity-dialog";
import { TerminalConfirmBar } from "@/components/terminal/terminal-confirm-bar";
import { submitPrisadka } from "@/server/terminal";
import type { Detail, Employee } from "@/types/domain";
import type { TerminalData } from "@/components/terminal/types";

interface PrisadkaScreenProps {
  data: TerminalData;
  employee: Employee;
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

function tileKey(t: Tile): string {
  return `${t.detail.id}-${t.kind}`;
}

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

export function PrisadkaScreen({ data, employee, onDone }: PrisadkaScreenProps) {
  const tiles = useMemo(() => buildTiles(data), [data]);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [dialogTile, setDialogTile] = useState<Tile | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const requestId = useRef(newRequestId()); // ключ идемпотентности (A21)

  const pickedCount = Object.values(picked).reduce((a, b) => a + b, 0);
  const pickedLines = Object.keys(picked).filter((k) => (picked[k] ?? 0) > 0).length;

  const confirm = async () => {
    if (pickedCount === 0 || submitting) return;
    const picks = tiles
      .map((t) => ({ detailId: t.detail.id, kind: t.kind, quantity: picked[tileKey(t)] ?? 0 }))
      .filter((p) => p.quantity > 0);
    setSubmitting(true);
    try {
      await submitPrisadka({ employeeId: employee.id, clientRequestId: requestId.current, picks });
      toast.success(`Присадка внесена: ${pickedCount} шт`);
      requestId.current = newRequestId();
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
      setSubmitting(false);
    }
  };

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
        <>
          <OperationTileGrid>
            {tiles.map((t) => {
              const key = tileKey(t);
              const qty = picked[key] ?? 0;
              return (
                <OperationTile
                  key={key}
                  layout="grid"
                  active={qty > 0}
                  icon={<Drill />}
                  title={t.detail.name}
                  numberBadge={t.detail.detailNumber}
                  titleNote={t.detail.sort === "SORT1" ? "1 сорт" : "2 сорт"}
                  subtitle={`${KIND_LABEL[t.kind]} · ожидает ${t.pending} шт · ${t.done} из ${t.total}`}
                  highlight={qty > 0 ? { value: qty, label: "шт" } : undefined}
                  badge={qty === 0 ? `${t.pending} шт` : undefined}
                  onClick={() => setDialogTile(t)}
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
          </OperationTileGrid>

          <TerminalConfirmBar
            summary={
              <>
                <span className="font-medium">{pickedCount} шт</span>
                <span className="text-muted-foreground ml-3">
                  {pickedLines > 0 ? `${pickedLines} поз.` : "выберите детали"}
                </span>
              </>
            }
            disabled={pickedCount === 0 || submitting}
            onConfirm={confirm}
          />
        </>
      )}

      <QuantityDialog
        open={dialogTile != null}
        title={dialogTile?.label ?? ""}
        hint={dialogTile ? `Ожидает присадки: ${dialogTile.pending} шт` : ""}
        initial={dialogTile ? (picked[tileKey(dialogTile)] ?? 0) : 0}
        max={dialogTile?.pending}
        onConfirm={(v) => {
          if (dialogTile) {
            setPicked((p) => ({ ...p, [tileKey(dialogTile)]: v }));
          }
          setDialogTile(null);
        }}
        onClose={() => setDialogTile(null)}
      />
    </main>
  );
}
