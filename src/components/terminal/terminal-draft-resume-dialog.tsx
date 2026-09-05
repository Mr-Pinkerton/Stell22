"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/format";
import {
  isDraftStaleByAge,
  OPERATION_LABEL,
  type DraftParseFailReason,
  type TerminalDraftV1,
} from "@/lib/terminal-draft-storage";

export interface TerminalDraftResumeDialogProps {
  open: boolean;
  draft: TerminalDraftV1 | null;
  parseError: DraftParseFailReason | null;
  onContinue: () => void;
  onDelete: () => void;
  onDismiss?: () => void;
}

export function TerminalDraftResumeDialog({
  open,
  draft,
  parseError,
  onContinue,
  onDelete,
  onDismiss,
}: TerminalDraftResumeDialogProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const errorMode = parseError != null;

  const started =
    draft && !Number.isNaN(Date.parse(draft.createdAt))
      ? formatDateTime(new Date(draft.createdAt))
      : null;
  const old = draft ? isDraftStaleByAge(draft.createdAt) : false;

  const closeConfirm = () => setConfirmDelete(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          closeConfirm();
          onDismiss?.();
        }
      }}
    >
      {open && (
        <DialogContent className="gap-5 px-8 py-6 sm:max-w-[28rem]" showCloseButton={false}>
          {confirmDelete ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-xl">Удалить черновик?</DialogTitle>
              </DialogHeader>
              <p className="text-muted-foreground text-base leading-relaxed">
                Введённые данные будут потеряны.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="h-14 rounded-xl text-lg"
                  onClick={closeConfirm}
                >
                  Отмена
                </Button>
                <Button
                  className="h-14 rounded-xl text-lg"
                  onClick={() => {
                    closeConfirm();
                    onDelete();
                  }}
                >
                  Удалить
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="text-xl">
                  {errorMode ? "Не удалось прочитать черновик" : "Есть незавершённая операция"}
                </DialogTitle>
              </DialogHeader>
              {!errorMode && draft && (
                <div className="text-muted-foreground space-y-1 text-base leading-relaxed">
                  <p>
                    {OPERATION_LABEL[draft.operationType]}
                    {started ? ` · начата ${started}` : ""}
                  </p>
                  {old && <p>Черновик старше суток. Данные не удаляются автоматически.</p>}
                </div>
              )}
              {errorMode && (
                <p className="text-muted-foreground text-base leading-relaxed">
                  Сохранённые данные повреждены или устарели. Можно удалить черновик и начать заново.
                </p>
              )}
              <div className={errorMode ? "grid grid-cols-1 gap-2" : "grid grid-cols-2 gap-2"}>
                {!errorMode && (
                  <Button className="h-14 rounded-xl text-lg" onClick={onContinue}>
                    Продолжить
                  </Button>
                )}
                <Button
                  variant="outline"
                  className="h-14 rounded-xl text-lg"
                  onClick={() => setConfirmDelete(true)}
                >
                  Удалить черновик
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
