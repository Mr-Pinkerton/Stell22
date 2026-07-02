"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { SegmentTabs } from "@/components/reports/report-shared";
import { ReportPurchasesTab } from "@/components/reports/report-purchases-tab";
import { ReportCostTab } from "@/components/reports/report-cost-tab";
import { ReportSalariesTab } from "@/components/reports/report-salaries-tab";
import { ReportWasteTab } from "@/components/reports/report-waste-tab";
import { ReportSalesTab } from "@/components/reports/report-sales-tab";
import { exportXlsx } from "@/lib/export-xlsx";
import { XLSX_FMT } from "@/lib/xlsx-types";
import { formatIsoDate } from "@/lib/format";
import type { CostReport } from "@/server/cost";
import type { WasteReport } from "@/server/reports";
import type { PurchaseReportRow, SalaryReportRow, SalesReportRow } from "@/mocks/report-fixtures";

const statusLabel = (s: "IN_WORK" | "ARCHIVED") => (s === "IN_WORK" ? "В работе" : "Архив");
const sortPctText = (p: { sort1: number; sort2: number }) => `${p.sort1}% / ${p.sort2}%`;

type ReportTab = "purchases" | "cost" | "salaries" | "waste" | "sales";

const TABS: { key: ReportTab; label: string }[] = [
  { key: "purchases", label: "Закупки" },
  { key: "cost", label: "Себестоимость" },
  { key: "salaries", label: "Зарплаты" },
  { key: "waste", label: "Процент отхода" },
  { key: "sales", label: "Продажи" },
];

const TAB_FILTERS: Record<
  ReportTab,
  { date?: boolean; weeks?: boolean; archive?: boolean }
> = {
  purchases: { date: true },
  cost: { date: true },
  salaries: { date: true, weeks: true },
  waste: { date: true },
  sales: { date: true },
};

