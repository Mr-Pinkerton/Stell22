"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { FinanceCategory } from "@/mocks/finance-fixtures";
import { DataTable, type Column } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CategoryFormDialog,
  type CategoryFormValues,
} from "@/components/finance/category-form-dialog";

const tableActionClass =
  "text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const tableActionDestructiveClass =
  "text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

interface FinanceCategoriesTabProps {
  categories: FinanceCategory[];
  onRegisterCreate?: (openCreate: () => void) => void;
  onCreate?: (values: CategoryFormValues) => void;
  onUpdate?: (id: string, values: CategoryFormValues) => void;
  onDelete?: (id: string) => void;
}

export function FinanceCategoriesTab({
  categories,
  onRegisterCreate,
  onCreate,
  onUpdate,
  onDelete,
}: FinanceCategoriesTabProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FinanceCategory | null>(null);

  const openCreate = useCallback(() => {
    setEditing(null);
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    onRegisterCreate?.(openCreate);
  }, [onRegisterCreate, openCreate]);

  const columns: Column<FinanceCategory>[] = [
    {
      key: "name",
      header: "Категория",
      render: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.name}</span>
          {row.isOverhead && (
            <Badge variant="secondary" className="text-xs">
              Накладные
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: "articleCount",
      header: "Статей",
      className: "w-28 text-center tabular-nums",
      render: (row) => row.articleCount,
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
                  onClick={() => onDelete?.(row.id)}
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
            rows={categories}
            empty="Категорий нет"
            className="border-0"
            padded
          />
        </CardContent>
      </Card>

      <CategoryFormDialog
        open={dialogOpen}
        category={editing}
        onOpenChange={setDialogOpen}
        onSubmit={(values) => {
          if (editing) onUpdate?.(editing.id, values);
          else onCreate?.(values);
        }}
      />
    </>
  );
}
