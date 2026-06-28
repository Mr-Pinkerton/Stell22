"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  costDetailRows,
  costProductRows,
  type CostDetailRow,
  type CostProductRow,
} from "@/mocks/report-fixtures";
import { formatLength, formatMoney } from "@/lib/format";
import {
  ExpandableDetailRow,
  ExpandableMainHeader,
  ExpandableReportTable,
  NestedTable,
  NestedTableCell,
  expandableChevronClass,
  expandableColWidths6,
  expandableNestedWrapClass,
  expandableSummaryBorderClass,
  expandableSummaryCellClass,
} from "@/components/reports/expandable-table";
import { SegmentTabs } from "@/components/reports/report-shared";
import { DataTable, type Column } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";

type CostSubTab = "details" | "products";

const PRODUCT_HEADERS = [
  "Изделие",
  "Материал",
  "Работа",
  "Прямая",
  "Накладные",
  "Полная",
] as const;

const PRODUCT_DETAIL_HEADERS = ["Деталь", "Длина", "Кол-во", "Материал", "Работа"];

function costStatusBadge(status: CostDetailRow["costStatus"]) {
  return (
    <Badge variant={status === "PRELIMINARY" ? "secondary" : "outline"}>
      {status === "PRELIMINARY" ? "Предварительно" : "Итог"}
    </Badge>
  );
}

function moneyWithPct(value: number, pct: number) {
  return (
    <span className="tabular-nums">
      {formatMoney(value)}
      <span className="text-muted-foreground ml-1 text-xs">({pct}%)</span>
    </span>
  );
}

export function ReportCostTab() {
  const [subTab, setSubTab] = useState<CostSubTab>("details");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const detailColumns: Column<CostDetailRow>[] = [
    {
      key: "name",
      header: "Деталь",
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "batchName",
      header: "Партия",
      render: (row) => row.batchName,
    },
    {
      key: "workCost",
      header: "Работа",
      className: "tabular-nums",
      render: (row) => formatMoney(row.workCost),
    },
    {
      key: "materialCost",
      header: "Материал",
      className: "tabular-nums",
      render: (row) => formatMoney(row.materialCost),
    },
    {
      key: "costStatus",
      header: "Статус",
      render: (row) => costStatusBadge(row.costStatus),
    },
  ];

  return (
    <div className="space-y-4">
      <SegmentTabs
        ariaLabel="Себестоимость"
        tabs={[
          { key: "details", label: "Детали" },
          { key: "products", label: "Изделия" },
        ]}
        value={subTab}
        onChange={setSubTab}
      />

      {subTab === "details" ? (
        <Card className="surface-card ring-0">
          <CardContent className="p-0">
            <DataTable
              columns={detailColumns}
              rows={costDetailRows}
              empty="Детали за период не найдены"
              className="border-0"
              padded
            />
          </CardContent>
        </Card>
      ) : (
        <Card className="surface-card ring-0 overflow-hidden">
          <ExpandableReportTable
            widths={expandableColWidths6}
            header={
              <ExpandableMainHeader labels={PRODUCT_HEADERS} />
            }
          >
            {costProductRows.map((row, index) => {
              const expanded = expandedId === row.id;
              return (
                <ProductCostRowGroup
                  key={row.id}
                  row={row}
                  expanded={expanded}
                  striped={index % 2 === 1}
                  onToggle={() => setExpandedId(expanded ? null : row.id)}
                />
              );
            })}
          </ExpandableReportTable>
        </Card>
      )}
    </div>
  );
}

function ProductCostRowGroup({
  row,
  expanded,
  striped,
  onToggle,
}: {
  row: CostProductRow;
  expanded: boolean;
  striped: boolean;
  onToggle: () => void;
}) {
  return (
    <Fragment>
      <TableRow
        className={cn(
          "cursor-pointer align-top",
          striped && "bg-muted/40",
          expanded && "bg-muted/35",
          "hover:bg-muted/50",
          expanded && expandableSummaryBorderClass,
        )}
        onClick={onToggle}
      >
        <TableCell className={expandableSummaryCellClass}>
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className={expandableChevronClass} />
            ) : (
              <ChevronRight className={expandableChevronClass} />
            )}
            <div className="min-w-0">
              <p className="truncate font-medium">{row.name}</p>
              <p className="text-muted-foreground truncate text-xs">{row.sku}</p>
            </div>
          </div>
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
          {moneyWithPct(row.material, row.materialPct)}
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
          {moneyWithPct(row.work, row.workPct)}
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
          {moneyWithPct(row.direct, row.directPct)}
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center tabular-nums")}>
          {moneyWithPct(row.overhead, row.overheadPct)}
        </TableCell>
        <TableCell className={cn(expandableSummaryCellClass, "text-center font-semibold tabular-nums")}>
          {formatMoney(row.full)}
        </TableCell>
      </TableRow>
      {expanded && (
        <ExpandableDetailRow colSpan={6} className={cn(striped && "bg-muted/40", "bg-muted/35")}>
          <div className={expandableNestedWrapClass}>
            <NestedTable headers={PRODUCT_DETAIL_HEADERS} isEmpty={row.details.length === 0}>
              {row.details.map((d) => (
                <TableRow key={`${row.id}-${d.detailName}`}>
                  <NestedTableCell className="font-medium">{d.detailName}</NestedTableCell>
                  <NestedTableCell className="text-center tabular-nums">
                    {formatLength(d.lengthM)}
                  </NestedTableCell>
                  <NestedTableCell className="text-center tabular-nums">{d.quantity}</NestedTableCell>
                  <NestedTableCell className="text-center tabular-nums">
                    {formatMoney(d.materialCost)}
                  </NestedTableCell>
                  <NestedTableCell className="text-center tabular-nums">
                    {formatMoney(d.workCost)}
                  </NestedTableCell>
                </TableRow>
              ))}
            </NestedTable>
          </div>
        </ExpandableDetailRow>
      )}
    </Fragment>
  );
}
