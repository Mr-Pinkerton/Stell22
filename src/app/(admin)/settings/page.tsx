import { SettingsView } from "@/components/settings/settings-view";
import { getSettingsLogs } from "@/server/audit";
import { getApiCredentials } from "@/server/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [logs, apiCredentials] = await Promise.all([getSettingsLogs(), getApiCredentials()]);
  return <SettingsView logs={logs} apiCredentials={apiCredentials} />;
}
