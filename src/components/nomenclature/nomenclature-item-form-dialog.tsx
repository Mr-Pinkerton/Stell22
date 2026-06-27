"use client";

import { XIcon } from "lucide-react";
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
import type { NomenclatureItem, NomenclatureType } from "@/types/domain";
import { Field, FormSection, fieldClass, narrowFieldClass } from "./form-shared";

const TYPE_TITLE: Record<NomenclatureType, { create: string; edit: string; submit: string }> = {
  FASTENER: {
    create: "Добавить крепёж",
    edit: "Изменить крепёж",
    submit: "Создать крепёж",
  },
  PACKAGING: {
    create: "Добавить упаковку",
    edit: "Изменить упаковку",
    submit: "Создать упаковку",
  },
  OTHER: {
    create: "Добавить позицию",
    edit: "Изменить позицию",
    submit: "Создать позицию",
  },
};

interface NomenclatureItemFormDialogProps {
  open: boolean;
  type: NomenclatureType;
  item?: NomenclatureItem | null;
  onOpenChange: (open: boolean) => void;
  onSubmit?: () => void;
}

export function NomenclatureItemFormDialog({
  open,
  type,
  item,
  onOpenChange,
  onSubmit,
}: NomenclatureItemFormDialogProps) {
  const isEdit = Boolean(item);
  const titles = TYPE_TITLE[type];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        {open ? (
          <>
            <div className="border-border flex items-center gap-4 border-b px-6 py-4">
              <DialogTitle className="min-w-0 flex-1 text-lg leading-tight font-semibold">
                {isEdit ? titles.edit : titles.create}
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

            <div className="space-y-5 px-6 py-6">
              <FormSection title="Основная информация">
                <Field id="nom-name" label="Наименование" required>
                  <Input
                    id="nom-name"
                    className={fieldClass}
                    placeholder="Название позиции"
                    defaultValue={item?.name ?? ""}
                  />
                </Field>
                <Field id="nom-price" label="Цена за единицу" required>
                  <MoneyInput
                    id="nom-price"
                    className={narrowFieldClass}
                    suffix="₽"
                    defaultValue={item?.unitPrice ?? null}
                  />
                </Field>
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
                {isEdit ? "Сохранить" : titles.submit}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
