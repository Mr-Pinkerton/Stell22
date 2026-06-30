"use client";

import { useMemo, useState, useTransition } from "react";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  archiveEmployee,
  createEmployee,
  deleteEmployee,
  restoreEmployee,
  updateEmployee,
  type EmployeeFormValues,
} from "@/server/employees";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { exportXlsx } from "@/lib/export-xlsx";
import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmployeeFormDialog } from "@/components/employees/employee-form-dialog";
import { PinCell } from "@/components/employees/pin-cell";
import type { Employee } from "@/types/domain";

const tableActionClass =
  "text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const tableActionDestructiveClass =
  "text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

export function EmployeesView({ initialEmployees }: { initialEmployees: Employee[] }) {
  const [search, setSearch] = useState("");
  const [showArchive, setShowArchive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [employees, setEmployees] = useState<Employee[]>(initialEmployees);
  const [pending, startTransition] = useTransition();
  const [exporting, startExport] = useTransition();

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      if (!showArchive && e.status === "ARCHIVED") return false;
      if (!q) return true;
      return e.fullName.toLowerCase().includes(q);
    });
  }, [employees, search, showArchive]);

  const handleExport = () =>
    startExport(async () => {
      try {
        await exportXlsx("сотрудники", [
          {
            name: "Сотрудники",
            columns: [
              { header: "ФИО", key: "fullName", width: 32 },
              { header: "PIN-код", key: "pin", width: 12 },
              { header: "Статус", key: "status", width: 14 },
            ],
            rows: rows.map((e) => ({
              fullName: e.fullName,
              pin: e.pin,
              status: e.status === "ACTIVE" ? "Активен" : "Архив",
            })),
          },
        ]);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Не удалось выгрузить");
      }
    });

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (employee: Employee) => {
    setEditing(employee);
    setDialogOpen(true);
  };

  const upsert = (e: Employee) =>
    setEmployees((prev) => {
      const i = prev.findIndex((x) => x.id === e.id);
      if (i === -1) return [...prev, e];
      const next = [...prev];
      next[i] = e;
      return next;
    });

  const handleSubmit = (values: EmployeeFormValues) =>
    new Promise<void>((resolve) => {
      startTransition(async () => {
        try {
          if (editing) {
            upsert(await updateEmployee(editing.id, values));
            toast.success("Сотрудник обновлён");
          } else {
            upsert(await createEmployee(values));
            toast.success("Сотрудник создан");
          }
          setDialogOpen(false);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Ошибка сохранения");
        } finally {
          resolve();
        }
      });
    });

  const runAction = (fn: () => Promise<Employee | void>, ok: string, removeId?: string) =>
    startTransition(async () => {
      try {
        const res = await fn();
        if (removeId) setEmployees((prev) => prev.filter((x) => x.id !== removeId));
        else if (res) upsert(res);
        toast.success(ok);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Ошибка операции");
      }
    });

  const columns: Column<Employee>[] = [
    {
      key: "fullName",
      header: "ФИО",
      render: (row) => <span className="font-medium">{row.fullName}</span>,
    },
    {
      key: "pin",
      header: "PIN-код",
      render: (row) => <PinCell pin={row.pin} />,
    },
    {
      key: "status",
      header: "Статус",
      render: (row) => (
        <Badge variant={row.status === "ACTIVE" ? "secondary" : "outline"}>
          {row.status === "ACTIVE" ? "Активен" : "Архив"}
        </Badge>
      ),
    },
    {
      key: "actions",
      header: "",
      className: "w-28",
      render: (row) => (
        <div className="flex items-center justify-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={tableActionClass}
                  aria-label="Изменить"
                  onClick={() => openEdit(row)}
                />
              }
            >
              <Pencil />
            </TooltipTrigger>
            <TooltipContent>Изменить</TooltipContent>
          </Tooltip>

          {row.status === "ACTIVE" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                  className={tableActionClass}
                  aria-label="В архив"
                  disabled={pending}
                  onClick={() => runAction(() => archiveEmployee(row.id), "Перенесено в архив")}
                />
                }
              >
                <Archive />
              </TooltipTrigger>
              <TooltipContent>В архив</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                  className={tableActionClass}
                  aria-label="Восстановить"
                  disabled={pending}
                  onClick={() => runAction(() => restoreEmployee(row.id), "Восстановлено")}
                />
                }
              >
                <ArchiveRestore />
              </TooltipTrigger>
              <TooltipContent>Восстановить</TooltipContent>
            </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={tableActionDestructiveClass}
                  aria-label="Удалить"
                  disabled={pending}
                  onClick={() => runAction(() => deleteEmployee(row.id), "Сотрудник удалён", row.id)}
                />
              }
            >
              <Trash2 />
            </TooltipTrigger>
            <TooltipContent>Удалить</TooltipContent>
          </Tooltip>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Сотрудники"
        canExport
        exporting={exporting}
        addLabel="Добавить сотрудника"
        onAdd={openCreate}
        onExport={handleExport}
      />

      <FiltersBar
        search
        archive
        actionLabel="Найти"
        searchValue={search}
        onSearchChange={setSearch}
        archiveChecked={showArchive}
        onArchiveChange={setShowArchive}
      />

      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            rows={rows}
            empty="Сотрудники не найдены"
            className="border-0"
            padded
          />
        </CardContent>
      </Card>

      <EmployeeFormDialog
        open={dialogOpen}
        employee={editing}
        onOpenChange={setDialogOpen}
        onSubmit={handleSubmit}
        pending={pending}
      />
    </>
  );
}
