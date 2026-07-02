"use client";

import { useMemo, useState } from "react";
import type { WasteBatchRow, WasteEmployeeRow } from "@/mocks/report-fixtures";
import { formatLength } from "@/lib/format";
import { partitionActiveArchived } from "@/lib/table-archive";
import { SegmentTabs, wastePercentClass } from "@/components/reports/report-shared";
import { DataTable, type Column } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

type WasteSubTab = "batches" | "employees";

interface ReportWasteTabProps {
  batches: WasteBatchRow[];
  employees: WasteEmployeeRow[];
}

export function ReportWasteTab({ batches, employees }: ReportWasteTabProps) {
  const [subTab, setSubTab] = useState<WasteSubTab>("batches");

  const batchRows = useMemo(
    () => partitionActiveArchived(batches, (r) => r.status === "ARCHIVED"),
    [batches],
  );

  const batchColumns: Column<WasteBatchRow>[] = [
    {
      key: "batchName",
      header: "Партия",
      render: (row) => <span className="font-medium">{row.batchName}</span>,
    },
    {
      key: "purchasedM",
      header: "Закуплено",
      className: "tabular-nums",
      render: (row) => formatLength(row.purchasedM),
    },
    {
      key: "takenM",
      header: "Взято",
      className: "tabular-nums",
      render: (row) => formatLength(row.takenM),
    },
    {
      key: "remainingM",
      header: "Остаток",
      className: "tabular-nums",
      render: (row) => formatLength(row.remainingM),
    },
    {
      key: "wasteTorcovkaM",
      header: "Отходы торц.",
      className: "tabular-nums",
      render: (row) => formatLength(row.wasteTorcovkaM),
    },
    {
      key: "writtenOffM",
      header: "Списано",
      className: "tabular-nums",
      render: (row) => formatLength(row.writtenOffM),
    },
    {
      key: "wastePct",
      header: "% отхода",
      className: "tabular-nums",
      render: (row) => (
        <span className={wastePercentClass(row.wastePct)}>{row.wastePct}%</span>
      ),
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
  ];

  const employeeColumns: Column<WasteEmployeeRow>[] = [
    {
      key: "employeeName",
      header: "Работник",
      render: (row) => <span className="font-medium">{row.employeeName}</span>,
    },
    {
      key: "takenM",
      header: "Взято",
      className: "tabular-nums",
      render: (row) => formatLength(row.takenM),
    },
    {
      key: "producedM",
      header: "Произведено",
      className: "tabular-nums",
      render: (row) => formatLength(row.producedM),
    },
    {
      key: "wasteM",
      header: "Отходы",
      className: "tabular-nums",
      render: (row) => formatLength(row.wasteM),
    },
    {
      key: "wastePct",
      header: "% отхода",
      className: "tabular-nums",
      render: (row) => (
        <span className={wastePercentClass(row.wastePct)}>{row.wastePct}%</span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <SegmentTabs
        ariaLabel="Процент отхода"
        tabs={[
          { key: "batches", label: "По партиям" },
          { key: "employees", label: "По работникам" },
        ]}
        value={subTab}
        onChange={setSubTab}
      />

      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          {subTab === "batches" ? (
            <DataTable
              columns={batchColumns}
              rows={batchRows}
              empty="Партии не найдены"
              className="border-0"
              padded
            />
          ) : (
            <DataTable
              columns={employeeColumns}
              rows={employees}
              empty="Данные не найдены"
              className="border-0"
              padded
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
