"use client";

import { useMemo, useState } from "react";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { employees as mockEmployees } from "@/mocks/fixtures";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
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

export function EmployeesView() {
  const [search, setSearch] = useState("");
  const [showArchive, setShowArchive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mockEmployees.filter((e) => {
      if (!showArchive && e.status === "ARCHIVED") return false;
      if (!q) return true;
      return e.fullName.toLowerCase().includes(q);
    });
  }, [search, showArchive]);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (employee: Employee) => {
    setEditing(employee);
    setDialogOpen(true);
  };

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
      className: "w-28 text-right",
      render: (row) => (
        <div className="flex items-center justify-end gap-0.5">
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
                    onClick={() => toast.message("В архив — прототип")}
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
                    onClick={() => toast.message("Восстановить — прототип")}
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
                  onClick={() => toast.message("Удалить — прототип")}
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
        addLabel="Добавить сотрудника"
        onAdd={openCreate}
        onExport={() => toast.message("Экспорт — прототип")}
      />

      <FiltersBar
        search
        archive
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
        onSubmit={() => toast.success(editing ? "Сохранено (прототип)" : "Сотрудник создан (прототип)")}
      />
    </>
  );
}
