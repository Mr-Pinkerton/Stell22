"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  costDetailRows,
  costProductRows,
  type CostDetailRow,
  type CostProductRow,
} from "@/mocks/report-fixtures";
import { formatLength, formatMoney } from "@/lib/format";
import { SegmentTabs } from "@/components/reports/report-shared";
import { DataTable, type Column } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type CostSubTab = "details" | "products";

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
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "Изделие",
                  "Материал",
                  "Работа",
                  "Прямая",
                  "Накладные",
                  "Полная",
                  "",
                ].map((h, i) => (
                  <TableHead
                    key={h || "exp"}
                    className={cn(
                      "bg-card text-base font-semibold h-11 px-4 first:pl-5 last:pr-5",
                      i > 0 && "text-center",
                    )}
                  >
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {costProductRows.map((row, index) => {
                const expanded = expandedId === row.id;
                return (
                  <ProductCostRows
                    key={row.id}
                    row={row}
                    expanded={expanded}
                    striped={index % 2 === 1}
                    onToggle={() => setExpandedId(expanded ? null : row.id)}
                  />
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function ProductCostRows({
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
    <>
      <TableRow
        className={cn(
          "cursor-pointer",
          striped && "bg-muted/40",
          expanded && "bg-muted/30",
        )}
        onClick={onToggle}
      >
        <TableCell className="px-5 py-3">
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronDown className="text-muted-foreground size-4 shrink-0" />
            ) : (
              <ChevronRight className="text-muted-foreground size-4 shrink-0" />
            )}
            <div>
              <p className="font-medium">{row.name}</p>
              <p className="text-muted-foreground text-xs">{row.sku}</p>
            </div>
          </div>
        </TableCell>
        <TableCell className="text-center tabular-nums">
          {moneyWithPct(row.material, row.materialPct)}
        </TableCell>
        <TableCell className="text-center tabular-nums">
          {moneyWithPct(row.work, row.workPct)}
        </TableCell>
        <TableCell className="text-center tabular-nums">
          {moneyWithPct(row.direct, row.directPct)}
        </TableCell>
        <TableCell className="text-center tabular-nums">
          {moneyWithPct(row.overhead, row.overheadPct)}
        </TableCell>
        <TableCell className="text-center font-semibold tabular-nums">
          {formatMoney(row.full)}
        </TableCell>
        <TableCell className="w-8" />
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={7} className="px-5 py-4">
            <p className="mb-3 text-sm font-semibold">Детализация по деталям</p>
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Деталь</TableHead>
                    <TableHead className="text-center">Длина</TableHead>
                    <TableHead className="text-center">Кол-во</TableHead>
                    <TableHead className="text-center">Материал</TableHead>
                    <TableHead className="text-center">Работа</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {row.details.map((d) => (
                    <TableRow key={`${row.id}-${d.detailName}`}>
                      <TableCell className="font-medium">{d.detailName}</TableCell>
                      <TableCell className="text-center tabular-nums">
                        {formatLength(d.lengthM)}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">{d.quantity}</TableCell>
                      <TableCell className="text-center tabular-nums">
                        {formatMoney(d.materialCost)}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {formatMoney(d.workCost)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
