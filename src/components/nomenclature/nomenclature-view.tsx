"use client";

import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  archiveDetail,
  archiveNomenclatureItem,
  archiveProduct,
  createDetail,
  createNomenclatureItem,
  createProduct,
  deleteDetail,
  deleteNomenclatureItem,
  deleteProduct,
  restoreDetail,
  restoreNomenclatureItem,
  restoreProduct,
  updateDetail,
  updateNomenclatureItem,
  updateProduct,
  type DetailFormValues,
  type NomenclatureItemFormValues,
  type ProductFormValues,
} from "@/server/nomenclature";
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

interface NomenclatureViewProps {
  initialDetails: Detail[];
  initialProducts: Product[];
  initialItems: NomenclatureItem[];
}

export function NomenclatureView({
  initialDetails,
  initialProducts,
  initialItems,
}: NomenclatureViewProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("products");
  const [search, setSearch] = useState("");
  const [showArchive, setShowArchive] = useState(false);
  const [pending, startTransition] = useTransition();

  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [details, setDetails] = useState<Detail[]>(initialDetails);
  const [items, setItems] = useState<NomenclatureItem[]>(initialItems);

  const [productDialogOpen, setProductDialogOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [editingDetail, setEditingDetail] = useState<Detail | null>(null);

  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<NomenclatureItem | null>(null);
  const [itemDialogType, setItemDialogType] = useState<NomenclatureType>("FASTENER");

  const q = search.trim().toLowerCase();
  const matchesSearch = (text: string) => !q || text.toLowerCase().includes(q);
  const visible = (status: "ACTIVE" | "ARCHIVED") => showArchive || status !== "ARCHIVED";

  const productRows = products.filter(
    (p) => visible(p.status) && matchesSearch(`${p.name} ${p.sku}`),
  );
  const detailRows = details.filter((d) => visible(d.status) && matchesSearch(d.name));
  const itemsByType = (type: NomenclatureType) =>
    items.filter((n) => n.type === type && visible(n.status) && matchesSearch(n.name));
  const fastenerRows = itemsByType("FASTENER");
  const packagingRows = itemsByType("PACKAGING");
  const otherRows = itemsByType("OTHER");

  const upsertProduct = (p: Product) =>
    setProducts((prev) => {
      const i = prev.findIndex((x) => x.id === p.id);
      if (i === -1) return [...prev, p];
      const next = [...prev];
      next[i] = p;
      return next;
    });
  const upsertDetail = (d: Detail) =>
    setDetails((prev) => {
      const i = prev.findIndex((x) => x.id === d.id);
      if (i === -1) return [...prev, d];
      const next = [...prev];
      next[i] = d;
      return next;
    });
  const upsertItem = (n: NomenclatureItem) =>
    setItems((prev) => {
      const i = prev.findIndex((x) => x.id === n.id);
      if (i === -1) return [...prev, n];
      const next = [...prev];
      next[i] = n;
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

  const submitDialog = <T,>(
    fn: () => Promise<T>,
    apply: (res: T) => void,
    ok: string,
    close: () => void,
  ) =>
    new Promise<void>((resolve) => {
      startTransition(async () => {
        try {
          apply(await fn());
          toast.success(ok);
          close();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Ошибка сохранения");
        } finally {
          resolve();
        }
      });
    });

  const handleProductSubmit = (values: ProductFormValues) =>
    submitDialog(
      () => (editingProduct ? updateProduct(editingProduct.id, values) : createProduct(values)),
      upsertProduct,
      editingProduct ? "Изделие сохранено" : "Изделие создано",
      () => setProductDialogOpen(false),
    );

  const handleDetailSubmit = (values: DetailFormValues) =>
    submitDialog(
      () => (editingDetail ? updateDetail(editingDetail.id, values) : createDetail(values)),
      upsertDetail,
      editingDetail ? "Деталь сохранена" : "Деталь создана",
      () => setDetailDialogOpen(false),
    );

  const handleItemSubmit = (values: NomenclatureItemFormValues) =>
    submitDialog(
      () => (editingItem ? updateNomenclatureItem(editingItem.id, values) : createNomenclatureItem(values)),
      upsertItem,
      editingItem ? "Позиция сохранена" : "Позиция создана",
      () => setItemDialogOpen(false),
    );

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
          onArchive={() => runRow(() => archiveProduct(row.id).then(upsertProduct), "Перенесено в архив")}
          onRestore={() => runRow(() => restoreProduct(row.id).then(upsertProduct), "Восстановлено")}
          onDelete={() =>
            runRow(
              () => deleteProduct(row.id).then(() => setProducts((p) => p.filter((x) => x.id !== row.id))),
              "Изделие удалено",
            )
          }
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
          onArchive={() => runRow(() => archiveDetail(row.id).then(upsertDetail), "Перенесено в архив")}
          onRestore={() => runRow(() => restoreDetail(row.id).then(upsertDetail), "Восстановлено")}
          onDelete={() =>
            runRow(
              () => deleteDetail(row.id).then(() => setDetails((p) => p.filter((x) => x.id !== row.id))),
              "Деталь удалена",
            )
          }
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
          onArchive={() =>
            runRow(() => archiveNomenclatureItem(row.id).then(upsertItem), "Перенесено в архив")
          }
          onRestore={() =>
            runRow(() => restoreNomenclatureItem(row.id).then(upsertItem), "Восстановлено")
          }
          onDelete={() =>
            runRow(
              () => deleteNomenclatureItem(row.id).then(() => setItems((p) => p.filter((x) => x.id !== row.id))),
              "Позиция удалена",
            )
          }
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
          actionLabel="Найти"
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
        details={details.filter((d) => d.status === "ACTIVE")}
        items={items}
        onOpenChange={setProductDialogOpen}
        onSubmit={handleProductSubmit}
        pending={pending}
      />

      <DetailFormDialog
        open={detailDialogOpen}
        detail={editingDetail}
        onOpenChange={setDetailDialogOpen}
        onSubmit={handleDetailSubmit}
        pending={pending}
      />

      <NomenclatureItemFormDialog
        open={itemDialogOpen}
        type={itemDialogType}
        item={editingItem}
        onOpenChange={setItemDialogOpen}
        onSubmit={handleItemSubmit}
        pending={pending}
      />
    </>
  );
}
