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
    <div className="bg-background flex min-h-screen flex-col">
      <header className="surface-card mx-4 mt-4 flex h-16 items-center justify-between px-6 md:mx-6">
        <div className="flex items-center gap-3">
          <div className="bg-brand flex size-10 items-center justify-center rounded-2xl text-sm font-bold text-white shadow-soft">
            S
          </div>
          <div className="text-lg font-semibold tracking-tight">Терминал производства</div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-sm font-medium">Вход не выполнен</span>
          <Button className="rounded-xl [&_svg]:stroke-[1.75]">
            <LogIn />
            Войти
          </Button>
          <Button
            variant="ghost"
            className="rounded-xl [&_svg]:stroke-[1.75]"
            nativeButton={false}
            render={<Link href="/dashboard" />}
          >
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
              className="surface-card ring-0 transition-all hover:-translate-y-0.5 hover:shadow-soft-lg"
            >
              <CardContent className="flex cursor-pointer flex-col items-center gap-4 py-12">
                <span className="flex size-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground [&_svg]:size-8 [&_svg]:stroke-[1.75]">
                  <Icon />
                </span>
                <span className="text-xl font-semibold tracking-tight">{t.title}</span>
              </CardContent>
            </Card>
          );
        })}
      </main>
    </div>
  );
}