export function ReportsView({
  cost,
  salary,
  purchases,
  waste,
  sales,
}: {
  cost: CostReport;
  salary: SalaryReportRow[];
  purchases: PurchaseReportRow[];
  waste: WasteReport;
  sales: SalesReportRow[];
}) {
  const [activeTab, setActiveTab] = useState<ReportTab>("purchases");
  const [exporting, startExport] = useTransition();

  const filters = TAB_FILTERS[activeTab];

  const handleExport = () =>
    startExport(async () => {
      try {
        const purchaseRows = purchases;
        const wasteBatchRows = waste.batches;
        await exportXlsx("отчёты", [
          {
            name: "Закупки",
            columns: [
              { header: "Партия", key: "name", width: 28 },
              { header: "Дата", key: "date", width: 14 },
              { header: "Стоимость", key: "totalCost", numFmt: XLSX_FMT.money },
              { header: "Объём", key: "volume", numFmt: XLSX_FMT.volume, width: 16 },
              { header: "Сорта закупка", key: "sortPurchase", width: 16 },
              { header: "Сорта факт", key: "sortFact", width: 16 },
              { header: "₽/м³", key: "perM3", numFmt: XLSX_FMT.money },
              { header: "Статус", key: "status" },
            ],
            rows: purchaseRows.map((r) => ({
              name: r.name,
              date: formatIsoDate(r.purchaseDate),
              totalCost: r.totalCost,
              volume: r.volumeM3,
              sortPurchase: sortPctText(r.sortPurchasePct),
              sortFact: sortPctText(r.sortFactPct),
              perM3: r.avgCostPerM3,
              status: statusLabel(r.status),
            })),
          },
          {
            name: "Себестоимость (детали)",
            columns: [
              { header: "Деталь", key: "name", width: 28 },
              { header: "Партия", key: "batchName", width: 24 },
              { header: "Работа", key: "workCost", numFmt: XLSX_FMT.money },
              { header: "Материал", key: "materialCost", numFmt: XLSX_FMT.money },
              { header: "Статус", key: "status" },
            ],
            rows: cost.details.map((r) => ({
              name: r.name,
              batchName: r.batchName,
              workCost: r.workCost,
              materialCost: r.materialCost,
              status: r.costStatus === "PRELIMINARY" ? "Предварительно" : "Итог",
            })),
          },
          {
            name: "Себестоимость (изделия)",
            columns: [
              { header: "Изделие", key: "name", width: 28 },
              { header: "Артикул", key: "sku" },
              { header: "Материал", key: "material", numFmt: XLSX_FMT.money },
              { header: "Работа", key: "work", numFmt: XLSX_FMT.money },
              { header: "Прямая", key: "direct", numFmt: XLSX_FMT.money },
              { header: "Накладные", key: "overhead", numFmt: XLSX_FMT.money },
              { header: "Полная", key: "full", numFmt: XLSX_FMT.money },
            ],
            rows: cost.products.map((r) => ({
              name: r.name,
              sku: r.sku,
              material: r.material,
              work: r.work,
              direct: r.direct,
              overhead: r.overhead,
              full: r.full,
            })),
          },
          {
            name: "Зарплаты",
            columns: [
              { header: "Сотрудник", key: "employeeName", width: 28 },
              { header: "К выплате", key: "amountDue", numFmt: XLSX_FMT.money },
              { header: "Произведено", key: "produced", numFmt: XLSX_FMT.int },
              { header: "В среднем", key: "avgPerUnit", numFmt: XLSX_FMT.money },
              { header: "Итого", key: "total", numFmt: XLSX_FMT.money },
              { header: "Статус", key: "status" },
              { header: "Выплачено", key: "paidAt", width: 14 },
            ],
            rows: salary.map((r) => ({
              employeeName: r.employeeName,
              amountDue: r.amountDue,
              produced: r.produced,
              avgPerUnit: r.avgPerUnit,
              total: r.total,
              status: r.paid ? "Выплачено" : "Не выплачено",
              paidAt: r.paidAt ? formatIsoDate(r.paidAt) : "",
            })),
          },
          {
            name: "Отход (партии)",
            columns: [
              { header: "Партия", key: "batchName", width: 28 },
              { header: "Закуплено", key: "purchasedM", numFmt: XLSX_FMT.length },
              { header: "Взято", key: "takenM", numFmt: XLSX_FMT.length },
              { header: "Остаток", key: "remainingM", numFmt: XLSX_FMT.length },
              { header: "Отходы торц.", key: "wasteTorcovkaM", numFmt: XLSX_FMT.length },
              { header: "Списано", key: "writtenOffM", numFmt: XLSX_FMT.length },
              { header: "% отхода", key: "wastePct", numFmt: XLSX_FMT.pct },
              { header: "Статус", key: "status" },
            ],
            rows: wasteBatchRows.map((r) => ({
              batchName: r.batchName,
              purchasedM: r.purchasedM,
              takenM: r.takenM,
              remainingM: r.remainingM,
              wasteTorcovkaM: r.wasteTorcovkaM,
              writtenOffM: r.writtenOffM,
              wastePct: r.wastePct,
              status: statusLabel(r.status),
            })),
          },
          {
            name: "Отход (работники)",
            columns: [
              { header: "Работник", key: "employeeName", width: 28 },
              { header: "Взято", key: "takenM", numFmt: XLSX_FMT.length },
              { header: "Произведено", key: "producedM", numFmt: XLSX_FMT.length },
              { header: "Отходы", key: "wasteM", numFmt: XLSX_FMT.length },
              { header: "% отхода", key: "wastePct", numFmt: XLSX_FMT.pct },
            ],
            rows: waste.employees.map((r) => ({
              employeeName: r.employeeName,
              takenM: r.takenM,
              producedM: r.producedM,
              wasteM: r.wasteM,
              wastePct: r.wastePct,
            })),
          },
          {
            name: "Продажи",
            columns: [
              { header: "Изделие", key: "productName", width: 28 },
              { header: "Артикул", key: "sku" },
              { header: "Продано", key: "soldQty", numFmt: XLSX_FMT.int },
              { header: "Выручка", key: "revenue", numFmt: XLSX_FMT.money },
            ],
            rows: sales.map((r) => ({
              productName: r.productName,
              sku: r.sku,
              soldQty: r.soldQty,
              revenue: r.revenue,
            })),
          },
        ]);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Не удалось выгрузить отчёт");
      }
    });

  return (
    <>
      <PageHeader title="Отчёты" canExport exporting={exporting} onExport={handleExport} />

      <div className="space-y-4">
        <FiltersBar
          date={filters.date}
          dateAllTime={filters.date}
          weeks={filters.weeks}
          actionLabel={activeTab === "purchases" ? "Применить" : "Показать"}
        />

        <SegmentTabs
          ariaLabel="Раздел отчётов"
          tabs={TABS}
          value={activeTab}
          onChange={setActiveTab}
        />

        {activeTab === "purchases" && <ReportPurchasesTab initialRows={purchases} />}
        {activeTab === "cost" && <ReportCostTab details={cost.details} products={cost.products} />}
        {activeTab === "salaries" && <ReportSalariesTab initialRows={salary} />}
        {activeTab === "waste" && (
          <ReportWasteTab batches={waste.batches} employees={waste.employees} />
        )}
        {activeTab === "sales" && <ReportSalesTab rows={sales} />}
      </div>
    </>
  );
}
