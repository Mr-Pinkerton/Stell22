"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { SegmentTabs } from "@/components/reports/report-shared";
import { ReportPurchasesTab } from "@/components/reports/report-purchases-tab";
import { ReportCostTab } from "@/components/reports/report-cost-tab";
import { ReportSalariesTab } from "@/components/reports/report-salaries-tab";
import { ReportWasteTab } from "@/components/reports/report-waste-tab";
import { ReportSalesTab } from "@/components/reports/report-sales-tab";
import type { CostReport } from "@/server/cost";
import type { SalaryReportRow } from "@/mocks/report-fixtures";

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
  purchases: { date: true, archive: true },
  cost: { date: true },
  salaries: { date: true, weeks: true },
  waste: { date: true, archive: true },
  sales: { date: true },
};

export function ReportsView({ cost, salary }: { cost: CostReport; salary: SalaryReportRow[] }) {
  const [activeTab, setActiveTab] = useState<ReportTab>("purchases");
  const [showArchive, setShowArchive] = useState(false);

  const filters = TAB_FILTERS[activeTab];

  return (
    <>
      <PageHeader
        title="Отчёты"
        canExport
        onExport={() => toast.message("Экспорт — прототип")}
      />

      <div className="space-y-4">
        <FiltersBar
          date={filters.date}
          weeks={filters.weeks}
          archive={filters.archive}
          actionLabel={activeTab === "purchases" ? "Применить" : "Показать"}
          archiveChecked={showArchive}
          onArchiveChange={setShowArchive}
        />

        <SegmentTabs
          ariaLabel="Раздел отчётов"
          tabs={TABS}
          value={activeTab}
          onChange={setActiveTab}
        />

        {activeTab === "purchases" && <ReportPurchasesTab showArchive={showArchive} />}
        {activeTab === "cost" && <ReportCostTab details={cost.details} products={cost.products} />}
        {activeTab === "salaries" && <ReportSalariesTab initialRows={salary} />}
        {activeTab === "waste" && <ReportWasteTab showArchive={showArchive} />}
        {activeTab === "sales" && <ReportSalesTab />}
      </div>
    </>
  );
}
