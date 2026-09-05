"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/terminal/toast";
import { Drill } from "lucide-react";
import { OperationTile, OperationTileGrid } from "@/components/terminal/operation-tile";
import { QuantityDialog } from "@/components/terminal/quantity-dialog";
import { TerminalConfirmBar } from "@/components/terminal/terminal-confirm-bar";
import { useTerminalDraft } from "@/components/terminal/use-terminal-draft";
import { submitPrisadka } from "@/server/terminal";
import { sectionLabel } from "@/lib/material";
import type {
  TerminalData,
  TerminalDetail,
  TerminalEmployee,
} from "@/components/terminal/types";

interface PrisadkaScreenProps {
  data: TerminalData;
  employee: TerminalEmployee;
  onDone: () => void;
}

type PrisadkaKind = "torcev" | "plosk";

interface Tile {
  detail: TerminalDetail;
  kind: PrisadkaKind;
  label: string;
  pending: number;
  done: number;
  total: number;
  orphan?: boolean;
}

const KIND_LABEL: Record<PrisadkaKind, string> = {
  torcev: "торцевая",
  plosk: "по плоскости",
};

function tileKey(detailId: string, kind: PrisadkaKind): string {
  return `${detailId}-${kind}`;
}

function parseTileKey(key: string): { detailId: string; kind: PrisadkaKind } | null {
  if (key.endsWith("-torcev")) return { detailId: key.slice(0, -"-torcev".length), kind: "torcev" };
  if (key.endsWith("-plosk")) return { detailId: key.slice(0, -"-plosk".length), kind: "plosk" };
  return null;
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
  const {
    draft: storedDraft,
    clientRequestId,
    save: saveDraft,
    clear: clearDraft,
  } = useTerminalDraft({ employeeId: employee.id });
  const liveTiles = useMemo(() => buildTiles(data), [data]);
  const materialById = useMemo(
    () => new Map(data.materials.map((m) => [m.id, m])),
    [data.materials],
  );
  const detailById = useMemo(
    () => new Map(data.details.map((d) => [d.id, d])),
    [data.details],
  );
  const [picked, setPicked] = useState<Record<string, number>>(() => {
    if (storedDraft?.operationType !== "PRISADKA") return {};
    const next: Record<string, number> = {};
    for (const p of storedDraft.payload.picks) {
      if (p.quantity > 0) next[tileKey(p.detailId, p.kind)] = p.quantity;
    }
    return next;
  });
  const [dialogTile, setDialogTile] = useState<Tile | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const tiles = useMemo(() => {
    const seen = new Set(liveTiles.map((t) => tileKey(t.detail.id, t.kind)));
    const extra: Tile[] = [];
    for (const [key, qty] of Object.entries(picked)) {
      if (qty <= 0 || seen.has(key)) continue;
      const parsed = parseTileKey(key);
      if (!parsed) continue;
      const detail = detailById.get(parsed.detailId);
      extra.push({
        detail: detail ?? {
          id: parsed.detailId,
          name: "Деталь недоступна",
          materialId: "",
          detailNumber: 0,
          lengthM: 0,
          detailType: "POLKA",
          sort: "SORT1",
          prisadkaTorcevaya: parsed.kind === "torcev",
          prisadkaPloskost: parsed.kind === "plosk",
          status: "ARCHIVED",
        },
        kind: parsed.kind,
        label: `${detail?.name ?? "Деталь недоступна"} — ${KIND_LABEL[parsed.kind]}`,
        pending: 0,
        done: 0,
        total: 1,
        orphan: true,
      });
    }
    return [...liveTiles, ...extra];
  }, [liveTiles, picked, detailById]);

  const pickedCount = Object.values(picked).reduce((a, b) => a + b, 0);
  const pickedLines = Object.keys(picked).filter((k) => (picked[k] ?? 0) > 0).length;
  const stockWarnings: string[] = [];
  for (const [key, qty] of Object.entries(picked)) {
    if (qty <= 0) continue;
    const parsed = parseTileKey(key);
    if (!parsed) continue;
    const live = liveTiles.find((t) => t.detail.id === parsed.detailId && t.kind === parsed.kind);
    if (!live) {
      stockWarnings.push("Часть выбранных деталей больше не ожидает присадку — сервер решит, можно ли повторить операцию.");
      break;
    }
    if (qty > live.pending) {
      stockWarnings.push("Количество больше текущего ожидания присадки — если операция уже прошла, повтор будет идемпотентным.");
      break;
    }
  }

  useEffect(() => {
    const picks = Object.entries(picked).flatMap(([key, quantity]) => {
      const parsed = parseTileKey(key);
      if (!parsed || quantity <= 0) return [];
      return [{ detailId: parsed.detailId, kind: parsed.kind, quantity }];
    });
    saveDraft({ operationType: "PRISADKA", payload: { picks } });
  }, [picked, saveDraft]);

  const confirm = async () => {
    if (pickedCount === 0 || submitting) return;
    const picks = Object.entries(picked).flatMap(([key, quantity]) => {
      const parsed = parseTileKey(key);
      if (!parsed || quantity <= 0) return [];
      return [{ detailId: parsed.detailId, kind: parsed.kind, quantity }];
    });
    setSubmitting(true);
    try {
      await submitPrisadka({
        employeeId: employee.id,
        clientRequestId,
        picks,
      });
      toast.success(`Присадка внесена: ${pickedCount} шт`);
      clearDraft();
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

      {tiles.length === 0 && pickedCount === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
          Нет деталей, ожидающих присадки
        </div>
      ) : (
        <>
          <OperationTileGrid>
            {tiles.map((t) => {
              const key = tileKey(t.detail.id, t.kind);
              const qty = picked[key] ?? 0;
              const material = materialById.get(t.detail.materialId);
              return (
                <OperationTile
                  key={key}
                  layout="grid"
                  active={qty > 0}
                  icon={<Drill />}
                  title={t.detail.name}
                  numberBadge={t.detail.detailNumber}
                  material={material ? { name: material.name, section: sectionLabel(material) } : undefined}
                  titleNote={t.detail.sort === "SORT1" ? "1 сорт" : "2 сорт"}
                  subtitle={
                    t.orphan
                      ? `${KIND_LABEL[t.kind]} · нет в текущей очереди`
                      : `${KIND_LABEL[t.kind]} · ожидает ${t.pending} шт · ${t.done} из ${t.total}`
                  }
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

          {stockWarnings.length > 0 && (
            <p className="text-amber-800 text-sm leading-relaxed">{stockWarnings[0]}</p>
          )}

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
        initial={dialogTile ? (picked[tileKey(dialogTile.detail.id, dialogTile.kind)] ?? 0) : 0}
        max={
          dialogTile
            ? Math.max(
                dialogTile.orphan ? 0 : dialogTile.pending,
                picked[tileKey(dialogTile.detail.id, dialogTile.kind)] ?? 0,
              ) || undefined
            : undefined
        }
        onConfirm={(v) => {
          if (dialogTile) {
            setPicked((p) => ({ ...p, [tileKey(dialogTile.detail.id, dialogTile.kind)]: v }));
          }
          setDialogTile(null);
        }}
        onClose={() => setDialogTile(null)}
      />
    </main>
  );
}
