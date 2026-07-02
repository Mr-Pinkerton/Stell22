"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { createAccount, deleteAccount, updateAccount } from "@/server/finance";
import type { FinanceAccount } from "@/mocks/finance-fixtures";
import { formatIsoDate, formatMoney } from "@/lib/format";
import { DataTable, type Column } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountFormDialog } from "@/components/settings/account-form-dialog";

const tableActionClass =
  "text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const tableActionDestructiveClass =
  "text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

interface SettingsAccountsTabProps {
  accounts: FinanceAccount[];
  onAccountsChange: (accounts: FinanceAccount[]) => void;
  onRegisterCreate?: (fn: () => void) => void;
}

export function SettingsAccountsTab({
  accounts,
  onAccountsChange,
  onRegisterCreate,
}: SettingsAccountsTabProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FinanceAccount | null>(null);
  const [, startTransition] = useTransition();

  const openCreate = useCallback(() => {
    setEditing(null);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    onRegisterCreate?.(openCreate);
  }, [onRegisterCreate, openCreate]);

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      try {
        await fn();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Не удалось выполнить операцию");
      }
    });

  const columns: Column<FinanceAccount>[] = [
    {
      key: "name",
      header: "Счёт",
      render: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.name}</span>
          {row.balanceMismatch && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="outline" className="border-red-300 text-red-600">
                    ≠
                  </Badge>
                }
              />
              <TooltipContent>
                Последняя выписка разошлась с расчётным остатком
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      key: "opening",
      header: "Начальный остаток",
      className: "w-40 tabular-nums",
      render: (row) => formatMoney(row.openingBalance ?? 0),
    },
    {
      key: "openingDate",
      header: "На дату",
      className: "w-28 tabular-nums",
      render: (row) => (row.openingDate ? formatIsoDate(row.openingDate) : "—"),
    },
    {
      key: "balance",
      header: "Остаток",
      className: "w-40",
      render: (row) => <span className="font-medium tabular-nums">{formatMoney(row.balance)}</span>,
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
                  onClick={() => {
                    setEditing(row);
                    setDialogOpen(true);
                  }}
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
                  onClick={() =>
                    run(async () => {
                      await deleteAccount(row.id);
                      onAccountsChange(accounts.filter((a) => a.id !== row.id));
                      toast.success("Счёт удалён");
                    })
                  }
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
  ];

  return (
    <>
      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            rows={accounts}
            empty="Счетов нет"
            padded
            className="border-0"
          />
        </CardContent>
      </Card>

      <AccountFormDialog
        open={dialogOpen}
        account={editing}
        onOpenChange={setDialogOpen}
        onSubmit={(values) =>
          run(async () => {
            if (editing) {
              const updated = await updateAccount(editing.id, values);
              onAccountsChange(accounts.map((a) => (a.id === editing.id ? updated : a)));
              toast.success("Счёт обновлён");
            } else {
              const created = await createAccount(values);
              onAccountsChange(
                [...accounts, created].sort((a, b) => a.name.localeCompare(b.name)),
              );
              toast.success("Счёт добавлен");
            }
          })
        }
      />
    </>
  );
}
