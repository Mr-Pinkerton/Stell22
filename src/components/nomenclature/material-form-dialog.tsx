"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { capitalizeFirst } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FormSubmitButton } from "@/components/form-dialog-shared";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Material } from "@/types/domain";
import type { MaterialFormValues } from "@/server/materials";
import { Field, FormSection, fieldClass } from "./form-shared";

interface MaterialFormDialogProps {
  open: boolean;
  material?: Material | null;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: MaterialFormValues) => void | Promise<void>;
  pending?: boolean;
}

export function MaterialFormDialog({
  open,
  material,
  onOpenChange,
  onSubmit,
  pending,
}: MaterialFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={false}>
        {open ? (
          <MaterialFormBody
            material={material}
            pending={pending}
            onOpenChange={onOpenChange}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MaterialFormBody({
  material,
  pending,
  onOpenChange,
  onSubmit,
}: {
  material?: Material | null;
  pending?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: MaterialFormValues) => void | Promise<void>;
}) {
  const isEdit = Boolean(material);
  const [name, setName] = useState(material?.name ?? "");
  const [showErrors, setShowErrors] = useState(false);

  const canSubmit = name.trim().length > 0 && !pending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit?.({ name });
  };

  return (
    <>
      <div className="border-border flex items-center gap-4 border-b px-6 py-4">
        <DialogTitle className="min-w-0 flex-1 text-lg leading-tight font-semibold">
          {isEdit ? "Изменить материал" : "Создание материала"}
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
        <FormSection title="Материал">
          <Field id="mat-name" label="Название" required invalid={showErrors && !name.trim()}>
            <Input
              id="mat-name"
              className={fieldClass}
              autoCapitalize="sentences"
              placeholder="Берёза"
              value={name}
              onChange={(e) => setName(capitalizeFirst(e.target.value))}
            />
          </Field>
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
          {isEdit ? "Сохранить" : "Создать материал"}
        </FormSubmitButton>
      </DialogFooter>
    </>
  );
}
