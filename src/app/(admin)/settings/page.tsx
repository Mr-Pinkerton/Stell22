import { SettingsView } from "@/components/settings/settings-view";
import { getChangeLogs } from "@/server/audit";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const logs = await getChangeLogs();
  return <SettingsView logs={logs} />;
}
