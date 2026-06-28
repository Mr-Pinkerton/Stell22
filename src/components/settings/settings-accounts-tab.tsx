"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { financeAccounts, type FinanceAccount } from "@/mocks/finance-fixtures";
import { formatMoney } from "@/lib/format";
import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountFormDialog } from "@/components/settings/account-form-dialog";

const tableActionClass =
  "text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const tableActionDestructiveClass =
  "text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

interface SettingsAccountsTabProps {
  accounts?: FinanceAccount[];
  onAccountsChange?: (accounts: FinanceAccount[]) => void;
  onRegisterCreate?: (fn: () => void) => void;
}

export function SettingsAccountsTab({
  accounts: accountsProp,
  onAccountsChange,
  onRegisterCreate,
}: SettingsAccountsTabProps) {
  const [internal, setInternal] = useState(financeAccounts);
  const accounts = accountsProp ?? internal;
  const setAccounts = onAccountsChange ?? setInternal;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FinanceAccount | null>(null);

  const openCreate = useCallback(() => {
    setEditing(null);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    onRegisterCreate?.(openCreate);
  }, [onRegisterCreate, openCreate]);

  const columns: Column<FinanceAccount>[] = [
    {
      key: "name",
      header: "Счёт",
      render: (row) => <span className="font-medium">{row.name}</span>,
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
                  onClick={() => {
                    setAccounts(accounts.filter((a) => a.id !== row.id));
                    toast.success("Счёт удалён (прототип)");
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
        onSubmit={(values) => {
          if (editing) {
            setAccounts(
              accounts.map((a) =>
                a.id === editing.id ? { ...a, name: values.name, balance: values.balance } : a,
              ),
            );
            toast.success("Счёт обновлён (прототип)");
          } else {
            setAccounts([
              ...accounts,
              { id: `acc-${Date.now()}`, name: values.name, balance: values.balance },
            ]);
            toast.success("Счёт добавлен (прототип)");
          }
        }}
      />
    </>
  );
}
