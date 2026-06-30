import { GoalsView } from "@/components/goals/goals-view";
import { getGoalsData } from "@/server/goals";

export const dynamic = "force-dynamic";

export default async function GoalsPage() {
  const { goals, products } = await getGoalsData();
  return <GoalsView initialGoals={goals} products={products} />;
}
