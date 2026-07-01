"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  purchaseReportKpis,
  type PurchasePackageLine,
  type PurchaseReportRow,
} from "@/mocks/report-fixtures";
import { formatIsoDate, formatLength, formatMoney, formatVolume } from "@/lib/format";
import { partitionActiveArchived, expandableArchivedSummaryRowClass } from "@/lib/table-archive";
import {
  ExpandableDetailRow,
  ExpandableMainHeader,
  ExpandableReportTable,
  NestedTable,
  NestedTableCell,
  expandableChevronClass,
  expandableColWidths8,
  expandableExpandedAccentClass,
  expandableExpandedChevronClass,
  expandableNestedWrapExpandedClass,
  expandableSummaryCellClass,
} from "@/components/reports/expandable-table";
import { KpiTile } from "@/components/kpi-tile";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import type { RailType, Sort } from "@/types/domain";

interface ReportPurchasesTabProps {
  showArchive: boolean;
  initialRows: PurchaseReportRow[];
}

const RAIL_TYPE_LABEL: Record<RailType, string> = {
  POLKA: "Полка",
  KANAVKA: "Канавка",
};

const SORT_LABEL: Record<Sort, string> = {
  SORT1: "1 сорт",
  SORT2: "2 сорт",
};

const PURCHASE_HEADERS = [
  "Партия",
  "Дата",
  "Стоимость",
  "Объём",
  "Сорта закупка",
  "Сорта факт",
  "₽/м³",
  "Статус",
] as const;

const PACKAGE_HEADERS = [
  "Пакет / рейки",
  "Длина",
  "Объём",
  "Тип",
  "Сорт",
  "Кол-во",
  "Остаток",
  "Работник",
];

function sortPct(p: { sort1: number; sort2: number }) {
  return `${p.sort1}% / ${p.sort2}%`;
}

function packageTitle(pkg: PurchasePackageLine) {
  if (pkg.isPackage && pkg.code) return `Пакет ${pkg.code}`;
  return "Поштучно";
}

export function ReportPurchasesTab({ showArchive, initialRows }: ReportPurchasesTabProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const filtered = initialRows.filter((r) => showArchive || r.status !== "ARCHIVED");
    return partitionActiveArchived(filtered, (r) => r.status === "ARCHIVED");
  }, [showArchive, initialRows]);

  const kpis = useMemo(() => purchaseReportKpis(rows), [rows]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile title="Всего партий" value={String(kpis.batchCount)} />
        <KpiTile title="Общая сумма" value={formatMoney(kpis.totalCost)} />
        <KpiTile title="Общий объём" value={formatVolume(kpis.totalVolume)} />
        <KpiTile title="Средняя стоимость за куб" value={formatMoney(kpis.avgCostPerM3)} />
      </div>

      <Card className="surface-card ring-0 overflow-hidden">
        {rows.length === 0 ? (
          <p className="text-muted-foreground px-6 py-12 text-center">
            Партии за период не найдены
          </p>
        ) : (
          <ExpandableReportTable
            widths={expandableColWidths8}
            header={
              <ExpandableMainHeader labels={PURCHASE_HEADERS} />
            }
          >
            {rows.map((row, index) => {
              const archived = row.status === "ARCHIVED";
              const expanded = expandedId === row.id;
              return (
                <Fragment key={row.id}>
                  <BatchSummaryRow
                    row={row}
                    archived={archived}
                    expanded={expanded}
                    striped={index % 2 === 1}
                    onToggle={() => setExpandedId(expanded ? null : row.id)}
                  />
                  {expanded && (
                    <ExpandableDetailRow colSpan={8}>
                      <div className={expandableNestedWrapExpandedClass}>
                        <NestedTable
                          headers={PACKAGE_HEADERS}
                          empty="Нет пакетов в партии"
                          isEmpty={row.packages.length === 0}
                        >
                          {row.packages.map((pkg) => (
                            <TableRow key={pkg.id}>
                              <NestedTableCell className="font-medium">
                                {packageTitle(pkg)}
                              </NestedTableCell>
                              <NestedTableCell className="text-center tabular-nums">
                                {formatLength(pkg.lengthM)}
                              </NestedTableCell>
                              <NestedTableCell className="text-center tabular-nums">
                                {formatVolume(pkg.volumeM3)}
                              </NestedTableCell>
                              <NestedTableCell className="text-center">
                                {RAIL_TYPE_LABEL[pkg.railType]}
                              </NestedTableCell>
                              <NestedTableCell className="text-center">
                                {SORT_LABEL[pkg.sort]}
                              </NestedTableCell>
                              <NestedTableCell className="text-center tabular-nums">
                                {pkg.quantity} шт
                              </NestedTableCell>
                              <NestedTableCell className="text-center tabular-nums">
                                {pkg.remainingQuantity} шт
                              </NestedTableCell>
                              <NestedTableCell className="text-center text-sm">
                                {pkg.workerName}
                              </NestedTableCell>
                            </TableRow>
                          ))}
                        </NestedTable>
                      </div>
                    </ExpandableDetailRow>
                  )}
                </Fragment>
              );
            })}
          </ExpandableReportTable>
        )}
      </Card>
    </div>
  );
}

function BatchSummaryRow({
  row,
  archived,
  expanded,
  striped,
  onToggle,
}: {
  row: PurchaseReportRow;
  archived: boolean;
  expanded: boolean;
  striped: boolean;
  onToggle: () => void;
}) {
  return (
    <TableRow
      className={cn(
        "group cursor-pointer align-top",
        expandableArchivedSummaryRowClass({ archived, expanded, striped }),
      )}
      onClick={onToggle}
    >
      <TableCell className={cn(expandableSummaryCellClass, expanded && expandableExpandedAccentClass)}>
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className={cn(expandableChevronClass, expandableExpandedChevronClass)} />
          ) : (
            <ChevronRight className={expandableChevronClass} />
          )}
          <span className={cn("font-medium", archived && "font-normal")}>{row.name}</span>
        </div>
      </TableCell>
      <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
        {formatIsoDate(row.purchaseDate)}
      </TableCell>
      <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
        {formatMoney(row.totalCost)}
      </TableCell>
      <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
        {formatVolume(row.volumeM3)}
      </TableCell>
      <TableCell className={cn(expandableSummaryCellClass, "text-center text-xs tabular-nums")}>
        {sortPct(row.sortPurchasePct)}
      </TableCell>
      <TableCell className={cn(expandableSummaryCellClass, "text-center text-xs tabular-nums")}>
        {sortPct(row.sortFactPct)}
      </TableCell>
      <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
        {formatMoney(row.avgCostPerM3)}
      </TableCell>
      <TableCell className={cn(expandableSummaryCellClass, "text-center")}>
        <Badge
          variant={row.status === "IN_WORK" ? "secondary" : "outline"}
          className={archived ? "opacity-80" : undefined}
        >
          {row.status === "IN_WORK" ? "В работе" : "Архив"}
        </Badge>
      </TableCell>
    </TableRow>
  );
}
