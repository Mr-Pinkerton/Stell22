"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
import type { Detail, RailType, Sort } from "@/types/domain";
import {
  Field,
  FormSection,
  RAIL_TYPE_LABEL,
  SORT_LABEL,
  fieldClass,
  formSelectContentProps,
  narrowFieldClass,
  selectTriggerClass,
} from "./form-shared";

interface DetailFormDialogProps {
  open: boolean;
  detail?: Detail | null;
  onOpenChange: (open: boolean) => void;
  onSubmit?: () => void;
}

function LengthInput({ defaultValue }: { defaultValue?: number }) {
  const [text, setText] = useState(() =>
    defaultValue != null ? String(defaultValue).replace(".", ",") : "",
  );

  return (
    <div className="relative">
      <Input
        id="det-length"
        type="text"
        inputMode="decimal"
        className={cn(narrowFieldClass, "pr-8 tabular-nums")}
        placeholder="0,72"
        value={text}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d,]/g, "");
          setText(raw);
        }}
      />
      <span
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm"
        aria-hidden
      >
        м
      </span>
    </div>
  );
}

export function DetailFormDialog({ open, detail, onOpenChange, onSubmit }: DetailFormDialogProps) {
  const isEdit = Boolean(detail);
  const [detailType, setDetailType] = useState<RailType>(detail?.detailType ?? "POLKA");
  const [sort, setSort] = useState<Sort>(detail?.sort ?? "SORT1");
  const [prisadkaTorcev, setPrisadkaTorcev] = useState(detail?.prisadkaTorcevaya ?? true);
  const [prisadkaPlosk, setPrisadkaPlosk] = useState(detail?.prisadkaPloskost ?? false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
        {open ? (
          <>
            <div className="border-border flex items-center gap-4 border-b px-6 py-4">
              <DialogTitle className="min-w-0 flex-1 text-lg leading-tight font-semibold">
                {isEdit ? "Изменить деталь" : "Создание детали"}
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

            <div className="scrollbar-thin-y max-h-[min(70vh,32rem)] space-y-5 overflow-y-auto px-6 py-6">
              <FormSection title="Основная информация">
                <Field id="det-name" label="Название детали" required>
                  <Input
                    id="det-name"
                    className={fieldClass}
                    placeholder="Полка 720"
                    defaultValue={detail?.name ?? ""}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="det-length" label="Длина детали" required>
                    <LengthInput defaultValue={detail?.lengthM} />
                  </Field>
                  <Field id="det-type" label="Тип" required>
                    <Select
                      value={detailType}
                      onValueChange={(v) => setDetailType(v as RailType)}
                    >
                      <SelectTrigger id="det-type" className={selectTriggerClass}>
                        <SelectValue>{RAIL_TYPE_LABEL[detailType]}</SelectValue>
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
                  </Field>
                  <Field id="det-sort" label="Сорт" required>
                    <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                      <SelectTrigger id="det-sort" className={selectTriggerClass}>
                        <SelectValue>{SORT_LABEL[sort]}</SelectValue>
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

              <FormSection title="Присадка">
                <p className="text-muted-foreground -mt-2 text-xs leading-relaxed">
                  Деталь готова только после выполнения всех выбранных типов присадки.
                </p>
                <div className="flex flex-col gap-3">
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                    <Checkbox
                      checked={prisadkaTorcev}
                      onCheckedChange={(v) => setPrisadkaTorcev(v === true)}
                      className="border-[#98a2b3] bg-card size-[18px] cursor-pointer"
                    />
                    Торцевая
                  </label>
                  <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                    <Checkbox
                      checked={prisadkaPlosk}
                      onCheckedChange={(v) => setPrisadkaPlosk(v === true)}
                      className="border-[#98a2b3] bg-card size-[18px] cursor-pointer"
                    />
                    По плоскости
                  </label>
                </div>
              </FormSection>
            </div>

            <DialogFooter className="bg-muted/50 border-border !m-0 gap-2 border-t px-6 py-4 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                className="h-10 rounded-xl px-5"
                onClick={() => onOpenChange(false)}
              >
                Отмена
              </Button>
              <Button
                className="h-10 rounded-xl px-5"
                onClick={() => {
                  onSubmit?.();
                  onOpenChange(false);
                }}
              >
                {isEdit ? "Сохранить" : "Создать деталь"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
