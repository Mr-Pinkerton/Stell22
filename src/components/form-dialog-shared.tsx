"use client";

import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

/** Оболочка модалок форм — эталон: `batch-form-dialog`, `employee-form-dialog`. */
export const formDialogContentClass = "gap-0 overflow-hidden p-0";

export const formDialogHeaderClass =
  "border-border flex items-center gap-4 border-b px-6 py-4";

export const formDialogTitleClass = "min-w-0 flex-1 text-lg leading-tight font-semibold";

export const formDialogBodyClass =
  "scrollbar-thin-y max-h-[min(70vh,32rem)] space-y-5 overflow-y-auto px-6 py-6";

export const formDialogBodyTallClass =
  "scrollbar-thin-y max-h-[min(80vh,40rem)] space-y-5 overflow-y-auto px-6 py-6";

export const formDialogFooterClass =
  "bg-muted/50 border-border !m-0 gap-2 border-t px-6 py-4 sm:flex-row sm:justify-end";

export const formDialogCancelButtonClass = "h-10 cursor-pointer rounded-xl px-5";

export const formDialogSubmitButtonClass = "h-10 cursor-pointer rounded-xl px-5";

/**
 * Кнопка отправки формы с подсказкой при неактивном состоянии: когда
 * `canSubmit` = false, кнопка выглядит неактивной, но по клику вызывает
 * `onInvalid` (форма подсвечивает незаполненные поля), а не сабмит.
 */
export function FormSubmitButton({
  children,
  canSubmit,
  pending,
  onSubmit,
  onInvalid,
  className,
  variant,
}: {
  children: React.ReactNode;
  canSubmit: boolean;
  pending?: boolean;
  onSubmit: () => void;
  onInvalid: () => void;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
}) {
  return (
    <Button
      type="button"
      variant={variant}
      className={cn(formDialogSubmitButtonClass, !canSubmit && "opacity-50", className)}
      disabled={pending}
      onClick={() => {
        if (pending) return;
        if (!canSubmit) {
          onInvalid();
          return;
        }
        onSubmit();
      }}
    >
      {children}
    </Button>
  );
}

export function FormDialogCloseButton({ compact = true }: { compact?: boolean }) {
  return (
    <DialogClose
      render={
        <Button
          type="button"
          variant="ghost"
          className={cn(
            "icon-action-btn size-[2.4rem] shrink-0 rounded-xl",
            compact && "icon-action-btn--compact",
          )}
          aria-label="Закрыть"
        />
      }
    >
      <XIcon className="size-[1.4rem]" />
    </DialogClose>
  );
}

interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  maxWidth?: string;
  bodyTall?: boolean;
  submitLabel?: string;
  submitDisabled?: boolean;
  /** Если задан — кнопка становится «подсказывающей»: клик по неактивной вызывает onInvalid. */
  canSubmit?: boolean;
  pending?: boolean;
  onInvalid?: () => void;
  onSubmit: () => void;
  children: React.ReactNode;
}

export function FormDialog({
  open,
  onOpenChange,
  title,
  maxWidth = "sm:max-w-lg",
  bodyTall = false,
  submitLabel = "Сохранить",
  submitDisabled,
  canSubmit,
  pending,
  onInvalid,
  onSubmit,
  children,
}: FormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(formDialogContentClass, maxWidth)} showCloseButton={false}>
        {open ? (
          <>
            <div className={formDialogHeaderClass}>
              <DialogTitle className={formDialogTitleClass}>{title}</DialogTitle>
              <FormDialogCloseButton />
            </div>

            <div className={bodyTall ? formDialogBodyTallClass : formDialogBodyClass}>
              {children}
            </div>

            <DialogFooter className={formDialogFooterClass}>
              <Button
                type="button"
                variant="outline"
                className={formDialogCancelButtonClass}
                onClick={() => onOpenChange(false)}
              >
                Отмена
              </Button>
              {onInvalid ? (
                <FormSubmitButton
                  canSubmit={canSubmit ?? true}
                  pending={pending}
                  onSubmit={onSubmit}
                  onInvalid={onInvalid}
                >
                  {submitLabel}
                </FormSubmitButton>
              ) : (
                <Button
                  type="button"
                  className={formDialogSubmitButtonClass}
                  disabled={submitDisabled}
                  onClick={onSubmit}
                >
                  {submitLabel}
                </Button>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
