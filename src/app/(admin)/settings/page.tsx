import { SettingsView } from "@/components/settings/settings-view";
import { getSettingsLogs } from "@/server/audit";
import { getApiCredentials } from "@/server/settings";
import { getAccounts } from "@/server/finance";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [logs, apiCredentials, accounts] = await Promise.all([
    getSettingsLogs(),
    getApiCredentials(),
    getAccounts(),
  ]);
  return <SettingsView logs={logs} apiCredentials={apiCredentials} accounts={accounts} />;
}
