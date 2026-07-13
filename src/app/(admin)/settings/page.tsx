import { SettingsView } from "@/components/settings/settings-view";
import { getSettingsLogs } from "@/server/audit";
import { getApiCredentials, getAppSettings, getMinStockRows } from "@/server/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [logs, apiCredentials, appSettings, minStock] = await Promise.all([
    getSettingsLogs(),
    getApiCredentials(),
    getAppSettings(),
    getMinStockRows(),
  ]);
  return (
    <SettingsView
      logs={logs}
      apiCredentials={apiCredentials}
      appSettings={appSettings}
      minStock={minStock}
    />
  );
}
