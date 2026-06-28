"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  financeCounterparties,
  type FinanceCounterparty,
} from "@/mocks/finance-fixtures";
import { DataTable, type Column } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CounterpartyFormDialog } from "@/components/finance/counterparty-form-dialog";

const tableActionClass =
  "text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const tableActionDestructiveClass =
  "text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

interface FinanceCounterpartiesTabProps {
  onRegisterCreate?: (openCreate: () => void) => void;
}

export function FinanceCounterpartiesTab({ onRegisterCreate }: FinanceCounterpartiesTabProps) {
  const [rows, setRows] = useState(financeCounterparties);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FinanceCounterparty | null>(null);

  const openCreate = useCallback(() => {
    setEditing(null);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    onRegisterCreate?.(openCreate);
  }, [onRegisterCreate, openCreate]);

  const openEdit = (row: FinanceCounterparty) => {
    setEditing(row);
    setDialogOpen(true);
  };

  const columns: Column<FinanceCounterparty>[] = useMemo(
    () => [
      {
        key: "name",
        header: "Название",
        render: (row) => <span className="font-medium">{row.name}</span>,
      },
      {
        key: "actions",
        header: "",
        className: "w-24",
        render: (row) => (
          <div className="flex items-center justify-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={tableActionClass}
                    onClick={() => openEdit(row)}
                  >
                    <Pencil />
                  </Button>
                }
              />
              <TooltipContent>Редактировать</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={tableActionDestructiveClass}
                    onClick={() => {
                      setRows((prev) => prev.filter((r) => r.id !== row.id));
                      toast.success("Контрагент удалён (прототип)");
                    }}
                  >
                    <Trash2 />
                  </Button>
                }
              />
              <TooltipContent>Удалить</TooltipContent>
            </Tooltip>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            rows={rows}
            empty="Контрагентов нет"
            className="border-0"
            padded
          />
        </CardContent>
      </Card>

      <CounterpartyFormDialog
        open={dialogOpen}
        counterparty={editing}
        onOpenChange={setDialogOpen}
        onSubmit={(name) => {
          if (editing) {
            setRows((prev) =>
              prev.map((r) => (r.id === editing.id ? { ...r, name } : r)),
            );
            toast.success("Контрагент обновлён (прототип)");
          } else {
            setRows((prev) => [...prev, { id: `cp-${Date.now()}`, name }]);
            toast.success("Контрагент добавлен (прототип)");
          }
        }}
      />
    </>
  );
}
