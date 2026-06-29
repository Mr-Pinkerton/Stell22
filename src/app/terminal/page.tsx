import { TerminalApp } from "@/components/terminal/terminal-app";
import { getTerminalData } from "@/server/terminal";

// Данные из БД — рендер на запрос.
export const dynamic = "force-dynamic";

export default async function TerminalPage() {
  const data = await getTerminalData();
  return <TerminalApp initialData={data} />;
}
