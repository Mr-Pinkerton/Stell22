import { KpiTile } from "@/components/kpi-tile";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function DashboardPage() {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Дашборд</h1>
        <Tabs defaultValue="month">
          <TabsList>
            <TabsTrigger value="month">Текущий месяц</TabsTrigger>
            <TabsTrigger value="week">Текущая неделя</TabsTrigger>
            <TabsTrigger value="custom">Произвольный период</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile title="Производство" value="0 шт" hint="за период" />
        <KpiTile title="Поступления" value="0,00 ₽" hint="за период" />
        <KpiTile title="Затраты" value="0,00 ₽" hint="за период" />
        <KpiTile title="Остаток на счетах" value="0,00 ₽" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Требует внимания</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">Все в норме</CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Производство vs план</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground flex h-56 items-center justify-center text-sm">
            График — Этап 12
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Выручка vs прошлый месяц</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground flex h-56 items-center justify-center text-sm">
            График — Этап 12
          </CardContent>
        </Card>
      </div>
    </>
  );
}
