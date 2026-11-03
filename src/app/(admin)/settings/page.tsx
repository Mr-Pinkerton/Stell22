import { SettingsView } from "@/components/settings/settings-view";
import { getSettingsLogs } from "@/server/audit";
import { getAppSettings, getMinStockRows } from "@/server/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [logs, appSettings, minStock] = await Promise.all([
    getSettingsLogs(),
    getAppSettings(),
    getMinStockRows(),
  ]);
  return <SettingsView logs={logs} appSettings={appSettings} minStock={minStock} />;
}
