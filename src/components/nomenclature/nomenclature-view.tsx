"use client";

import { useMemo, useState } from "react";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  details as mockDetails,
  nomenclatureItems as mockNomenclature,
  products as mockProducts,
} from "@/mocks/fixtures";
import { formatLength, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DetailFormDialog } from "@/components/nomenclature/detail-form-dialog";
import { NomenclatureItemFormDialog } from "@/components/nomenclature/nomenclature-item-form-dialog";
import { ProductFormDialog } from "@/components/nomenclature/product-form-dialog";
import {
  RAIL_TYPE_LABEL,
  SORT_SHORT,
  formatPrisadka,
  tableActionClass,
  tableActionDestructiveClass,
} from "@/components/nomenclature/form-shared";
import type { Detail, NomenclatureItem, NomenclatureType, Product } from "@/types/domain";

type TabKey = "products" | "details" | "fasteners" | "packaging" | "other";

const TABS: { key: TabKey; label: string }[] = [
  { key: "products", label: "Изделия" },
  { key: "details", label: "Детали" },
  { key: "fasteners", label: "Крепёж" },
  { key: "packaging", label: "Упаковка" },
  { key: "other", label: "Разное" },
];

const ADD_LABELS: Record<TabKey, string> = {
  products: "Добавить изделие",
  details: "Добавить деталь",
  fasteners: "Добавить крепёж",
  packaging: "Добавить упаковку",
  other: "Добавить позицию",
};

const TAB_TO_NOM_TYPE: Partial<Record<TabKey, NomenclatureType>> = {
  fasteners: "FASTENER",
  packaging: "PACKAGING",
  other: "OTHER",
};

function statusBadge(status: "ACTIVE" | "ARCHIVED") {
  return (
    <Badge variant={status === "ACTIVE" ? "secondary" : "outline"}>
      {status === "ACTIVE" ? "Активен" : "Архив"}
    </Badge>
  );
}

