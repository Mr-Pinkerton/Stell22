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
import { exportXlsx } from "@/lib/export-xlsx";
import {
  dataTableArchivedRowClass,
  partitionActiveArchived,
} from "@/lib/table-archive";
import { XLSX_FMT, type XlsxSheet } from "@/lib/xlsx-types";
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
import { ProductsTable } from "@/components/nomenclature/products-table";
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
  const archived = status === "ARCHIVED";
  return (
    <Badge
      variant={status === "ACTIVE" ? "secondary" : "outline"}
      className={archived ? "opacity-80" : undefined}
    >
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
  const [exporting, startExport] = useTransition();

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

  const productRows = partitionActiveArchived(
    products.filter((p) => visible(p.status) && matchesSearch(`${p.name} ${p.skuOzon} ${p.skuWb}`)),
    (p) => p.status === "ARCHIVED",
  );
  const detailRows = partitionActiveArchived(
    details.filter((d) => visible(d.status) && matchesSearch(`${d.detailNumber} ${d.name}`)),
    (d) => d.status === "ARCHIVED",
  );
  const itemsByType = (type: NomenclatureType) =>
    partitionActiveArchived(
      items.filter((n) => n.type === type && visible(n.status) && matchesSearch(n.name)),
      (n) => n.status === "ARCHIVED",
    );
  const fastenerRows = itemsByType("FASTENER");
  const packagingRows = itemsByType("PACKAGING");
  const otherRows = itemsByType("OTHER");

  const statusText = (s: "ACTIVE" | "ARCHIVED") => (s === "ACTIVE" ? "Активен" : "Архив");

  const archivedRowClass = <T extends { status: "ACTIVE" | "ARCHIVED" }>(row: T, index: number) =>
    dataTableArchivedRowClass(row, index, (r) => r.status === "ARCHIVED");

  const buildExportSheet = (): XlsxSheet => {
    if (activeTab === "products") {
      return {
        name: "Изделия",
        columns: [
          { header: "Название", key: "name", width: 28 },
          { header: "Артикул Ozon", key: "skuOzon", width: 16 },
          { header: "Артикул WB", key: "skuWb", width: 16 },
          { header: "Сорт", key: "sort", width: 12 },
          { header: "Детали, шт", key: "details", numFmt: XLSX_FMT.int },
          { header: "Статус", key: "status", width: 14 },
        ],
        rows: productRows.map((p) => ({
          name: p.name,
          skuOzon: p.skuOzon,
          skuWb: p.skuWb,
          sort: SORT_SHORT[p.sort],
          details: p.details.reduce((sum, d) => sum + d.quantity, 0),
          status: statusText(p.status),
        })),
      };
    }
    if (activeTab === "details") {
      return {
        name: "Детали",
        columns: [
          { header: "Название", key: "name", width: 28 },
          { header: "Номер", key: "number", numFmt: XLSX_FMT.int },
          { header: "Длина", key: "length", numFmt: XLSX_FMT.length },
          { header: "Тип", key: "type", width: 14 },
          { header: "Присадка", key: "prisadka", width: 24 },
          { header: "Сорт", key: "sort", width: 12 },
          { header: "Статус", key: "status", width: 14 },
        ],
        rows: detailRows.map((d) => ({
          name: d.name,
          number: d.detailNumber,
          length: d.lengthM,
          type: RAIL_TYPE_LABEL[d.detailType],
          prisadka: formatPrisadka(d),
          sort: SORT_SHORT[d.sort],
          status: statusText(d.status),
        })),
      };
    }
    const labelByTab: Record<"fasteners" | "packaging" | "other", string> = {
      fasteners: "Крепёж",
      packaging: "Упаковка",
      other: "Разное",
    };
    const itemRows = (
      activeTab === "fasteners" ? fastenerRows : activeTab === "packaging" ? packagingRows : otherRows
    ) as NomenclatureItem[];
    return {
      name: labelByTab[activeTab as "fasteners" | "packaging" | "other"],
      columns: [
        { header: "Название", key: "name", width: 28 },
        { header: "Цена за ед.", key: "unitPrice", numFmt: XLSX_FMT.money },
        { header: "Статус", key: "status", width: 14 },
      ],
      rows: itemRows.map((n) => ({
        name: n.name,
        unitPrice: n.unitPrice,
        status: statusText(n.status),
      })),
    };
  };

  const handleExport = () =>
    startExport(async () => {
      try {
        const sheet = buildExportSheet();
        await exportXlsx(`номенклатура-${sheet.name.toLowerCase()}`, [sheet]);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Не удалось выгрузить");
      }
    });

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

  const renderProductActions = (row: Product) => (
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
  );

  const detailColumns: Column<Detail>[] = [
    {
      key: "name",
      header: "Название",
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "detailNumber",
      header: "Номер",
      className: "w-16",
      render: (row) => (
        <span className="bg-muted inline-flex size-7 items-center justify-center rounded-md text-sm font-semibold tabular-nums">
          {row.detailNumber}
        </span>
      ),
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
        exporting={exporting}
        addLabel={ADD_LABELS[activeTab]}
        onAdd={openCreate}
        onExport={handleExport}
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

        <Card className="surface-card ring-0 overflow-hidden">
          <CardContent className="p-0">
            {activeTab === "products" && (
              <ProductsTable
                rows={productRows}
                details={details}
                items={items}
                empty={emptyByTab.products}
                renderActions={renderProductActions}
              />
            )}
            {activeTab === "details" && (
              <DataTable
                columns={detailColumns}
                rows={detailRows}
                empty={emptyByTab.details}
                className="border-0"
                padded
                rowClassName={archivedRowClass}
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
                rowClassName={archivedRowClass}
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
