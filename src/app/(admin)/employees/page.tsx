import { EmployeesView } from "@/components/employees/employees-view";
import { getEmployees } from "@/server/employees";

// Данные из БД — рендер на запрос (не прероним на билде без БД).
export const dynamic = "force-dynamic";

export default async function EmployeesPage() {
  const employees = await getEmployees();
  return <EmployeesView initialEmployees={employees} />;
}
