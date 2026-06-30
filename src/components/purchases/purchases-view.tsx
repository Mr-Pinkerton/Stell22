"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Lock, PackageMinus, Pencil, Printer, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createBatch,
  createSimplePurchase,
  deleteBatch,
  getBatchLabels,
  updateBatch,
  writeOffBatchRemainder,
  type BatchFormValues,
  type SimplePurchaseFormValues,
} from "@/server/purchases";
import { printPackageLabels } from "@/lib/print-labels";
import { closeBatch } from "@/server/cost";
import { type PurchaseBatchRow } from "@/lib/batch-stats";
import type { NomenclatureItem } from "@/types/domain";
import { formatIsoDate, formatLength, formatMoney, formatVolume } from "@/lib/format";
import { exportXlsx } from "@/lib/export-xlsx";
import { XLSX_FMT } from "@/lib/xlsx-types";
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

interface PurchasesViewProps {
  initialRows: PurchaseBatchRow[];
  items: NomenclatureItem[];
}

export function PurchasesView({ initialRows, items }: PurchasesViewProps) {
  const [search, setSearch] = useState("");
  const [showArchive, setShowArchive] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PurchaseBatchRow | null>(null);
  const [batches, setBatches] = useState<PurchaseBatchRow[]>(initialRows);
  const [pending, startTransition] = useTransition();
  const [exporting, startExport] = useTransition();

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return batches.filter((b) => {
      if (!showArchive && b.status === "ARCHIVED") return false;
      if (!q) return true;
      return b.name.toLowerCase().includes(q);
    });
  }, [batches, search, showArchive]);

  const handleExport = () =>
    startExport(async () => {
      try {
        await exportXlsx("закупки", [
          {
            name: "Закупки",
            columns: [
              { header: "Партия", key: "name", width: 28 },
              { header: "Закупочная", key: "purchaseCost", numFmt: XLSX_FMT.money },
              { header: "Общая", key: "totalCost", numFmt: XLSX_FMT.money },
              { header: "Рейки, шт", key: "railCount", numFmt: XLSX_FMT.int },
              { header: "Длина", key: "totalLength", numFmt: XLSX_FMT.length },
              { header: "Объём", key: "volume", numFmt: XLSX_FMT.volume, width: 16 },
              { header: "Статус", key: "status", width: 12 },
              { header: "Дата", key: "purchaseDate", width: 14 },
            ],
            rows: rows.map((b) => ({
              name: b.name,
              purchaseCost: b.purchaseCost,
              totalCost: b.totalCost,
              railCount: b.stats.railCount,
              totalLength: b.stats.totalLengthM,
              volume: b.stats.volumeM3,
              status: b.status === "IN_WORK" ? "В работе" : "Архив",
              purchaseDate: formatIsoDate(b.purchaseDate),
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

  const openEdit = (batch: PurchaseBatchRow) => {
    setEditing(batch);
    setDialogOpen(true);
  };

  const upsert = (b: PurchaseBatchRow) =>
    setBatches((prev) => {
      const i = prev.findIndex((x) => x.id === b.id);
      if (i === -1) return [b, ...prev];
      const next = [...prev];
      next[i] = b;
      return next;
    });

  const runRow = (fn: () => Promise<unknown>, ok: string) =>
    startTransition(async () => {
      try {
        await fn();
        toast.success(ok);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Ошибка операции");
      }
    });

  const handlePrintLabels = (row: PurchaseBatchRow) =>
    startTransition(async () => {
      try {
        const labels = await getBatchLabels(row.id);
        if (labels.length === 0) {
          toast.message("В партии нет пакетов с кодами");
          return;
        }
        if (!printPackageLabels(labels)) {
          toast.error("Не удалось открыть окно печати (разрешите всплывающие окна)");
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Ошибка печати");
      }
    });

  const handleBatchSubmit = (values: BatchFormValues) =>
    new Promise<void>((resolve) => {
      startTransition(async () => {
        try {
          upsert(editing ? await updateBatch(editing.id, values) : await createBatch(values));
          toast.success(editing ? "Партия сохранена" : "Партия добавлена");
          setDialogOpen(false);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Ошибка сохранения");
        } finally {
          resolve();
        }
      });
    });

  const handleSimpleSubmit = (values: SimplePurchaseFormValues) =>
    new Promise<void>((resolve) => {
      startTransition(async () => {
        try {
          await createSimplePurchase(values);
          toast.success("Закупка добавлена");
          setDialogOpen(false);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Ошибка сохранения");
        } finally {
          resolve();
        }
      });
    });

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
      className: "w-40",
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
                    disabled={pending}
                    onClick={() =>
                      runRow(() => writeOffBatchRemainder(row.id).then(upsert), "Остаток списан в отход")
                    }
                  />
                }
              >
                <PackageMinus />
              </TooltipTrigger>
              <TooltipContent>Списать остаток</TooltipContent>
            </Tooltip>
          )}

          {row.status === "IN_WORK" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={tableActionClass}
                    aria-label="Закрыть партию"
                    disabled={pending}
                    onClick={() =>
                      runRow(
                        () => closeBatch(row.id).then(() => upsert({ ...row, status: "ARCHIVED" })),
                        "Партия закрыта, себестоимость заморожена",
                      )
                    }
                  />
                }
              >
                <Lock />
              </TooltipTrigger>
              <TooltipContent>Закрыть партию (заморозить себестоимость)</TooltipContent>
            </Tooltip>
          )}

          {row.stats.packageCount > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={tableActionClass}
                    aria-label="Печать этикеток"
                    disabled={pending}
                    onClick={() => handlePrintLabels(row)}
                  />
                }
              >
                <Printer />
              </TooltipTrigger>
              <TooltipContent>Печать этикеток пакетов</TooltipContent>
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
                  onClick={() =>
                    runRow(
                      () => deleteBatch(row.id).then(() => setBatches((p) => p.filter((x) => x.id !== row.id))),
                      "Партия удалена",
                    )
                  }
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
        exporting={exporting}
        addLabel="Добавить партию"
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
            empty="Партии не найдены"
            className="border-0"
            padded
          />
        </CardContent>
      </Card>

      <BatchFormDialog
        open={dialogOpen}
        batch={editing}
        items={items}
        onOpenChange={setDialogOpen}
        onSubmitBatch={handleBatchSubmit}
        onSubmitSimple={handleSimpleSubmit}
        pending={pending}
      />
    </>
  );
}
