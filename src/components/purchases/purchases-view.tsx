"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, PackageMinus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { batches as mockBatches, railLots as mockRailLots } from "@/mocks/fixtures";
import { batchCostMismatchIds } from "@/mocks/purchase-flags";
import { buildPurchaseRows, type PurchaseBatchRow } from "@/lib/batch-stats";
import { formatIsoDate, formatLength, formatMoney, formatVolume } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BatchFormDialog } from "@/components/purchases/batch-form-dialog";

const tableActionClass =
  "text-muted-foreground hover:text-foreground hover:bg-muted/60 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const tableActionDestructiveClass =
  "text-muted-foreground hover:text-destructive hover:bg-destructive/10 size-8 cursor-pointer rounded-lg [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const purchaseRows = buildPurchaseRows(mockBatches, mockRailLots, batchCostMismatchIds);

export function PurchasesView() {
  const [search, setSearch] = useState("");
  const [showArchive, setShowArchive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseBatchRow | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return purchaseRows.filter((b) => {
      if (!showArchive && b.status === "ARCHIVED") return false;
      if (!q) return true;
      return b.name.toLowerCase().includes(q);
    });
  }, [search, showArchive]);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (batch: PurchaseBatchRow) => {
    setEditing(batch);
    setDialogOpen(true);
  };

  const columns: Column<PurchaseBatchRow>[] = [
    {
      key: "name",
      header: "Партия",
      render: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.name}</span>
          {row.costMismatch && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="text-destructive inline-flex cursor-default">
                    <AlertTriangle className="size-4 stroke-[1.75]" />
                  </span>
                }
              />
              <TooltipContent className="max-w-xs">
                Сумма по ценам сортов не совпадает со стоимостью партии
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      key: "purchaseCost",
      header: "Закупочная",
      className: "tabular-nums",
      render: (row) => formatMoney(row.purchaseCost),
    },
    {
      key: "totalCost",
      header: "Общая",
      className: "tabular-nums",
      render: (row) => (
        <span className={row.totalCost > row.purchaseCost ? "font-medium" : undefined}>
          {formatMoney(row.totalCost)}
        </span>
      ),
    },
    {
      key: "railCount",
      header: "Рейки",
      className: "tabular-nums",
      render: (row) => `${row.stats.railCount} шт`,
    },
    {
      key: "totalLength",
      header: "Длина",
      className: "tabular-nums",
      render: (row) => formatLength(row.stats.totalLengthM),
    },
    {
      key: "volume",
      header: "Объём",
      className: "tabular-nums",
      render: (row) => formatVolume(row.stats.volumeM3),
    },
    {
      key: "status",
      header: "Статус",
      render: (row) => (
        <Badge variant={row.status === "IN_WORK" ? "secondary" : "outline"}>
          {row.status === "IN_WORK" ? "В работе" : "Архив"}
        </Badge>
      ),
    },
    {
      key: "purchaseDate",
      header: "Дата",
      className: "tabular-nums",
      render: (row) => formatIsoDate(row.purchaseDate),
    },
    {
      key: "actions",
      header: "",
      className: "w-32",
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

          {row.status === "IN_WORK" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={tableActionClass}
                    aria-label="Списать остаток"
                    onClick={() => toast.message("Списать остаток — прототип")}
                  />
                }
              >
                <PackageMinus />
              </TooltipTrigger>
              <TooltipContent>Списать остаток</TooltipContent>
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
        title="Закупки"
        canExport
        addLabel="Добавить партию"
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
            empty="Партии не найдены"
            className="border-0"
            padded
          />
        </CardContent>
      </Card>

      <BatchFormDialog
        open={dialogOpen}
        batch={editing}
        onOpenChange={setDialogOpen}
        onSubmit={() => toast.success(editing ? "Партия сохранена (прототип)" : "Партия добавлена (прототип)")}
      />
    </>
  );
}
