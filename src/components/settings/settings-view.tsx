"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  defaultAppSettings,
  minStockRows as mockMinStockRows,
  type AppSettings,
  type MinStockRow,
} from "@/mocks/settings-fixtures";
import { financeAccounts, type FinanceAccount } from "@/mocks/finance-fixtures";
import { PageHeader } from "@/components/page-header";
import { SegmentTabs } from "@/components/reports/report-shared";
import { SettingsApiTab } from "@/components/settings/settings-api-tab";
import { SettingsLogsTab } from "@/components/settings/settings-logs-tab";
import { SettingsParamsTab } from "@/components/settings/settings-params-tab";
import { SettingsAccountsTab } from "@/components/settings/settings-accounts-tab";

type SettingsTab = "api" | "logs" | "params" | "accounts";

const TABS: { key: SettingsTab; label: string }[] = [
  { key: "api", label: "API-ключи" },
  { key: "logs", label: "Логи" },
  { key: "params", label: "Параметры" },
  { key: "accounts", label: "Счета" },
];

export function SettingsView() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("params");
  const [settings, setSettings] = useState<AppSettings>(defaultAppSettings);
  const [minStock, setMinStock] = useState<MinStockRow[]>(mockMinStockRows);
  const [accounts, setAccounts] = useState<FinanceAccount[]>(financeAccounts);

  const accountCreateRef = useRef<(() => void) | null>(null);

  const registerAccountCreate = useCallback((fn: () => void) => {
    accountCreateRef.current = fn;
  }, []);

  const handleAdd = () => {
    if (activeTab === "accounts") {
      accountCreateRef.current?.();
      return;
    }
    toast.message("Добавление недоступно на этом табе");
  };

  return (
    <>
      <PageHeader
        title="Настройки"
        addLabel={activeTab === "accounts" ? "Добавить счёт" : undefined}
        onAdd={activeTab === "accounts" ? handleAdd : undefined}
      />

      <div className="space-y-4">
        <SegmentTabs
          ariaLabel="Настройки"
          tabs={TABS}
          value={activeTab}
          onChange={setActiveTab}
        />

        {activeTab === "api" && <SettingsApiTab />}
        {activeTab === "logs" && <SettingsLogsTab />}
        {activeTab === "params" && (
          <SettingsParamsTab
            settings={settings}
            onSettingsChange={setSettings}
            minStock={minStock}
            onMinStockChange={setMinStock}
          />
        )}
        {activeTab === "accounts" && (
          <SettingsAccountsTab
            accounts={accounts}
            onAccountsChange={setAccounts}
            onRegisterCreate={registerAccountCreate}
          />
        )}
      </div>
    </>
  );
}
