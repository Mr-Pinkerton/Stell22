import Link from "next/link";
import { Scissors, Drill, Package, Clock, LogIn, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const tiles = [
  { title: "Торцовка", icon: Scissors },
  { title: "Присадка", icon: Drill },
  { title: "Упаковка", icon: Package },
  { title: "Рабочие часы", icon: Clock },
];

export default function TerminalPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-16 items-center justify-between border-b px-6">
        <div className="text-lg font-semibold">Терминал производства</div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm">Вход не выполнен</span>
          <Button>
            <LogIn />
            Войти
          </Button>
          <Button variant="ghost" nativeButton={false} render={<Link href="/dashboard" />}>
            <ArrowLeft />В админку
          </Button>
        </div>
      </header>

      <main className="grid flex-1 grid-cols-2 gap-6 p-6 lg:grid-cols-4">
        {tiles.map((t) => {
          const Icon = t.icon;
          return (
            <Card
              key={t.title}
              className="hover:bg-accent flex cursor-pointer items-center justify-center transition-colors"
            >
              <CardContent className="flex flex-col items-center gap-4 py-12">
                <Icon className="size-12" />
                <span className="text-xl font-medium">{t.title}</span>
              </CardContent>
            </Card>
          );
        })}
      </main>
    </div>
  );
}