function ActionsCell({
  onEdit,
  status,
  onArchive,
  onRestore,
  onDelete,
}: {
  onEdit: () => void;
  status: "ACTIVE" | "ARCHIVED";
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
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
              onClick={onEdit}
            />
          }
        >
          <Pencil />
        </TooltipTrigger>
        <TooltipContent>Изменить</TooltipContent>
      </Tooltip>

      {status === "ACTIVE" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={tableActionClass}
                aria-label="В архив"
                onClick={onArchive}
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
                onClick={onRestore}
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
              onClick={onDelete}
            />
          }
        >
          <Trash2 />
        </TooltipTrigger>
        <TooltipContent>Удалить</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function NomenclatureView() {
  const [activeTab, setActiveTab] = useState<TabKey>("products");
  const [search, setSearch] = useState("");
  const [showArchive, setShowArchive] = useState(false);

  const [productDialogOpen, setProductDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [editingDetail, setEditingDetail] = useState<Detail | null>(null);

  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<NomenclatureItem | null>(null);
  const [itemDialogType, setItemDialogType] = useState<NomenclatureType>("FASTENER");

  const productRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mockProducts.filter((p) => {
      if (!showArchive && p.status === "ARCHIVED") return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q)
      );
    });
  }, [search, showArchive]);

  const detailRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mockDetails.filter((d) => {
      if (!showArchive && d.status === "ARCHIVED") return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q);
    });
  }, [search, showArchive]);

  const fastenerRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mockNomenclature.filter((n) => {
      if (n.type !== "FASTENER") return false;
      if (!showArchive && n.status === "ARCHIVED") return false;
      if (!q) return true;
      return n.name.toLowerCase().includes(q);
    });
  }, [search, showArchive]);

  const packagingRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mockNomenclature.filter((n) => {
      if (n.type !== "PACKAGING") return false;
      if (!showArchive && n.status === "ARCHIVED") return false;
      if (!q) return true;
      return n.name.toLowerCase().includes(q);
    });
  }, [search, showArchive]);

  const otherRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return mockNomenclature.filter((n) => {
      if (n.type !== "OTHER") return false;
      if (!showArchive && n.status === "ARCHIVED") return false;
      if (!q) return true;
      return n.name.toLowerCase().includes(q);
    });
  }, [search, showArchive]);

  const openCreate = () => {
    switch (activeTab) {
      case "products":
        setEditingProduct(null);
        setProductDialogOpen(true);
        break;
      case "details":
        setEditingDetail(null);
        setDetailDialogOpen(true);
        break;
      default: {
        const type = TAB_TO_NOM_TYPE[activeTab];
        if (type) {
          setItemDialogType(type);
          setEditingItem(null);
          setItemDialogOpen(true);
        }
      }
    }
  };

  const productColumns: Column<Product>[] = [
    {
      key: "name",
      header: "Название",
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "sku",
      header: "Артикул",
      className: "tabular-nums",
      render: (row) => row.sku,
    },
    {
      key: "sort",
      header: "Сорт",
      render: (row) => SORT_SHORT[row.sort],
    },
    {
      key: "detailsCount",
      header: "Детали",
      className: "tabular-nums",
      render: (row) => {
        const total = row.details.reduce((sum, d) => sum + d.quantity, 0);
        return `${total} шт`;
      },
    },
    {
      key: "status",
      header: "Статус",
      render: (row) => statusBadge(row.status),
    },
    {
      key: "actions",
      header: "",
      className: "w-28",
      render: (row) => (
        <ActionsCell
          onEdit={() => {
            setEditingProduct(row);
            setProductDialogOpen(true);
          }}
          status={row.status}
          onArchive={() => toast.message("В архив — прототип")}
          onRestore={() => toast.message("Восстановить — прототип")}
          onDelete={() => toast.message("Удалить — прототип")}
        />
      ),
    },
  ];

  const detailColumns: Column<Detail>[] = [
    {
      key: "name",
      header: "Название",
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "lengthM",
      header: "Длина",
      className: "tabular-nums",
      render: (row) => formatLength(row.lengthM),
    },
    {
      key: "detailType",
      header: "Тип",
      render: (row) => RAIL_TYPE_LABEL[row.detailType],
    },
    {
      key: "prisadka",
      header: "Присадка",
      render: (row) => formatPrisadka(row),
    },
    {
      key: "sort",
      header: "Сорт",
      render: (row) => SORT_SHORT[row.sort],
    },
    {
      key: "status",
      header: "Статус",
      render: (row) => statusBadge(row.status),
    },
    {
      key: "actions",
      header: "",
      className: "w-28",
      render: (row) => (
        <ActionsCell
          onEdit={() => {
            setEditingDetail(row);
            setDetailDialogOpen(true);
          }}
          status={row.status}
          onArchive={() => toast.message("В архив — прототип")}
          onRestore={() => toast.message("Восстановить — прототип")}
          onDelete={() => toast.message("Удалить — прототип")}
        />
      ),
    },
  ];

  const nomenclatureColumns: Column<NomenclatureItem>[] = [
    {
      key: "name",
      header: "Название",
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "unitPrice",
      header: "Цена за ед.",
      className: "tabular-nums",
      render: (row) => formatMoney(row.unitPrice),
    },
    {
      key: "status",
      header: "Статус",
      render: (row) => statusBadge(row.status),
    },
    {
      key: "actions",
      header: "",
      className: "w-28",
      render: (row) => (
        <ActionsCell
          onEdit={() => {
            setItemDialogType(row.type);
            setEditingItem(row);
            setItemDialogOpen(true);
          }}
          status={row.status}
          onArchive={() => toast.message("В архив — прототип")}
          onRestore={() => toast.message("Восстановить — прототип")}
          onDelete={() => toast.message("Удалить — прототип")}
        />
      ),
    },
  ];

  const emptyByTab: Record<TabKey, string> = {
    products: "Изделия не найдены",
    details: "Детали не найдены",
    fasteners: "Крепёж не найден",
    packaging: "Упаковка не найдена",
    other: "Позиции не найдены",
  };

  const rowsByTab: Record<TabKey, unknown[]> = {
    products: productRows,
    details: detailRows,
    fasteners: fastenerRows,
    packaging: packagingRows,
    other: otherRows,
  };

  return (
    <>
      <PageHeader
        title="Номенклатура"
        canExport
        addLabel={ADD_LABELS[activeTab]}
        onAdd={openCreate}
        onExport={() => toast.message("Экспорт — прототип")}
      />

      <div className="space-y-4">
        <FiltersBar
          search
          archive
          searchValue={search}
          onSearchChange={setSearch}
          archiveChecked={showArchive}
          onArchiveChange={setShowArchive}
        />

        <div
          className="bg-muted inline-flex flex-wrap gap-1 rounded-2xl p-1"
          role="tablist"
          aria-label="Раздел номенклатуры"
        >
          {TABS.map(({ key, label }) => {
            const active = activeTab === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(key)}
                className={cn(
                  "h-10 cursor-pointer rounded-xl px-4 text-sm font-semibold transition-colors",
                  active
                    ? "bg-card text-foreground shadow-soft"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        <Card className="surface-card ring-0">
          <CardContent className="p-0">
            {activeTab === "products" && (
              <DataTable
                columns={productColumns}
                rows={productRows}
                empty={emptyByTab.products}
                className="border-0"
                padded
              />
            )}
            {activeTab === "details" && (
              <DataTable
                columns={detailColumns}
                rows={detailRows}
                empty={emptyByTab.details}
                className="border-0"
                padded
              />
            )}
            {(activeTab === "fasteners" ||
              activeTab === "packaging" ||
              activeTab === "other") && (
              <DataTable
                columns={nomenclatureColumns}
                rows={rowsByTab[activeTab] as NomenclatureItem[]}
                empty={emptyByTab[activeTab]}
                className="border-0"
                padded
              />
            )}
          </CardContent>
        </Card>
      </div>

      <ProductFormDialog
        open={productDialogOpen}
        product={editingProduct}
        onOpenChange={setProductDialogOpen}
        onSubmit={() =>
          toast.success(
            editingProduct ? "Изделие сохранено (прототип)" : "Изделие создано (прототип)",
          )
        }
      />

      <DetailFormDialog
        open={detailDialogOpen}
        detail={editingDetail}
        onOpenChange={setDetailDialogOpen}
        onSubmit={() =>
          toast.success(
            editingDetail ? "Деталь сохранена (прототип)" : "Деталь создана (прототип)",
          )
        }
      />

      <NomenclatureItemFormDialog
        open={itemDialogOpen}
        type={itemDialogType}
        item={editingItem}
        onOpenChange={setItemDialogOpen}
        onSubmit={() =>
          toast.success(
            editingItem ? "Позиция сохранена (прототип)" : "Позиция создана (прототип)",
          )
        }
      />
    </>
  );
}
