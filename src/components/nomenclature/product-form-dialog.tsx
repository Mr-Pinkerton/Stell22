"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2, XIcon } from "lucide-react";
import { capitalizeFirst, cn } from "@/lib/utils";
import { formatMoneyDecimal } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FormSubmitButton } from "@/components/form-dialog-shared";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { Detail, Material, NomenclatureItem, Product, Sort } from "@/types/domain";
import type { ProductFormValues } from "@/server/nomenclature";
import {
  Field,
  FormSection,
  SORT_LABEL,
  fieldClass,
  formAddButtonClass,
  formSelectContentProps,
  selectTriggerClass,
} from "./form-shared";

interface DraftFastener {
  id: string;
  nomenclatureId: string;
  quantity: number;
}

interface DraftProductDetail {
  id: string;
  detailId: string;
  quantity: number;
}

interface ProductFormDialogProps {
  open: boolean;
  product?: Product | null;
  /** Активные детали из БД (для выбора состава). */
  details: Detail[];
  /** Позиции номенклатуры (крепёж/упаковка/разное) из БД. */
  items: NomenclatureItem[];
  /** Материалы (порода) — изделие однородно по материалу. */
  materials: Material[];
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: ProductFormValues) => void | Promise<void>;
  pending?: boolean;
}

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function ProductFormDialog(props: ProductFormDialogProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        {open ? <ProductFormBody {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ProductFormBody({
  product,
  details: allDetails,
  items,
  materials,
  onOpenChange,
  onSubmit,
  pending,
}: ProductFormDialogProps) {
  const isEdit = Boolean(product);
  const fasteners = useMemo(() => items.filter((n) => n.type === "FASTENER"), [items]);
  const packagingItems = useMemo(() => items.filter((n) => n.type === "PACKAGING"), [items]);
  const otherItems = useMemo(() => items.filter((n) => n.type === "OTHER"), [items]);
  const activeMaterials = useMemo(
    () => materials.filter((m) => m.status === "ACTIVE" || m.id === product?.materialId),
    [materials, product?.materialId],
  );

  const [materialId, setMaterialId] = useState(product?.materialId ?? activeMaterials[0]?.id ?? "");
  const [name, setName] = useState(product?.name ?? "");
  const [skuOzon, setSkuOzon] = useState(product?.skuOzon ?? "");
  const [skuWb, setSkuWb] = useState(product?.skuWb ?? "");
  const [sort, setSort] = useState<Sort | "">(product?.sort ?? "");
  const [packagingId, setPackagingId] = useState(product?.packagingId ?? "");
  const [fastenerRows, setFastenerRows] = useState<DraftFastener[]>(
    () =>
      product?.fastenerIds.map((f) => ({
        id: nextId("f"),
        nomenclatureId: f.nomenclatureId,
        quantity: f.quantity,
      })) ?? [],
  );
  const [detailRows, setDetailRows] = useState<DraftProductDetail[]>(
    () =>
      product?.details.map((d) => ({
        id: nextId("d"),
        detailId: d.detailId,
        quantity: d.quantity,
      })) ?? [],
  );
  const [extraIds, setExtraIds] = useState<Set<string>>(
    () => new Set(product?.extraIds ?? []),
  );
  const [draftDetailId, setDraftDetailId] = useState("");
  const [draftDetailQty, setDraftDetailQty] = useState("1");
  const [showErrors, setShowErrors] = useState(false);

  // Состав изделия — только детали выбранного материала и сорта (номера
  // повторяются между материалами, поэтому фильтруем строго по materialId).
  const sortDetails = useMemo(
    () =>
      sort && materialId
        ? allDetails.filter(
            (d) => d.sort === sort && d.materialId === materialId && d.status === "ACTIVE",
          )
        : [],
    [sort, materialId, allDetails],
  );

  const detailById = useMemo(
    () => new Map(allDetails.map((d) => [d.id, d])),
    [allDetails],
  );

  const addFastenerRow = () => {
    const first = fasteners[0];
    if (!first) return;
    setFastenerRows((rows) => [
      ...rows,
      { id: nextId("f"), nomenclatureId: first.id, quantity: 1 },
    ]);
  };

  const addDetailRow = () => {
    if (!sort || !draftDetailId) return;
    const qty = Math.max(1, parseInt(draftDetailQty, 10) || 1);
    // Одна деталь входит одной строкой (номер — свойство самой детали).
    if (detailRows.some((r) => r.detailId === draftDetailId)) return;
    setDetailRows((rows) => [
      ...rows,
      { id: nextId("d"), detailId: draftDetailId, quantity: qty },
    ]);
    setDraftDetailId("");
    setDraftDetailQty("1");
  };

  const toggleExtra = (id: string, checked: boolean) => {
    setExtraIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const canSubmit =
    name.trim().length > 0 &&
    materialId.length > 0 &&
    skuOzon.trim().length > 0 &&
    skuWb.trim().length > 0 &&
    sort !== "" &&
    !pending;

  const handleSubmit = async () => {
    // Проверяем sort первым — это сужает тип до Sort. Кнопка и так disabled при !canSubmit.
    if (sort === "" || !canSubmit) return;
    await onSubmit?.({
      name,
      materialId,
      skuOzon,
      skuWb,
      sort,
      packagingId: packagingId || null,
      details: detailRows.map((r) => ({
        detailId: r.detailId,
        quantity: r.quantity,
      })),
      fasteners: fastenerRows.map((r) => ({
        nomenclatureId: r.nomenclatureId,
        quantity: r.quantity,
      })),
      extraIds: Array.from(extraIds),
    });
  };

  return (
    <>
            <div className="border-border flex items-center gap-4 border-b px-6 py-4">
              <DialogTitle className="min-w-0 flex-1 text-lg leading-tight font-semibold">
                {isEdit ? "Изменить изделие" : "Создание изделия"}
              </DialogTitle>
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    className="icon-action-btn size-[2.4rem] shrink-0 rounded-xl"
                    aria-label="Закрыть"
                  />
                }
              >
                <XIcon className="size-[1.4rem]" />
              </DialogClose>
            </div>

            <div className="scrollbar-thin-y max-h-[min(75vh,40rem)] space-y-5 overflow-y-auto px-6 py-6">
              <FormSection title="Основная информация">
                <Field
                  id="prod-name"
                  label="Название"
                  required
                  invalid={showErrors && !name.trim()}
                >
                  <Input
                    id="prod-name"
                    className={fieldClass}
                    autoCapitalize="sentences"
                    placeholder="Полка настенная"
                    value={name}
                    onChange={(e) => setName(capitalizeFirst(e.target.value))}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    id="prod-sku-ozon"
                    label="Артикул Ozon"
                    required
                    invalid={showErrors && !skuOzon.trim()}
                  >
                    <Input
                      id="prod-sku-ozon"
                      className={fieldClass}
                      placeholder="OZ-001"
                      value={skuOzon}
                      onChange={(e) => setSkuOzon(e.target.value)}
                    />
                  </Field>
                  <Field
                    id="prod-sku-wb"
                    label="Артикул WB"
                    required
                    invalid={showErrors && !skuWb.trim()}
                  >
                    <Input
                      id="prod-sku-wb"
                      className={fieldClass}
                      placeholder="WB-001"
                      value={skuWb}
                      onChange={(e) => setSkuWb(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    id="prod-material"
                    label="Материал"
                    required
                    invalid={showErrors && !materialId}
                  >
                    <Select
                      value={materialId}
                      onValueChange={(v) => {
                        setMaterialId(v ?? "");
                        // Детали привязаны к материалу — сбрасываем состав.
                        setDetailRows([]);
                        setDraftDetailId("");
                      }}
                    >
                      <SelectTrigger id="prod-material" className={selectTriggerClass}>
                        <SelectValue placeholder="Выберите материал">
                          {activeMaterials.find((m) => m.id === materialId)?.name}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent {...formSelectContentProps}>
                        {activeMaterials.map((m) => (
                          <SelectItem key={m.id} value={m.id} className="cursor-pointer rounded-lg">
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field
                    id="prod-sort"
                    label="Сорт"
                    required
                    invalid={showErrors && sort === ""}
                  >
                    <Select
                      value={sort}
                      onValueChange={(v) => setSort(v as Sort)}
                    >
                      <SelectTrigger id="prod-sort" className={selectTriggerClass}>
                        <SelectValue placeholder="Выберите сорт">
                          {sort ? SORT_LABEL[sort] : "Выберите сорт"}
                        </SelectValue>
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
                  </Field>
                </div>
              </FormSection>

              <Separator />

              <FormSection title="Крепёж">
                <div className="space-y-3">
                  {fastenerRows.map((row) => (
                    <div key={row.id} className="flex flex-wrap items-end gap-2">
                      <Field id={`fast-${row.id}`} label="Позиция" className="min-w-[12rem] flex-1">
                        <Select
                          value={row.nomenclatureId}
                          onValueChange={(v) =>
                            setFastenerRows((rows) =>
                              rows.map((r) =>
                                r.id === row.id ? { ...r, nomenclatureId: v ?? r.nomenclatureId } : r,
                              ),
                            )
                          }
                        >
                          <SelectTrigger id={`fast-${row.id}`} className={selectTriggerClass}>
                            <SelectValue>
                              {fasteners.find((f) => f.id === row.nomenclatureId)?.name ?? "—"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent {...formSelectContentProps}>
                            {fasteners.map((f) => (
                              <SelectItem
                                key={f.id}
                                value={f.id}
                                className="cursor-pointer rounded-lg"
                              >
                                {f.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field id={`fast-qty-${row.id}`} label="Кол-во" className="w-24">
                        <Input
                          id={`fast-qty-${row.id}`}
                          type="number"
                          min={1}
                          className={cn(fieldClass, "tabular-nums")}
                          value={row.quantity}
                          onChange={(e) => {
                            const qty = Math.max(1, parseInt(e.target.value, 10) || 1);
                            setFastenerRows((rows) =>
                              rows.map((r) => (r.id === row.id ? { ...r, quantity: qty } : r)),
                            );
                          }}
                        />
                      </Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive mb-0.5 size-8"
                        aria-label="Удалить крепёж"
                        onClick={() =>
                          setFastenerRows((rows) => rows.filter((r) => r.id !== row.id))
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="brand"
                    className={formAddButtonClass}
                    onClick={addFastenerRow}
                    disabled={fasteners.length === 0}
                  >
                    <Plus className="size-4" />
                    Добавить крепёж
                  </Button>
                </div>
              </FormSection>

              <Separator />

              <FormSection title="Упаковка">
                <Field id="prod-pack" label="Упаковка">
                  <Select
                    value={packagingId || undefined}
                    onValueChange={(v) => setPackagingId(v ?? "")}
                  >
                    <SelectTrigger id="prod-pack" className={selectTriggerClass}>
                      <SelectValue placeholder="Выберите упаковку">
                        {packagingItems.find((p) => p.id === packagingId)?.name ??
                          "Выберите упаковку"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent {...formSelectContentProps}>
                      {packagingItems.map((p) => (
                        <SelectItem key={p.id} value={p.id} className="cursor-pointer rounded-lg">
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </FormSection>

              {otherItems.length > 0 && (
                <>
                  <Separator />
                  <FormSection title="Разное">
                    <p className="text-muted-foreground -mt-2 text-xs leading-relaxed">
                      Позиции из таба «Разное» добавляют себестоимость изделия.
                    </p>
                    <div className="flex flex-col gap-3">
                      {otherItems.map((item) => (
                        <label
                          key={item.id}
                          className="flex cursor-pointer items-center gap-2.5 text-sm"
                        >
                          <Checkbox
                            checked={extraIds.has(item.id)}
                            onCheckedChange={(v) => toggleExtra(item.id, v === true)}
                            className="border-[#98a2b3] bg-card size-[18px] cursor-pointer"
                          />
                          {item.name}
                          <span className="text-muted-foreground tabular-nums">
                            ({formatMoneyDecimal(item.unitPrice)})
                          </span>
                        </label>
                      ))}
                    </div>
                  </FormSection>
                </>
              )}

              <Separator />

              <FormSection title="Детали в изделии">
                {!sort ? (
                  <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                    Сначала выберите сорт изделия — доступны будут только детали того же сорта
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-end gap-2">
                      <Field id="prod-det-pick" label="Выберите деталь" className="min-w-[12rem] flex-1">
                        <Select
                          value={draftDetailId || undefined}
                          onValueChange={(v) => setDraftDetailId(v ?? "")}
                        >
                          <SelectTrigger id="prod-det-pick" className={selectTriggerClass}>
                            <SelectValue placeholder="Деталь">
                              {draftDetailId
                                ? (() => {
                                    const d = sortDetails.find((x) => x.id === draftDetailId);
                                    return d ? `№${d.detailNumber} · ${d.name}` : "Деталь";
                                  })()
                                : "Деталь"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent {...formSelectContentProps}>
                            {sortDetails.map((d) => (
                              <SelectItem
                                key={d.id}
                                value={d.id}
                                className="cursor-pointer rounded-lg"
                              >
                                №{d.detailNumber} · {d.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field id="prod-det-qty" label="Количество" className="w-24">
                        <Input
                          id="prod-det-qty"
                          type="number"
                          min={1}
                          className={cn(fieldClass, "tabular-nums")}
                          value={draftDetailQty}
                          onChange={(e) => setDraftDetailQty(e.target.value)}
                        />
                      </Field>
                      <Button
                        type="button"
                        variant="brand"
                        className={cn(formAddButtonClass, "mb-0.5 px-4")}
                        onClick={addDetailRow}
                        disabled={!draftDetailId}
                      >
                        <Plus className="size-4" />
                        Добавить
                      </Button>
                    </div>

                    {detailRows.length > 0 && (
                      <ul className="divide-border divide-y rounded-xl border">
                        {detailRows.map((row) => (
                          <li
                            key={row.id}
                            className="flex items-center gap-3 px-4 py-2.5 text-sm"
                          >
                            <span className="bg-muted inline-flex size-7 shrink-0 items-center justify-center rounded-md text-sm font-semibold tabular-nums">
                              {detailById.get(row.detailId)?.detailNumber ?? "?"}
                            </span>
                            <span className="min-w-0 flex-1 font-medium">
                              {detailById.get(row.detailId)?.name ?? row.detailId}
                            </span>
                            <Input
                              type="number"
                              min={1}
                              className={cn(fieldClass, "h-9 w-20 tabular-nums")}
                              value={row.quantity}
                              onChange={(e) => {
                                const qty = Math.max(1, parseInt(e.target.value, 10) || 1);
                                setDetailRows((rows) =>
                                  rows.map((r) =>
                                    r.id === row.id ? { ...r, quantity: qty } : r,
                                  ),
                                );
                              }}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:text-destructive size-8 shrink-0"
                              aria-label="Удалить деталь"
                              onClick={() =>
                                setDetailRows((rows) => rows.filter((r) => r.id !== row.id))
                              }
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </FormSection>
            </div>

            <DialogFooter className="bg-muted/50 border-border !m-0 gap-2 border-t px-6 py-4 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                className="h-10 rounded-xl px-5"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Отмена
              </Button>
              <FormSubmitButton
                className="h-10 rounded-xl px-5"
                canSubmit={canSubmit}
                pending={pending}
                onInvalid={() => setShowErrors(true)}
                onSubmit={handleSubmit}
              >
                {isEdit ? "Сохранить" : "Создать изделие"}
              </FormSubmitButton>
            </DialogFooter>
    </>
  );
}
