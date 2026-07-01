"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { syncMarketplaces, type SalesData } from "@/server/marketplace";
import type { SalesReportRow } from "@/mocks/report-fixtures";
import { formatMoney, formatIsoDateTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { KpiTile } from "@/components/kpi-tile";
import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";

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

export function SalesView({ data }: { data: SalesData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const handleSync = () => {
    startTransition(async () => {
      const res = await syncMarketplaces();
      if (res.ok) {
        toast.success(
          `Синхронизация: +${res.salesAdded} продаж, +${res.suppliesAdded} поставок, остатки обновлены`,
        );
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

        <Card className="surface-card ring-0">
          <CardContent className="p-0">
            <DataTable
              columns={columns}
              rows={data.rows}
              empty="Продаж нет — нажмите «Синхронизировать с МП»"
              padded
              className="border-0"
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
