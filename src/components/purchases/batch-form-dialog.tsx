"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { sectionAreaM2, resolveRailQuantity } from "@/lib/batch-stats";
import type { PurchaseBatchRow } from "@/lib/batch-stats";
import { formatLength, formatMoney, formatVolume } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { RailType, Sort } from "@/types/domain";

const fieldClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring focus-visible:bg-card h-10 rounded-xl border px-4";

const narrowFieldClass = cn(fieldClass, "w-full sm:max-w-none");

const selectTriggerClass = cn(
  fieldClass,
  "w-full cursor-pointer pr-8 pl-4 data-[size=default]:h-10",
);

const selectContentClass = "rounded-xl shadow-balanced ring-0 p-1.5";

const formSelectContentProps = {
  className: selectContentClass,
  side: "bottom" as const,
  sideOffset: 8,
  alignItemWithTrigger: false,
};

const RAIL_TYPE_LABEL: Record<RailType, string> = {
  POLKA: "Полка",
  KANAVKA: "Канавка",
};

const SORT_LABEL: Record<Sort, string> = {
  SORT1: "Сорт 1",
  SORT2: "Сорт 2",
};

type PurchaseKind = "batch" | "simple";
type RailAddMode = "package" | "piece";

interface DraftRailEntry {
  id: string;
  mode: RailAddMode;
  lengthM: number;
  railType: RailType;
  sort: Sort;
  quantity: number;
  rows?: number;
  layers?: number;
  code?: string;
}

interface BatchFormDialogProps {
  open: boolean;
  batch?: PurchaseBatchRow | null;
  onOpenChange: (open: boolean) => void;
  onSubmit?: () => void;
}

function Field({
  id,
  label,
  required,
  className,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
    </div>
  );
}

function RailTypeSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: RailType;
  onChange: (value: RailType) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as RailType)}>
      <SelectTrigger id={id} className={selectTriggerClass}>
        <SelectValue>{RAIL_TYPE_LABEL[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent {...formSelectContentProps}>
        <SelectItem value="POLKA" className="cursor-pointer rounded-lg">
          {RAIL_TYPE_LABEL.POLKA}
        </SelectItem>
        <SelectItem value="KANAVKA" className="cursor-pointer rounded-lg">
          {RAIL_TYPE_LABEL.KANAVKA}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function SortSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: Sort;
  onChange: (value: Sort) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Sort)}>
      <SelectTrigger id={id} className={selectTriggerClass}>
        <SelectValue>{SORT_LABEL[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent {...formSelectContentProps}>
        <SelectItem value="SORT1" className="cursor-pointer rounded-lg">
          {SORT_LABEL.SORT1}
        </SelectItem>
        <SelectItem value="SORT2" className="cursor-pointer rounded-lg">
          {SORT_LABEL.SORT2}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function BatchFormBody({
  batch,
  onSubmit,
  onClose,
}: {
  batch?: PurchaseBatchRow | null;
  onSubmit?: () => void;
  onClose: () => void;
}) {
  const isEdit = Boolean(batch);
  const [kind, setKind] = useState<PurchaseKind>("batch");
  const [addMode, setAddMode] = useState<RailAddMode>("package");
  const [entries, setEntries] = useState<DraftRailEntry[]>([]);

  const [sectionW, setSectionW] = useState(String(batch?.sectionWidthMm ?? ""));
  const [sectionH, setSectionH] = useState(String(batch?.sectionHeightMm ?? ""));

  const [draftLength, setDraftLength] = useState("");
  const [draftType, setDraftType] = useState<RailType>("POLKA");
  const [draftSort, setDraftSort] = useState<Sort>("SORT1");
  const [draftQty, setDraftQty] = useState("");
  const [draftRows, setDraftRows] = useState("");
  const [draftLayers, setDraftLayers] = useState("");

  const wMm = Number(sectionW) || 0;
  const hMm = Number(sectionH) || 0;
  const area = wMm > 0 && hMm > 0 ? sectionAreaM2(wMm, hMm) : 0;

  const stats = useMemo(() => {
    let railCount = 0;
    let totalLengthM = 0;
    let volumeM3 = 0;
    let sort1Vol = 0;
    let sort2Vol = 0;

    for (const e of entries) {
      const vol = e.quantity * area * e.lengthM;
      railCount += e.quantity;
      totalLengthM += e.quantity * e.lengthM;
      volumeM3 += vol;
      if (e.sort === "SORT1") sort1Vol += vol;
      else sort2Vol += vol;
    }

    const totalVol = sort1Vol + sort2Vol;
    const sort1Pct = totalVol > 0 ? Math.round((sort1Vol / totalVol) * 100) : 0;
    const sort2Pct = totalVol > 0 ? 100 - sort1Pct : 0;

    return { railCount, totalLengthM, volumeM3, packageCount: entries.filter((e) => e.mode === "package").length, sort1Pct, sort2Pct };
  }, [entries, area]);

  const draftRowsNum = Number(draftRows) || 0;
  const draftLayersNum = Number(draftLayers) || 0;
  const computedFromGrid =
    draftRowsNum > 0 && draftLayersNum > 0 ? draftRowsNum * draftLayersNum : null;

  const resolvedDraftQty = resolveRailQuantity({
    quantity: Number(draftQty) || null,
    rows: draftRowsNum || null,
    layers: draftLayersNum || null,
  });

  const canAddRail = (() => {
    const len = Number(draftLength);
    if (!len || len <= 0) return false;
    return resolvedDraftQty !== null;
  })();

  const addRail = () => {
    if (!canAddRail || resolvedDraftQty === null) return;
    const len = Number(draftLength);
    const qty = resolvedDraftQty;
    const rowsNum = draftRowsNum > 0 ? draftRowsNum : undefined;
    const layersNum = draftLayersNum > 0 ? draftLayersNum : undefined;

    setEntries((prev) => [
      ...prev,
      {
        id: `draft-${Date.now()}`,
        mode: addMode,
        lengthM: len,
        railType: draftType,
        sort: draftSort,
        quantity: qty,
        rows: addMode === "package" && rowsNum && layersNum ? rowsNum : undefined,
        layers: addMode === "package" && rowsNum && layersNum ? layersNum : undefined,
        code: addMode === "package" ? `PKG-${String(prev.length + 1).padStart(4, "0")}` : undefined,
      },
    ]);

    setDraftLength("");
    setDraftQty("");
    setDraftRows("");
    setDraftLayers("");
  };

  const removeEntry = (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const handleSubmit = () => {
    onSubmit?.();
    onClose();
  };

  return (
    <>
      <div className="border-border flex items-center gap-4 border-b px-6 py-4">
        <DialogTitle className="min-w-0 flex-1 text-lg leading-tight font-semibold">
          {isEdit ? "Изменить партию" : "Добавить закупку"}
        </DialogTitle>
        <DialogClose
          render={
            <Button
              type="button"
              variant="ghost"
              className="icon-action-btn icon-action-btn--compact size-[2.4rem] shrink-0 rounded-xl"
              aria-label="Закрыть"
            />
          }
        >
          <XIcon className="size-[1.4rem]" />
        </DialogClose>
      </div>

      <div className="scrollbar-thin-y max-h-[min(80vh,40rem)] space-y-5 overflow-y-auto px-6 py-6">
        <div
          className="bg-muted inline-flex gap-1 rounded-2xl p-1"
          role="tablist"
          aria-label="Тип закупки"
        >
          {(
            [
              ["batch", "Партия рейки"],
              ["simple", "Простая закупка"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={kind === value}
              onClick={() => setKind(value)}
              className={cn(
                "h-10 cursor-pointer rounded-xl px-4 text-sm font-semibold transition-colors",
                kind === value
                  ? "bg-card text-foreground shadow-soft"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {kind === "simple" ? (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm">
              Крепёж, упаковка и прочее — приход на склад без реек и пакетов.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="simple-name" label="Наименование" required className="sm:col-span-2">
                <Input id="simple-name" className={fieldClass} placeholder="Из номенклатуры" />
              </Field>
              <Field id="simple-qty" label="Количество" required>
                <Input id="simple-qty" className={narrowFieldClass} placeholder="шт" inputMode="decimal" />
              </Field>
              <Field id="simple-price" label="Цена за единицу" required>
                <MoneyInput id="simple-price" className={narrowFieldClass} />
              </Field>
            </div>
          </div>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              Информация о закупке. Заполните поля, отмеченные <span className="text-destructive">*</span>.
            </p>

            <section className="space-y-4">
              <h3 className="text-sm font-semibold">Основная информация</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="batch-name" label="Название партии" required className="sm:col-span-2">
                  <Input
                    id="batch-name"
                    className={fieldClass}
                    placeholder="Волочек 2419"
                    defaultValue={batch?.name ?? ""}
                  />
                </Field>
                <Field id="batch-sw" label="Сечение — ширина, мм" required>
                  <Input
                    id="batch-sw"
                    className={narrowFieldClass}
                    inputMode="decimal"
                    value={sectionW}
                    onChange={(e) => setSectionW(e.target.value)}
                  />
                </Field>
                <Field id="batch-sh" label="Сечение — высота, мм" required>
                  <Input
                    id="batch-sh"
                    className={narrowFieldClass}
                    inputMode="decimal"
                    value={sectionH}
                    onChange={(e) => setSectionH(e.target.value)}
                  />
                </Field>
              </div>
            </section>

            <Separator />

            <section className="border-border bg-muted space-y-4 rounded-2xl border p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Добавить рейку</h3>
                <div
                  className="bg-card/70 inline-flex shrink-0 gap-1 rounded-xl p-1 shadow-soft"
                  role="tablist"
                  aria-label="Способ добавления"
                >
                  {(
                    [
                      ["package", "Пакетами"],
                      ["piece", "Поштучно"],
                    ] as const
                  ).map(([value, label]) => {
                    const active = addMode === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setAddMode(value)}
                        className={cn(
                          "h-9 cursor-pointer rounded-lg px-4 text-sm font-semibold transition-colors",
                          active
                            ? "bg-card text-foreground shadow-soft"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field id="rail-len" label="Длина рейки, м" required>
                  <Input
                    id="rail-len"
                    className={narrowFieldClass}
                    inputMode="decimal"
                    placeholder="2,4"
                    value={draftLength}
                    onChange={(e) => setDraftLength(e.target.value)}
                  />
                </Field>
                <Field id="rail-type" label="Тип рейки" required>
                  <RailTypeSelect id="rail-type" value={draftType} onChange={setDraftType} />
                </Field>
                <Field id="rail-sort" label="Сорт" required>
                  <SortSelect id="rail-sort" value={draftSort} onChange={setDraftSort} />
                </Field>
              </div>

              {addMode === "piece" ? (
                <>
                  <Field id="rail-qty" label="Количество реек" required className="max-w-xs">
                    <Input
                      id="rail-qty"
                      className={narrowFieldClass}
                      inputMode="numeric"
                      value={draftQty}
                      onChange={(e) => setDraftQty(e.target.value)}
                    />
                  </Field>
                  <p className="text-muted-foreground text-xs">
                    Рейки с одинаковой длиной, типом и сортом автоматически суммируются.
                  </p>
                </>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <Field id="rail-qty-pkg" label="Количество реек" required>
                      <Input
                        id="rail-qty-pkg"
                        className={narrowFieldClass}
                        inputMode="numeric"
                        value={computedFromGrid !== null ? String(computedFromGrid) : draftQty}
                        readOnly={computedFromGrid !== null}
                        onChange={(e) => {
                          setDraftQty(e.target.value);
                          if (e.target.value) {
                            setDraftRows("");
                            setDraftLayers("");
                          }
                        }}
                      />
                    </Field>
                    <Field id="rail-rows" label="Рядов">
                      <Input
                        id="rail-rows"
                        className={narrowFieldClass}
                        inputMode="numeric"
                        value={draftRows}
                        onChange={(e) => setDraftRows(e.target.value)}
                      />
                    </Field>
                    <Field id="rail-layers" label="Слоёв">
                      <Input
                        id="rail-layers"
                        className={narrowFieldClass}
                        inputMode="numeric"
                        value={draftLayers}
                        onChange={(e) => setDraftLayers(e.target.value)}
                      />
                    </Field>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Ряды и слои необязательны. Если указаны оба — количество считается как ряды ×
                    слои.
                  </p>
                </div>
              )}

              <Button
                type="button"
                variant="brand"
                className="h-10 cursor-pointer rounded-xl"
                disabled={!canAddRail}
                onClick={addRail}
              >
                <Plus />
                Добавить
              </Button>

              {entries.length > 0 && (
                <div className="space-y-2">
                  {entries.map((e) => (
                    <div
                      key={e.id}
                      className="border-border bg-card flex items-center gap-3 rounded-xl border px-3 py-2 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">
                          {e.code ? `${e.code} · ` : ""}
                          {formatLength(e.lengthM)} · {RAIL_TYPE_LABEL[e.railType]} · {SORT_LABEL[e.sort]}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {e.rows && e.layers ? `${e.rows}×${e.layers} · ` : ""}
                          {e.quantity} шт · {formatLength(e.quantity * e.lengthM)} ·{" "}
                          {formatVolume(e.quantity * area * e.lengthM)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive size-8 cursor-pointer rounded-lg"
                        aria-label="Удалить"
                        onClick={() => removeEntry(e.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {entries.length > 0 && (
                <div className="border-border bg-card grid gap-3 rounded-xl border p-4 sm:grid-cols-2">
                  <div>
                    <p className="text-muted-foreground text-xs">Всего реек</p>
                    <p className="text-lg font-semibold tabular-nums">{stats.railCount} шт</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Пакетов</p>
                    <p className="text-lg font-semibold tabular-nums">{stats.packageCount}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Общая длина</p>
                    <p className="text-lg font-semibold tabular-nums">{formatLength(stats.totalLengthM)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs">Объём</p>
                    <p className="text-lg font-semibold tabular-nums">{formatVolume(stats.volumeM3)}</p>
                  </div>
                  {stats.volumeM3 > 0 && (
                    <div className="sm:col-span-2">
                      <p className="text-muted-foreground mb-2 text-xs">Соотношение сортов</p>
                      <div className="flex h-2 overflow-hidden rounded-full">
                        <div className="bg-brand" style={{ width: `${stats.sort1Pct}%` }} />
                        <div className="bg-muted-foreground/30" style={{ width: `${stats.sort2Pct}%` }} />
                      </div>
                      <p className="text-muted-foreground mt-1 text-xs">
                        Сорт 1 — {stats.sort1Pct}% · Сорт 2 — {stats.sort2Pct}%
                      </p>
                    </div>
                  )}
                </div>
              )}
            </section>

            <Separator />

            <section className="space-y-4">
              <h3 className="text-sm font-semibold">Финансовые данные</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field id="batch-cost" label="Стоимость партии" required>
                  <MoneyInput
                    id="batch-cost"
                    className={narrowFieldClass}
                    defaultValue={batch?.purchaseCost ?? null}
                  />
                </Field>
                <Field id="batch-p1" label="Цена 1 сорт, ₽/м³">
                  <MoneyInput
                    id="batch-p1"
                    className={narrowFieldClass}
                    suffix="₽/м³"
                    defaultValue={batch?.priceSort1 ?? null}
                  />
                </Field>
                <Field id="batch-p2" label="Цена 2 сорт, ₽/м³">
                  <MoneyInput
                    id="batch-p2"
                    className={narrowFieldClass}
                    suffix="₽/м³"
                    defaultValue={batch?.priceSort2 ?? null}
                  />
                </Field>
              </div>
              <p className="text-muted-foreground rounded-xl bg-tag-blue-bg/40 px-3 py-2 text-xs leading-relaxed">
                Данные о доставке и сопутствующих расходах можно добавить в Сделках.
                {batch && batch.totalCost > batch.purchaseCost && (
                  <span className="text-foreground mt-1 block font-medium">
                    Общая стоимость с доставкой: {formatMoney(batch.totalCost)}
                  </span>
                )}
              </p>
            </section>

            <Field id="batch-note" label="Примечание" className="sm:col-span-2">
              <Input
                id="batch-note"
                className={fieldClass}
                placeholder="Необязательно"
                defaultValue={batch?.note ?? ""}
              />
            </Field>
          </>
        )}
      </div>

      <DialogFooter className="bg-muted/50 border-border !m-0 gap-2 border-t px-6 py-4 sm:flex-row sm:justify-end">
        <Button variant="outline" className="h-10 cursor-pointer rounded-xl px-5" onClick={onClose}>
          Отмена
        </Button>
        <Button className="h-10 cursor-pointer rounded-xl px-5" onClick={handleSubmit}>
          {kind === "simple"
            ? "Добавить закупку"
            : isEdit
              ? "Сохранить партию"
              : "Добавить партию"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function BatchFormDialog({ open, batch, onOpenChange, onSubmit }: BatchFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        {open ? (
          <BatchFormBody
            key={batch?.id ?? "new"}
            batch={batch}
            onSubmit={onSubmit}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
