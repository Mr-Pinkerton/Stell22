"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { syncMarketplaces, type SalesData } from "@/server/marketplace";
import type { SalesReportRow } from "@/mocks/report-fixtures";
import { formatMoney, formatIsoDateTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { KpiTile } from "@/components/kpi-tile";
import { DataTable, type Column } from "@/components/data-table";
import { TableSurface, tableHeaderClassName } from "@/components/table-surface";
import { useAutoApplyPeriod } from "@/components/use-auto-apply-period";
import { filterSalesRows } from "@/lib/sales-table-filters";
import {
  getDefaultSalesDateFilterValue,
  salesAppliedKey,
  salesDraftFromParams,
  salesHrefFromDraft,
  salesPeriodFromParams,
  syncSalesDraftIfAppliedChanged,
} from "@/lib/sales-period";
import { classifyDateFilterCommit } from "@/lib/period-auto-apply";
import type { DateFilterValue } from "@/components/date-filter";

const columns: Column<SalesReportRow>[] = [
  {
    key: "productName",
    header: "Изделие",
    render: (row) => <span className="font-medium">{row.productName}</span>,
  },
  {
    key: "sku",
    header: "Артикул",
    render: (row) => <span className="font-mono text-sm">{row.sku}</span>,
  },
  {
    key: "soldQty",
    header: "Продано",
    className: "tabular-nums",
    render: (row) => `${row.soldQty} шт`,
  },
  {
    key: "revenue",
    header: "Выручка",
    className: "tabular-nums",
    render: (row) => formatMoney(row.revenue),
  },
  {
    key: "avgPrice",
    header: "Средняя цена",
    className: "tabular-nums",
    render: (row) => formatMoney(row.soldQty > 0 ? Math.round(row.revenue / row.soldQty) : 0),
  },
];

function formatSyncedAt(iso: string | null): string {
  if (!iso) return "ещё не синхронизировано";
  return `обновлено ${formatIsoDateTime(iso)}`;
}

const salesDateDefault = getDefaultSalesDateFilterValue();

export function SalesView({ data }: { data: SalesData }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const visibleRows = useMemo(() => filterSalesRows(data.rows, search), [data.rows, search]);

  const appliedParams = new URLSearchParams(searchParams.toString());
  const appliedKey = salesAppliedKey(appliedParams);
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(() =>
    salesDraftFromParams(appliedParams),
  );
  const [syncedAppliedKey, setSyncedAppliedKey] = useState(appliedKey);

  if (appliedKey !== syncedAppliedKey) {
    const next = syncSalesDraftIfAppliedChanged(syncedAppliedKey, appliedParams, dateFilter);
    setSyncedAppliedKey(next.appliedKey);
    setDateFilter(next.dateFilter);
  }

  const commitKind = classifyDateFilterCommit(dateFilter);
  const draftHref =
    commitKind === "incomplete" ? null : salesHrefFromDraft(dateFilter, appliedParams);
  const periodPending = useAutoApplyPeriod(draftHref, appliedKey, commitKind);
  const appliedAllTime = salesPeriodFromParams(appliedParams) === null;

  const handleSync = () => {
    startTransition(async () => {
      const res = await syncMarketplaces();
      if (res.ok) {
        const src = res.sources;
        const mode = src
          ? ` [${src.wb === "api" ? "WB: API" : "WB: демо"}, ${src.ozon === "api" ? "Ozon: API" : "Ozon: демо"}]`
          : "";
        toast.success(
          `Синхронизация: +${res.salesAdded} продаж, +${res.suppliesAdded} поставок, остатки обновлены${mode}`,
        );
        if (res.warnings?.length) toast.warning(res.warnings.join("; "));
        router.refresh();
      } else {
        toast.error(res.error ?? "Ошибка синхронизации");
      }
    });
  };

  return (
    <>
      <PageHeader
        title="Продажи"
        addLabel={pending ? "Синхронизация…" : "Синхронизировать с МП"}
        onAdd={pending ? undefined : handleSync}
      />

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <KpiTile title="Продано" value={`${data.totalQty} шт`} hint={formatSyncedAt(data.lastSyncedAt)} />
          <KpiTile title="Выручка" value={formatMoney(data.totalRevenue)} />
          <KpiTile
            title="Средний чек"
            value={formatMoney(data.totalQty > 0 ? Math.round(data.totalRevenue / data.totalQty) : 0)}
          />
        </div>

        <TableSurface
          filters={
            <FiltersBar
              embedded
              hideSearchLabel
              search
              date
              dateAllTime
              searchPlaceholder="SKU или изделие"
              searchValue={search}
              onSearchChange={setSearch}
              dateFilterValue={dateFilter}
              onDateFilterChange={setDateFilter}
              dateDefaultValue={salesDateDefault}
            />
          }
        >
          {periodPending ? (
            <p role="status" className="text-muted-foreground border-b px-4 py-2 text-sm md:px-5">
              Обновление периода…
            </p>
          ) : null}
          <DataTable
            columns={columns}
            rows={visibleRows}
            empty={
              data.rows.length === 0
                ? appliedAllTime
                  ? "Продаж нет — нажмите «Синхронизировать с МП»"
                  : "Нет продаж за выбранный период"
                : "Нет строк по выбранным фильтрам"
            }
            padded
            className="border-0"
            headerClassName={tableHeaderClassName}
          />
        </TableSurface>
      </div>
    </>
  );
}
