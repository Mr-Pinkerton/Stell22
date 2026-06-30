import { DashboardView } from "@/components/dashboard/dashboard-view";
import { getDashboardData } from "@/server/dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const source = await getDashboardData();
  return <DashboardView source={source} />;
}
