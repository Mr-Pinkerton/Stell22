"use client";

import { useState } from "react";
import {
  type AppSettings,
  type MinStockRow,
  type SystemLogRow,
} from "@/mocks/settings-fixtures";
import type { ApiCredentialValues } from "@/lib/api-credentials";
import { PageHeader } from "@/components/page-header";
import { SegmentTabs } from "@/components/reports/report-shared";
import { SettingsApiTab } from "@/components/settings/settings-api-tab";
import { SettingsLogsTab } from "@/components/settings/settings-logs-tab";
import { SettingsParamsTab } from "@/components/settings/settings-params-tab";

type SettingsTab = "api" | "logs" | "params";

const TABS: { key: SettingsTab; label: string }[] = [
  { key: "api", label: "API-ключи" },
  { key: "logs", label: "Логи" },
  { key: "params", label: "Параметры" },
];

export function SettingsView({
  logs,
  apiCredentials,
  appSettings,
  minStock: initialMinStock,
}: {
  logs: SystemLogRow[];
  apiCredentials: ApiCredentialValues;
  appSettings: AppSettings;
  minStock: MinStockRow[];
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("params");
  const [settings, setSettings] = useState<AppSettings>(appSettings);
  const [minStock, setMinStock] = useState<MinStockRow[]>(initialMinStock);

  return (
    <>
      <PageHeader title="Настройки" />

      <div className="space-y-4">
        <SegmentTabs
          ariaLabel="Настройки"
          tabs={TABS}
          value={activeTab}
          onChange={setActiveTab}
        />

        {activeTab === "api" && <SettingsApiTab initialValues={apiCredentials} />}
        {activeTab === "logs" && <SettingsLogsTab rows={logs} />}
        {activeTab === "params" && (
          <SettingsParamsTab
            settings={settings}
            onSettingsChange={setSettings}
            minStock={minStock}
            onMinStockChange={setMinStock}
          />
        )}
      </div>
    </>
  );
}
